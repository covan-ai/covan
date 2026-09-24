import type { SupabaseClient } from "@supabase/supabase-js";
import { composioConfigured, deleteConnectedAccount, type ComposioEnv } from "./client";

/**
 * Giving a grant back, on every road a connection can leave by.
 *
 * This file exists because of an asymmetry that is easy to miss. When Covan
 * holds the credential, deleting the row deletes the credential — 0061 solved
 * the equivalent with `on delete cascade` and the problem stayed solved. When
 * Composio holds it, deleting the row deletes nothing: the OAuth grant stays
 * live at the provider, attached to an account id no screen in this product can
 * show any more. That is not untidiness, it is a mailbox somebody can no longer
 * see is being read, and it is a GDPR-shaped hole rather than a cosmetic one.
 *
 * A row can leave by three roads and only one of them runs code by default:
 *
 *   1. Somebody presses Remove — `DELETE /tool-connections/:id`, which calls
 *      this first.
 *   2. The workspace is deleted — `tool_connections.workspace_id` cascades
 *      (0059) and a cascade runs no code, so `routes/account.ts` calls this
 *      before it deletes the workspaces.
 *   3. The thirty-day sweeper — `lib/purge.ts` deletes agents, bundles and
 *      documents, none of which a `tool_connections` row hangs off. So there is
 *      nothing to do there, and that is a fact about today's schema rather than
 *      a guarantee: a future migration that makes a connection cascade off
 *      something the sweeper deletes has to come back here.
 *
 * **Best-effort, and the row goes either way.** If Composio refuses the
 * revocation, deleting locally anyway is the better failure: a row a person
 * cannot remove is worse than a grant that has to be revoked from Composio's
 * own dashboard, and the alternative is an integrations page with a card that
 * will not go away. Logged loudly for exactly that reason.
 */

/** The Composio accounts these workspaces' connections point at. */
export async function connectedAccountsIn(
  admin: SupabaseClient,
  workspaceIds: string[],
): Promise<string[]> {
  if (workspaceIds.length === 0) return [];
  // The service role, because `connected_account_id` is granted to no client
  // role (0063) — and the caller of this has already decided the workspace is
  // theirs to delete.
  const { data, error } = await admin
    .from("tool_connections")
    .select("connected_account_id")
    .in("workspace_id", workspaceIds)
    .eq("transport", "composio");
  if (error) {
    console.error("could not list connected accounts to revoke", error);
    return [];
  }
  return (data ?? [])
    .map((row) => (row as { connected_account_id?: unknown }).connected_account_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Hand every one of them back, and never fail the caller for it. */
export async function revokeConnectedAccounts(env: ComposioEnv, ids: string[]): Promise<void> {
  if (ids.length === 0 || !composioConfigured(env)) return;
  for (const id of ids) {
    const result = await deleteConnectedAccount(env, id).catch((err: unknown) => ({
      kind: "error" as const,
      status: 502,
      message: err instanceof Error ? err.message : String(err),
    }));
    if (result.kind === "error") {
      // The one failure in this file nothing downstream can repair: the row is
      // about to go, and with it the only record of which grant this was.
      console.error(
        `could not revoke Composio connected account ${id} — it is still live and must be ` +
          `removed from Composio's dashboard by hand: ${result.message}`,
      );
    }
  }
}
