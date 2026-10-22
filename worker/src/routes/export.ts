import { Hono } from "hono";
import type { AppEnv } from "../types";
import { getDocStore } from "../lib/docstore";
import { collectWorkspace, ExportFailure } from "../lib/export/collect";
import { archiveEntries } from "../lib/export/archive";
import { writeZip } from "../lib/export/zip";
import { exportObjectKey } from "../lib/export/job";
import { toEpochMs } from "../lib/dto";

/**
 * Taking a workspace with you.
 *
 * The README says a self-hosted Covan is the whole product and that nothing is
 * held hostage. That has always been true of the code and of the database;
 * until now it was not true of the interface, and "you could always run
 * `pg_dump`" is an answer for the operator, not for the team using their
 * install. This is the button that makes the claim checkable by the person the
 * claim is aimed at.
 *
 * Everything is read through the caller's own client, so the archive holds what
 * that person could see. That is stated in the manifest rather than left to be
 * inferred: an export is not "the workspace", it is one member's view of it,
 * and an admin's file and a member's file are different files.
 */
const exportRoutes = new Hono<AppEnv>();

// GET /workspaces/:id/export — one archive, streamed.
exportRoutes.get("/workspaces/:id/export", async (c) => {
  // No API-key refusal here, unlike creating a key or closing an account. Those
  // are refused because a key must not be able to escalate or to destroy the
  // evidence of its own misuse. This is a read, and a key that can reach
  // /agents and /messages can already assemble the same file with a loop. What
  // the endpoint adds is convenience, not reach, and refusing it would be a
  // gate with a door beside it.
  const db = c.get("db");
  const user = c.get("user");
  const workspaceId = c.req.param("id");

  // Membership decides both whether this is allowed and what the manifest says
  // the caller's view was. RLS would return empty rows for a stranger anyway;
  // asking here means the answer is a 404 rather than an archive of nothing.
  const { data: membership, error: membershipError } = await db
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (membershipError) return c.json({ error: "failed to check the workspace" }, 500);
  if (!membership) return c.json({ error: "not found" }, 404);

  const { data: workspace, error: workspaceError } = await db
    .from("workspaces")
    .select("id,name,slug")
    .eq("id", workspaceId)
    .maybeSingle();

  if (workspaceError) return c.json({ error: "failed to load the workspace" }, 500);
  if (!workspace) return c.json({ error: "not found" }, 404);

  // Collected before the response starts, on purpose. Every one of these reads
  // can fail, and a failure here is still a status code — once the first byte
  // of a zip is on the wire the only way to report a problem is to truncate the
  // download, which looks exactly like a network drop.
  let tables;
  try {
    tables = await collectWorkspace(db, workspaceId);
  } catch (e) {
    if (e instanceof ExportFailure) {
      console.error("export: collection failed", e.table, e.reason);
      return c.json({ error: `failed to read ${e.table}` }, 500);
    }
    console.error("export: collection failed", e);
    return c.json({ error: "failed to build the export" }, 500);
  }

  // The documents are what streams: they are fetched one at a time inside the
  // generator, so a workspace of two hundred files is never in memory at once.
  const body = writeZip(
    archiveEntries({
      workspace: { id: String(workspace.id), name: String(workspace.name) },
      exportedBy: { userId: user.id, role: String(membership.role) },
      exportedAt: new Date().toISOString(),
      tables,
      store: getDocStore(c.env),
    }),
  );

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `covan-${String(workspace.slug || workspace.id)}-${stamp}.zip`;

  return new Response(body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      // No length is known until the last document has been read, and guessing
      // one would be worse than omitting it: a wrong Content-Length is a
      // download that a browser reports as corrupt.
      "Cache-Control": "no-store",
    },
  });
});

// ---- exports prepared in the background (0132) ---------------------------

export type WorkspaceExportDTO = {
  id: string;
  status: "queued" | "running" | "ready" | "failed" | "expired";
  sizeBytes: number | null;
  error: string | null;
  requestedBy: { id: string; name: string | null } | null;
  /** Whether the caller asked for it — and so whether they may download it. */
  mine: boolean;
  createdAt: number;
  finishedAt: number | null;
  expiresAt: number | null;
};

const EXPORT_COLUMNS =
  "id, workspace_id, requested_by, status, size_bytes, error, created_at, finished_at, expires_at";

function mapExport(
  row: Record<string, unknown>,
  callerId: string,
  names: Map<string, string | null>,
  now: number,
): WorkspaceExportDTO {
  const raw = String(row.status);
  const expiresAt = row.expires_at ? toEpochMs(row.expires_at as string) : null;
  // Past its week but not yet collected by the purge reads as what it is.
  const status =
    raw === "ready" && expiresAt !== null && expiresAt <= now
      ? "expired"
      : (raw as WorkspaceExportDTO["status"]);
  const requester = (row.requested_by as string | null) ?? null;
  return {
    id: row.id as string,
    status,
    sizeBytes: row.size_bytes == null ? null : Number(row.size_bytes),
    error: (row.error as string | null) ?? null,
    requestedBy: requester ? { id: requester, name: names.get(requester) ?? null } : null,
    mine: requester === callerId,
    createdAt: toEpochMs(row.created_at as string),
    finishedAt: row.finished_at ? toEpochMs(row.finished_at as string) : null,
    expiresAt,
  };
}

// GET /workspaces/:id/exports — "Previous exports", for its admins.
exportRoutes.get("/workspaces/:id/exports", async (c) => {
  const db = c.get("db");
  const { data, error } = await db
    .from("workspace_exports")
    .select(EXPORT_COLUMNS)
    .eq("workspace_id", c.req.param("id"))
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) return c.json({ error: "failed to load exports" }, 500);
  const rows = data ?? [];
  const people = [...new Set(rows.map((r) => r.requested_by).filter(Boolean) as string[])];
  const { data: profiles } = people.length
    ? await db.from("profiles").select("id, name").in("id", people)
    : { data: [] };
  const names = new Map(
    ((profiles ?? []) as Array<{ id: string; name: string | null }>).map(
      (p) => [p.id, p.name?.trim() || null] as const,
    ),
  );
  const now = Date.now();
  return c.json(rows.map((r) => mapExport(r, c.get("user").id, names, now)));
});

// POST /workspaces/:id/exports — ask for one; an admin's, one at a time.
exportRoutes.post("/workspaces/:id/exports", async (c) => {
  const db = c.get("db");
  const workspaceId = c.req.param("id");
  const userId = c.get("user").id;
  const { data, error } = await db
    .from("workspace_exports")
    .insert({ workspace_id: workspaceId, requested_by: userId })
    .select(EXPORT_COLUMNS)
    .single();
  if (error) {
    if (error.code === "23505") {
      return c.json({ error: "an export of this workspace is already being prepared" }, 409);
    }
    if (error.code === "42501") return c.json({ error: "only admins can export a workspace" }, 403);
    return c.json({ error: "failed to ask for an export" }, 500);
  }
  return c.json(mapExport(data, userId, new Map(), Date.now()), 201);
});

// GET /exports/:id/download — the file, for the person who asked for it.
exportRoutes.get("/exports/:id/download", async (c) => {
  const { data: row, error } = await c
    .get("db")
    .from("workspace_exports")
    .select("id, workspace_id, requested_by, status, expires_at, created_at")
    .eq("id", c.req.param("id"))
    .maybeSingle();
  if (error) return c.json({ error: "failed to load the export" }, 500);
  if (!row) return c.json({ error: "not found" }, 404);
  // Every admin sees that it was made. Only its requester gets the file: it
  // was read as them, and holds their private threads (0132).
  if (row.requested_by !== c.get("user").id) {
    return c.json({ error: "only whoever asked for an export can download it" }, 403);
  }
  if (row.status !== "ready" || !row.expires_at || Date.parse(row.expires_at) <= Date.now()) {
    return c.json({ error: "this export is not ready, or has expired" }, 410);
  }

  const object = await getDocStore(c.env).get(exportObjectKey(row.workspace_id, row.id));
  if (!object) return c.json({ error: "this export is not ready, or has expired" }, 410);
  const filename = `covan-export-${String(row.created_at).slice(0, 10)}.zip`;
  return new Response(object.body, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Cache-Control": "no-store",
    },
  });
});

export { exportRoutes };
