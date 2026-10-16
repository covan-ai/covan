/**
 * The OAuth grant behind a routine's Notion or Google Drive event: the
 * `connections` row the route recorded as `config.connectionId`, read again
 * and opened.
 *
 * WHY HERE, AND WHY THE SERVICE ROLE. `connections.secret_ciphertext` is
 * granted to no client role (0043), and an adapter runs with no caller at
 * all — a delivery from Notion, a sweep from the cron. The route that recorded
 * the choice found the connection through the caller's own client
 * (`requirements.ts`), so the id is one the routine's owner could see; this
 * re-reads that one row and checks it is still what was chosen — the
 * routine's workspace, the provider the event needs, active, and held by
 * somebody — before its token is used for anything.
 *
 * It reads that row and writes nothing. A Google access token refreshed here
 * is not stored back: the connection's own sync stores the ones it refreshes,
 * and a refresh token Google keeps issuing access tokens against is all an
 * event needs. That keeps every write to `connections` in the sync.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../../types";
import { serviceClient } from "../../supabase";
import { decryptSecret } from "../../secret-box";
import type { TokenEnvelope } from "../../connections/types";
import type { AdapterContext } from "./adapter";
import { EventSourceError } from "./errors";

export type Grant = {
  connectionId: string;
  token: TokenEnvelope;
  config: Record<string, unknown>;
};

export type GrantDeps = { db?: (env: RoutineEnv) => SupabaseClient };

/**
 * The grant, or an `expired` refusal with a sentence: a connection removed,
 * paused, moved or left holderless is one no retry brings back — somebody
 * reconnects it and chooses the event again.
 */
export async function grantFor(
  ctx: AdapterContext,
  provider: "notion" | "google_drive",
  deps: GrantDeps = {},
): Promise<Grant> {
  const gone = new EventSourceError(
    `${ctx.eventType.app} is no longer connected. Connect it again, then choose this event again.`,
    { expired: true },
  );
  const connectionId = ctx.subscription.config?.connectionId;
  if (typeof connectionId !== "string" || !connectionId) throw gone;

  const { data, error } = await (deps.db ?? serviceClient)(ctx.env)
    .from("connections")
    .select("id, workspace_id, user_id, provider, status, config, secret_ciphertext")
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw new Error(`could not read the connection: ${error.message}`);
  const row = data as {
    workspace_id: string;
    user_id: string | null;
    provider: string;
    status: string;
    config: Record<string, unknown> | null;
    secret_ciphertext: string | null;
  } | null;
  if (
    !row ||
    row.workspace_id !== ctx.routine.workspace_id ||
    row.provider !== provider ||
    row.status !== "active" ||
    !row.user_id ||
    !row.secret_ciphertext
  ) {
    throw gone;
  }

  let token: TokenEnvelope;
  try {
    token = JSON.parse(
      await decryptSecret(row.secret_ciphertext, ctx.env.ROUTINE_SECRET_KEY),
    ) as TokenEnvelope;
  } catch {
    throw gone;
  }
  if (!token?.accessToken) throw gone;
  return { connectionId, token, config: row.config ?? {} };
}
