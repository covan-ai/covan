import { serviceClient } from "../supabase";
import { decryptSecret } from "../secret-box";
import type { ToolConnection } from "./connections";
import type { ToolEnv } from "./registry";

/**
 * The one place in the harness that reaches past Row Level Security, and the
 * one reason it has to.
 *
 * Three secrets live in columns no client role may select — a tool
 * connection's credential (0059), a delivery channel's destination (0012) —
 * because the worker encrypts them and a client that could read one back
 * could read everyone's. So the permission question cannot be answered by the
 * same read that fetches the secret.
 *
 * **Every function here takes a row somebody has already been found to be
 * allowed to have.** That is the whole discipline, and it is `withSecret` in
 * `routes/connections.ts` under a different name: the caller asks the database
 * first, through their own client, and only then calls something in this file
 * to fill in the column the database withheld. Nothing here decides anything.
 * Keeping it in one file is what makes that claim checkable — there is one
 * entry in `service-client.static.test.ts` for the harness, not one per tool.
 */

/**
 * The credential for a connection the caller has already been found to be
 * allowed to have.
 *
 * Takes the loaded row rather than an id, so it is not possible to call this
 * without having gone through `loadConnection` first — the type is the
 * reminder.
 */
export async function connectionSecret(env: ToolEnv, connection: ToolConnection): Promise<string> {
  const { data, error } = await serviceClient(env)
    .from("tool_connections")
    .select("secret_ciphertext")
    .eq("id", connection.id)
    .maybeSingle();
  if (error || !data) throw new Error("this connection has no stored credential");
  return decryptSecret(String(data.secret_ciphertext), env.ROUTINE_SECRET_KEY);
}

/**
 * The headers a `static_header` connection presents, ready to spread into a
 * request.
 *
 * The decrypted secret is a JSON envelope — `{"headers": {...}}` — rather than
 * a bare token, and the shape is borrowed from `delivery_channels`, where a
 * webhook's secret has held a parsed JSON config since 0012. One header would
 * have been simpler and is not enough: Supabase behind Kong wants `apikey` and
 * `Authorization` and will not answer with only one of them, so a one-header
 * design would have needed a Supabase-shaped exception in its first week.
 *
 * Values are verbatim. A token that needs the word "Bearer" in front of it is
 * stored with the word in front of it, because guessing which APIs want the
 * prefix is a list that is wrong for somebody.
 */
export async function authHeaders(
  env: ToolEnv,
  connection: ToolConnection,
): Promise<Record<string, string>> {
  const raw = await connectionSecret(env, connection);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("this connection's stored credential is unreadable");
  }
  const headers = (parsed as { headers?: unknown } | null)?.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    throw new Error("this connection's stored credential names no headers");
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value === "string" && name.trim()) out[name.trim()] = value;
  }
  return out;
}

/**
 * Write back what `describe_connection` found, so the next turn does not go
 * and find it again.
 *
 * Service role, and this is the second of the two reasons this file is on
 * `service-client.static.test.ts`'s allowlist. The caller may be an ordinary
 * member, and 0059 grants `update (config)` to `authenticated` under a policy
 * that only admits the connection's creator or a workspace admin — which is
 * the right rule for somebody EDITING a connection and the wrong one for a
 * cache write nobody chose to make. Best-effort by design: a failed cache
 * write costs one extra round trip next turn and must not fail the tool.
 */
export async function cacheConnectionSummary(
  env: ToolEnv,
  connection: ToolConnection,
  summary: string,
): Promise<void> {
  const { error } = await serviceClient(env)
    .from("tool_connections")
    .update({
      config: { ...connection.config, summary, summary_cached_at: new Date().toISOString() },
    })
    .eq("id", connection.id);
  if (error) console.error("could not cache connection summary", error);
}

/**
 * A delivery channel's encrypted destination, for a channel the caller has
 * already been shown to own.
 *
 * Takes the id rather than a row type, because `delivery_channels` has no
 * shared row type in this codebase and inventing one here would be a type
 * nobody else uses. The contract is in the argument name: `owned` is a row the
 * caller selected through their own client, which
 * `delivery_channels_select_own` scopes to them.
 */
export async function deliveryChannelSecret(
  env: ToolEnv,
  owned: { id: string },
): Promise<{ kind: string; secret_ciphertext: string } | null> {
  const { data, error } = await serviceClient(env)
    .from("delivery_channels")
    .select("kind, secret_ciphertext")
    .eq("id", owned.id)
    .maybeSingle();
  if (error || !data) return null;
  return { kind: String(data.kind), secret_ciphertext: String(data.secret_ciphertext) };
}
