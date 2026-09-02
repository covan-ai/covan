import type { SupabaseClient } from "@supabase/supabase-js";

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
} as const;

export type Restorable = keyof typeof RESTORABLE;

export function isRestorable(kind: string): kind is Restorable {
  return Object.prototype.hasOwnProperty.call(RESTORABLE, kind);
}

/** How long a deleted thing waits before the sweeper takes it for real. */
export const RETENTION_DAYS = 30;
