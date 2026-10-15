import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import { serviceClient } from "../lib/supabase";
import { guardCredits } from "../lib/entitlements/guard";
import { JOB_COLUMNS, mapDocumentJob, type DocumentJobDto } from "../lib/docs/dto";
import { ACTIVE_STATUSES, advanceDocumentJob } from "../lib/docs/engine";
import { documentHost, kickDocumentJob } from "../lib/docs/host";

/**
 * Following a document while it is written, and the two things a person can
 * do to one: stop it, and try again.
 *
 * Every read goes through the caller's own client, so 0102's policy decides
 * what exists — a job is its requester's, in a workspace they still belong
 * to. Stop and retry then write with the service role, because no client role
 * may write a job (0102), keyed to the row id that read returned.
 *
 * **The poll is also a clock.** On a deployment with no document host — no
 * `DOC_ROOMS` on Cloudflare — the open tab advances its own job one unit per
 * poll, awaited inside the request so the request is what keeps the unit
 * alive. With a host, a job that has not moved for a while is kicked again,
 * which costs nothing when the host is fine and restarts one that lost its
 * alarm.
 */

const documentJobs = new Hono<AppEnv>();

/** How long a job with a host may sit unchanged before the poll kicks it. */
const STALL_MS = 90_000;

type Row = Record<string, unknown>;
type SectionRow = { job_id: string; idx: number; heading: string; body: string; status: string };

async function withSections(c: Context<AppEnv>, rows: Row[]): Promise<DocumentJobDto[] | null> {
  if (rows.length === 0) return [];
  const { data, error } = await c
    .get("db")
    .from("document_sections")
    .select("job_id, idx, heading, body, status")
    .in(
      "job_id",
      rows.map((r) => r.id as string),
    );
  if (error) return null;
  const sections = (data ?? []) as SectionRow[];
  return rows.map((row) =>
    mapDocumentJob(
      row,
      sections.filter((s) => s.job_id === row.id),
    ),
  );
}

function isActive(status: unknown): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(String(status));
}

/** Moves whatever is moving, the way this deployment moves it. */
async function drive(c: Context<AppEnv>, rows: Row[]): Promise<void> {
  const active = rows.filter((r) => isActive(r.status));
  if (active.length === 0) return;

  if (documentHost(c.env)) {
    const now = Date.now();
    for (const row of active) {
      if (now - Date.parse(String(row.updated_at)) > STALL_MS) {
        await kickDocumentJob(c.env, row.id as string);
      }
    }
    return;
  }

  // No host: this request is the clock. One unit, for the oldest job, so a
  // poll never holds the tab for more than one model call.
  const oldest = active[active.length - 1];
  try {
    await advanceDocumentJob(serviceClient(c.env), c.env, oldest.id as string);
  } catch (err) {
    console.error(`document job ${String(oldest.id)}: poll could not advance it`, err);
  }
}

async function readJobs(c: Context<AppEnv>, sessionId: string) {
  return c
    .get("db")
    .from("document_jobs")
    .select(JOB_COLUMNS)
    .eq("session_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(20);
}

// GET /sessions/:id/document-jobs — this caller's documents in a conversation.
documentJobs.get("/sessions/:id/document-jobs", async (c) => {
  const db = c.get("db");
  const id = c.req.param("id");

  const { data: session, error: sessionError } = await db
    .from("chat_sessions")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (sessionError) return c.json({ error: "failed to load that conversation" }, 500);
  if (!session) return c.json({ error: "no such conversation" }, 404);

  const first = await readJobs(c, id);
  if (first.error) return c.json({ error: "failed to load documents" }, 500);
  const before = (first.data ?? []) as unknown as Row[];

  await drive(c, before);

  // Read again only if something could have moved, so a quiet conversation
  // costs one read.
  const after = before.some((r) => isActive(r.status)) ? await readJobs(c, id) : first;
  if (after.error) return c.json({ error: "failed to load documents" }, 500);

  const jobs = await withSections(c, (after.data ?? []) as unknown as Row[]);
  if (!jobs) return c.json({ error: "failed to load documents" }, 500);
  return c.json(jobs);
});

async function readJob(c: Context<AppEnv>): Promise<Row | null | "error"> {
  const { data, error } = await c
    .get("db")
    .from("document_jobs")
    .select(JOB_COLUMNS)
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (error) return "error";
  return (data as unknown as Row | null) ?? null;
}

// GET /document-jobs/:id
documentJobs.get("/document-jobs/:id", async (c) => {
  const row = await readJob(c);
  if (row === "error") return c.json({ error: "failed to load document" }, 500);
  if (!row) return c.json({ error: "not found" }, 404);
  const [job] = (await withSections(c, [row])) ?? [];
  if (!job) return c.json({ error: "failed to load document" }, 500);
  return c.json(job);
});

// POST /document-jobs/:id/stop — keep what is written, write no more.
documentJobs.post("/document-jobs/:id/stop", async (c) => {
  const row = await readJob(c);
  if (row === "error") return c.json({ error: "failed to load document" }, 500);
  if (!row) return c.json({ error: "not found" }, 404);
  if (!isActive(row.status)) return c.json({ error: "this document is not being written" }, 409);

  const now = new Date().toISOString();
  const { error } = await serviceClient(c.env)
    .from("document_jobs")
    .update({ status: "stopped", lease_until: null, updated_at: now, finished_at: now })
    .eq("id", row.id as string)
    .in("status", ACTIVE_STATUSES as unknown as string[]);
  if (error) return c.json({ error: "failed to stop the document" }, 500);
  return c.json({ ok: true });
});

// POST /document-jobs/:id/retry — pick a failed or stopped job up where it ended.
documentJobs.post("/document-jobs/:id/retry", async (c) => {
  const row = await readJob(c);
  if (row === "error") return c.json({ error: "failed to load document" }, 500);
  if (!row) return c.json({ error: "not found" }, 404);
  if (row.status !== "failed" && row.status !== "stopped") {
    return c.json({ error: "only a document that failed or was stopped can be retried" }, 409);
  }

  const denied = await guardCredits(c, row.workspace_id as string);
  if (denied) return denied;

  // Where it ended decides where it starts: no outline yet is the outline;
  // every section written is filing; otherwise the next section. The sections
  // already written are kept and not paid for twice.
  const outline = Array.isArray(row.outline) ? row.outline : null;
  const cursor = Number(row.cursor) || 0;
  const status = !outline ? "queued" : cursor >= outline.length ? "filing" : "writing";

  const now = new Date().toISOString();
  const { error } = await serviceClient(c.env)
    .from("document_jobs")
    .update({
      status,
      attempts: 0,
      error: null,
      finished_at: null,
      lease_until: null,
      next_run_at: now,
      updated_at: now,
    })
    .eq("id", row.id as string)
    .in("status", ["failed", "stopped"]);
  if (error) return c.json({ error: "failed to retry the document" }, 500);

  await kickDocumentJob(c.env, row.id as string);
  return c.json({ ok: true }, 202);
});

export { documentJobs };
