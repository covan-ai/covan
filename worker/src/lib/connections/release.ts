import type { SupabaseClient } from "@supabase/supabase-js";
import type { Bindings } from "../../types";
import { decryptSecret } from "../secret-box";
import { providerFor } from "./registry";
import type { TokenEnvelope } from "./types";

/**
 * What closing an account does to the sources that person connected.
 *
 * A connection belongs to its workspace and outlives the person who connected
 * it (0057): `user_id` goes null when they close their account, and the
 * engine pauses it until somebody reconnects. What it did not do was let go
 * of the grant. The stored token stayed in the row, still valid at the
 * provider, for an account that had asked to be erased — and until the
 * folder browser learned to check for a holder, still usable.
 *
 * So, before the account goes:
 *
 * - every grant they hold is revoked at the provider, where the provider has
 *   a way (Google does; Notion's are removed from Notion's own settings);
 * - in the workspaces that are staying, the row keeps its documents and its
 *   place, loses the token, and is paused for a member to reconnect.
 *   Workspaces closing with the account take their rows with them.
 *
 * Best-effort throughout, the judgement the Composio revocation beside it
 * makes: a provider's 500 is logged, and the account still closes.
 */
export async function releaseHeldConnections(
  env: Bindings,
  admin: SupabaseClient,
  userId: string,
  closingWorkspaces: readonly string[],
): Promise<void> {
  const { data: held, error } = await admin
    .from("connections")
    .select("id, workspace_id, provider, secret_ciphertext")
    .eq("user_id", userId);
  if (error) {
    console.error("account deletion: could not list connections to release", error);
    return;
  }

  for (const row of held ?? []) {
    const provider = providerFor(row.provider as string);
    try {
      if (provider?.revoke && row.secret_ciphertext) {
        const token = JSON.parse(
          await decryptSecret(row.secret_ciphertext as string, env.ROUTINE_SECRET_KEY),
        ) as TokenEnvelope;
        await provider.revoke(env, token, fetch.bind(globalThis));
      }
    } catch (e) {
      console.error("account deletion: could not revoke a connection's grant", row.id, e);
    }

    if (closingWorkspaces.includes(row.workspace_id as string)) continue;

    const { error: clearError } = await admin
      .from("connections")
      .update({
        secret_ciphertext: "",
        status: "paused",
        paused_code: "owner_gone",
        paused_reason:
          "the person whose account this source was connected with has closed their Covan account. " +
          "Reconnect it to start syncing again; the documents it already imported are untouched.",
        updated_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    if (clearError) {
      console.error("account deletion: could not clear a connection's token", row.id, clearError);
    }
  }
}
