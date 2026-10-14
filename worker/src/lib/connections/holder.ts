import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Whether the person whose grant a connection carries is still here to carry it.
 *
 * A connection's token is somebody's: their Drive, their Notion, authorised
 * by them. Since 0057 the row outlives them — `user_id` goes null when they
 * close their account, and stays pointing at them when they leave the
 * workspace — so the token can be sitting in a workspace its owner has no part
 * in any more. Nothing may use it then. The sync engine already refused
 * (pausing with one of the two codes below); `GET /connections/:id/folders`
 * did not, and browsed a departed member's Drive with their token.
 *
 * One function for both, so "who counts as here" cannot be answered two ways.
 * `db` reads `workspace_members`: the service role in the engine, the caller's
 * own client in a route — a member can see their fellow members.
 */
export type Holder =
  { present: true } | { present: false; code: "owner_gone" | "owner_left"; reason: string };

export async function holderPresent(
  db: SupabaseClient,
  connection: { workspace_id: string; user_id: string | null },
): Promise<Holder> {
  if (!connection.user_id) {
    return {
      present: false,
      code: "owner_gone",
      reason:
        "the person whose account this source was connected with has closed their Covan account. " +
        "Reconnect it to start syncing again; the documents it already imported are untouched.",
    };
  }

  const { data, error } = await db
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", connection.workspace_id)
    .eq("user_id", connection.user_id)
    .maybeSingle();
  if (error) throw new Error(`workspace membership lookup failed: ${error.message}`);
  if (!data) {
    return {
      present: false,
      code: "owner_left",
      reason: "the person who connected this source is no longer a member of this workspace",
    };
  }
  return { present: true };
}
