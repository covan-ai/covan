import type { SupabaseClient } from "@supabase/supabase-js";
import { chunked, readAllPages } from "./batch";
import { storedKeysOf } from "./document-text";

/**
 * Calling the soft-delete and restore functions, and turning their refusals
 * back into HTTP.
 *
 * The marking lives in Postgres (0039) because it spans several tables and
 * PostgREST offers no transaction across them — and because
 * `chat_sessions_update_owner` would refuse to mark a colleague's conversations
 * even for somebody who has just deleted the agent underneath them. So these
 * are `security definer` functions that check `can_write_in_workspace` for
 * themselves and raise when it is false.
 *
 * That makes the SQLSTATE the API contract. Three of them:
 *
 *   42501  the caller may not do this          -> 403
 *   P0002  no such row, or already deleted     -> 404
 *   P0001  right row, wrong order              -> 400, with the message
 *
 * P0001 carries a sentence written for a person ("restore the bundle this
 * document belongs to first"), so it is the one case where the database's own
 * message is passed through rather than replaced. The other two get wording
 * from here, because their messages name functions and columns.
 */

type Db = SupabaseClient;

export type DeletionFailure = { status: 400 | 403 | 404 | 500; message: string };

const FALLBACK: Record<string, string> = {
  "42501": "you do not have permission to change things in this workspace",
  P0002: "not found",
};

export async function callDeletionFn(
  db: Db,
  fn: string,
  args: Record<string, string>,
  whenBroken: string,
): Promise<DeletionFailure | null> {
  const { error } = await db.rpc(fn, args);
  if (!error) return null;

  if (error.code === "42501") return { status: 403, message: FALLBACK["42501"] };
  if (error.code === "P0002") return { status: 404, message: FALLBACK.P0002 };
  if (error.code === "P0001") return { status: 400, message: error.message };
  // A restore that cannot happen yet — a thread whose agent is still in the
  // trash (0125). The database's sentence says what to do first.
  if (error.code === "22023") return { status: 400, message: error.message };

  console.error(`${fn} failed`, error);
  return { status: 500, message: whenBroken };
}

/**
 * The three kinds a person can put in the trash and take back out, and the
 * function pair behind each. Keyed by the same word the trash listing returns
 * in its `kind` column, so a restore request is answered by the row it came
 * from rather than by a second mapping that can drift from the first.
 */
export const RESTORABLE = {
  agent: { del: "soft_delete_agent", restore: "restore_agent", arg: "p_agent_id" },
  bundle: { del: "soft_delete_bundle", restore: "restore_bundle", arg: "p_bundle_id" },
  document: {
    del: "soft_delete_document",
    restore: "restore_document",
    arg: "p_document_id",
  },
  // 0125: a thread or a routine deleted on its own, its owner's to restore.
  session: { del: "soft_delete_session", restore: "restore_session", arg: "p_session_id" },
  routine: { del: "soft_delete_routine", restore: "restore_routine", arg: "p_routine_id" },
} as const;

export type Restorable = keyof typeof RESTORABLE;

export function isRestorable(kind: string): kind is Restorable {
  return Object.prototype.hasOwnProperty.call(RESTORABLE, kind);
}

/** How long a deleted thing waits before the sweeper takes it for real. */
export const RETENTION_DAYS = 30;

/**
 * Every stored object about to lose the row that names it: the documents of
 * these workspaces, for closing an account (`routes/account.ts`) and for a
 * workspace whose notice ran out (`lib/purge.ts`).
 *
 * Best-effort on the read as well as the write: a workspace whose bundles or
 * documents cannot be listed still gets deleted, because refusing to close an
 * account over a storage bookkeeping problem would be the worse failure. What
 * it costs is bytes nobody can reach, and the log line says which.
 */
export async function storedKeysForWorkspaces(
  admin: SupabaseClient,
  workspaceIds: string[],
): Promise<string[]> {
  if (workspaceIds.length === 0) return [];

  const { data: bundles, error: bundlesError } = await admin
    .from("knowledge_bundles")
    .select("id")
    .in("workspace_id", workspaceIds);

  if (bundlesError) {
    console.error("workspace deletion: could not list bundles to clean up", bundlesError);
    return [];
  }

  const bundleIds = (bundles ?? []).map((b) => b.id as string);
  if (bundleIds.length === 0) return [];

  // In hundreds and page by page (`lib/batch.ts`): one list of every bundle
  // was a URL the gateway refused past a couple of hundred, and one read of
  // every document stopped at a thousand without saying so. Either way the
  // files of an account with that much in it outlived the account.
  const keys: string[] = [];
  for (const ids of chunked(bundleIds)) {
    const docs = await readAllPages<{ r2_key: string | null }>((from, to) =>
      admin.from("documents").select("r2_key").in("bundle_id", ids).order("id").range(from, to),
    );
    if (docs === null) {
      console.error("workspace deletion: could not list documents to clean up");
      continue;
    }
    for (const d of docs) if (d.r2_key) keys.push(...storedKeysOf(d.r2_key));
  }
  return keys;
}
