import { Hono } from "hono";
import type { AppEnv } from "../types";
import { callerWorkspaceId } from "../lib/workspace";
import { toEpochMs } from "../lib/dto";
import { callDeletionFn, isRestorable, RESTORABLE, RETENTION_DAYS } from "../lib/deletion";
import { getDocStore } from "../lib/docstore";
import { refuseIfKeyAuthenticated } from "../lib/api-key-rule";
import { storedKeysOf } from "../lib/document-text";

const trash = new Hono<AppEnv>();

type TrashRow = {
  kind: string;
  id: string;
  name: string;
  deleted_at: string;
  deleted_by_id: string | null;
  deleted_by_name: string | null;
  parent_name: string | null;
};

/**
 * GET /trash — what this workspace has deleted and can still get back.
 *
 * Reads through `workspace_trash()` rather than through the tables, because the
 * policies added in 0039 hide deleted rows from everybody. That is the whole
 * point of the arrangement: every other query in the codebase is correct
 * without remembering deletion exists, and this one route asks for the
 * exception in so many words. The function checks `can_write_in_workspace`
 * itself and raises 42501, so a viewer gets a 403 here rather than an empty
 * list — an empty list would tell them there was nothing to restore, which is
 * a different and possibly false statement.
 */
trash.get("/trash", async (c) => {
  const db = c.get("db");

  const workspaceId = await callerWorkspaceId(c);
  if (!workspaceId) return c.json({ items: [], retentionDays: RETENTION_DAYS });

  const { data, error } = await db.rpc("workspace_trash", { p_workspace_id: workspaceId });

  if (error) {
    if (error.code === "42501") {
      return c.json({ error: "only members can see what has been deleted" }, 403);
    }
    console.error("failed to load trash", error);
    return c.json({ error: "failed to load deleted items" }, 500);
  }

  const rows = (data ?? []) as TrashRow[];

  return c.json({
    retentionDays: RETENTION_DAYS,
    items: rows.map((r) => ({
      kind: r.kind,
      id: r.id,
      name: r.name,
      // Epoch milliseconds, as every other timestamp this API returns —
      // `formatRelative` takes a number and an ISO string reaches it as NaN,
      // which renders as a blank rather than as an error.
      deletedAt: toEpochMs(r.deleted_at),
      // Null when the person who deleted it has since been deleted themselves —
      // `deleted_by` nulls rather than cascading, the same way the six
      // attribution columns do. The row still says what went and when.
      deletedBy: r.deleted_by_name,
      // Which bundle a deleted document came out of. Two files called
      // "notes.md" from different bundles are otherwise the same row twice.
      parentName: r.parent_name,
      purgesAt: toEpochMs(r.deleted_at) + RETENTION_DAYS * 86_400_000,
    })),
  });
});

/**
 * POST /trash/:kind/:id/restore
 *
 * `kind` is the same word `workspace_trash` returned in its `kind` column, so a
 * restore is addressed by the row it came from. Anything else is a 404 before
 * a database call is made — the alternative is interpolating a caller-supplied
 * string into a function name.
 */
trash.post("/trash/:kind/:id/restore", async (c) => {
  const kind = c.req.param("kind");
  if (!isRestorable(kind)) return c.json({ error: "not found" }, 404);

  const { restore, arg } = RESTORABLE[kind];

  const failure = await callDeletionFn(
    c.get("db"),
    restore,
    { [arg]: c.req.param("id") },
    `failed to restore ${kind}`,
  );
  if (failure) return c.json({ error: failure.message }, failure.status);

  return c.json({ ok: true });
});

/**
 * DELETE /trash/:kind/:id — gone for good, now, rather than in thirty days.
 *
 * Bundles and documents only: those are what own stored files, and what
 * somebody deletes for good is usually a file they should not have uploaded.
 * `forget_deleted` (0107) checks what a restore would check, deletes the rows
 * and names the stored objects; the store is the worker's to empty. A file
 * that fails to delete is logged — the row that named it is already gone, so
 * the sweeper would never find it either.
 */
trash.delete("/trash/:kind/:id", async (c) => {
  // The thirty days are the undo; this removes it. Not something a leaked key
  // gets to do (`lib/api-key-rule.ts`).
  const refusal = refuseIfKeyAuthenticated(c, "delete things for good");
  if (refusal) return c.json(refusal, 403);
  const kind = c.req.param("kind");
  if (kind !== "bundle" && kind !== "document") return c.json({ error: "not found" }, 404);

  const { data, error } = await c
    .get("db")
    .rpc("forget_deleted", { p_kind: kind, p_id: c.req.param("id") });
  if (error) {
    if (error.code === "P0002") return c.json({ error: "not found" }, 404);
    if (error.code === "42501") return c.json({ error: "you cannot delete things here" }, 403);
    console.error("failed to delete for good", error);
    return c.json({ error: "failed to delete" }, 500);
  }

  const keys = ((data ?? []) as Array<{ r2_key: string | null }>)
    .map((r) => r.r2_key)
    .filter((k): k is string => !!k);
  if (keys.length > 0) {
    const store = getDocStore(c.env);
    for (const key of keys.flatMap(storedKeysOf)) {
      try {
        await store.delete(key);
      } catch (e) {
        console.error("delete for good: stored object left behind", key, e);
      }
    }
  }
  return c.json({ ok: true });
});

export { trash };
