import { Hono } from "hono";
import type { AppEnv } from "../types";
import { getDocStore } from "../lib/docstore";
import { collectWorkspace, ExportFailure } from "../lib/export/collect";
import { archiveEntries } from "../lib/export/archive";
import { writeZip } from "../lib/export/zip";

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

export { exportRoutes };
