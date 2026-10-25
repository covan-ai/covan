import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../types";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";
import { deferred } from "../lib/defer";
import { callerWorkspaceId } from "../lib/workspace";
import { runArrivalScan } from "../lib/arrivals/scan";
import { TAXONOMY_VERSION, isKind } from "../lib/arrivals/taxonomy";
import { WINDOW_DAYS } from "../lib/arrivals/read";

/**
 * What arrived, for the one person it arrived to (0139).
 *
 * Every read and write here goes through the caller's own client: the
 * policies hold a scan to its owner, an admin included, and refuse a key's
 * token outright, so this file only has to ask the right questions. The scan
 * itself runs after the response (`deferred`), as the service role, in
 * `lib/arrivals/scan.ts`.
 *
 * Refused to an API key at the door as well, so a key gets a sentence rather
 * than an empty answer it might take for "nothing arrived".
 */
export const arrivals = new Hono<AppEnv>();

const SCAN_TOOLKITS = ["gmail", "outlook", "googlecalendar"];
const SCAN_COLUMNS =
  "id, workspace_id, user_id, status, taxonomy, sources, window_days, total, unanswered, error, started_at, finished_at, created_at";
const BUCKET_COLUMNS = "kind, label, count, unanswered, examples, template_id, routine_id";

const uuid = z.string().uuid();
const setRoutineSchema = z.object({ routineId: z.string().uuid() });

type Row = Record<string, unknown>;

function mapBucket(row: Row) {
  return {
    kind: row.kind,
    label: row.label ?? "",
    count: row.count,
    unanswered: row.unanswered,
    examples: Array.isArray(row.examples) ? row.examples : [],
    templateId: row.template_id ?? null,
    routineId: row.routine_id ?? null,
  };
}

export function mapScan(row: Row, buckets: Row[]) {
  const sources = Array.isArray(row.sources) ? (row.sources as Row[]) : [];
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    status: row.status,
    taxonomy: row.taxonomy,
    sources: sources.map((s) => ({ connectionId: s.connection_id, toolkit: s.toolkit })),
    windowDays: row.window_days,
    total: row.total ?? null,
    unanswered: row.unanswered ?? null,
    error: row.error ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    createdAt: row.created_at,
    buckets: buckets.map(mapBucket),
  };
}

async function withBuckets(db: AppEnv["Variables"]["db"], scan: Row) {
  if (scan.status !== "done") return mapScan(scan, []);
  const { data } = await db
    .from("arrival_buckets")
    .select(BUCKET_COLUMNS)
    .eq("scan_id", scan.id as string)
    .order("count", { ascending: false });
  return mapScan(scan, (data ?? []) as Row[]);
}

arrivals.post("/arrivals", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "scan a mailbox");
  if (refusal) return c.json(refusal, 403);
  const db = c.get("db");
  const userId = c.get("user").id;
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);

  // One scan per person per workspace at a time.
  const { data: running } = await db
    .from("arrival_scans")
    .select(SCAN_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .in("status", ["queued", "running"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (running) return c.json({ scan: mapScan(running as Row, []) }, 200);

  const { data: connections, error: readError } = await db
    .from("tool_connections")
    .select("id, toolkit_slug")
    .eq("workspace_id", workspaceId)
    .eq("created_by", userId)
    .eq("status", "active")
    .eq("transport", "composio")
    .in("toolkit_slug", SCAN_TOOLKITS);
  if (readError) return c.json({ error: readError.message }, 500);
  const sources = ((connections ?? []) as Row[]).map((row) => ({
    connection_id: row.id,
    toolkit: row.toolkit_slug,
  }));
  if (sources.length === 0) {
    return c.json(
      { error: "no_source", message: "Connect a mailbox or a calendar first, and then it can be read." },
      409,
    );
  }

  const { data: scan, error } = await db
    .from("arrival_scans")
    .insert({
      workspace_id: workspaceId,
      user_id: userId,
      sources,
      taxonomy: TAXONOMY_VERSION,
      window_days: WINDOW_DAYS,
    })
    .select(SCAN_COLUMNS)
    .single();
  if (error || !scan) return c.json({ error: error?.message ?? "could not queue the scan" }, 500);

  deferred(c, runArrivalScan(c.env, (scan as Row).id as string));
  return c.json({ scan: mapScan(scan as Row, []) }, 201);
});

arrivals.get("/arrivals/latest", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "read a scan");
  if (refusal) return c.json(refusal, 403);
  const db = c.get("db");
  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ error: "no workspace" }, 400);

  const { data: scan } = await db
    .from("arrival_scans")
    .select(SCAN_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("user_id", c.get("user").id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!scan) return c.json({ error: "no scan yet" }, 404);
  return c.json({ scan: await withBuckets(db, scan as Row) });
});

arrivals.get("/arrivals/:id", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "read a scan");
  if (refusal) return c.json(refusal, 403);
  const id = c.req.param("id");
  if (!uuid.safeParse(id).success) return c.json({ error: "not found" }, 404);
  const db = c.get("db");
  const { data: scan } = await db
    .from("arrival_scans")
    .select(SCAN_COLUMNS)
    .eq("id", id)
    .eq("user_id", c.get("user").id)
    .maybeSingle();
  if (!scan) return c.json({ error: "not found" }, 404);
  return c.json({ scan: await withBuckets(db, scan as Row) });
});

arrivals.patch("/arrivals/:id/buckets/:kind", async (c) => {
  const refusal = refuseIfKeyAuthenticated(c, "change a scan");
  if (refusal) return c.json(refusal, 403);
  const id = c.req.param("id");
  const kind = c.req.param("kind");
  if (!uuid.safeParse(id).success) return c.json({ error: "not found" }, 404);
  if (!isKind(kind)) return c.json({ error: "no such kind" }, 400);
  const parsed = setRoutineSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);

  // The policy holds the routine to the scan owner's own, in the same
  // workspace; a routine that is not answers 42501 rather than a quiet no.
  const { data, error } = await c
    .get("db")
    .from("arrival_buckets")
    .update({ routine_id: parsed.data.routineId })
    .eq("scan_id", id)
    .eq("kind", kind)
    .select("kind");
  if (error) return c.json({ error: error.message }, error.code === "42501" ? 403 : 500);
  if (!data || (data as Row[]).length === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});
