import { serviceClient } from "../supabase";
import { decryptSecret } from "../secret-box";
import type { ToolConnection } from "./connections";
import type { ToolEnv } from "./registry";

/**
 * The one place in the harness that reaches past Row Level Security, and the
 * one reason it has to.
 *
 * Two secrets live in columns no client role may select — a tool connection's
 * credential (0059) and a delivery channel's destination (0012) — because the
 * worker encrypts them and a client that could read one back could read
 * everyone's. So the permission question cannot be answered by the same read
 * that fetches the secret.
 *
 * There was a third until 2026-09-28: a connected Supabase account's Management
 * token (0061). That feature is gone, and with it the one place in the harness
 * that read a credential belonging to a row other than the one being used.
 *
 * A fourth column joined them in 0063 and it is not a secret, which is worth
 * saying because the exception looks like a weakening and is not.
 * `tool_connections.connected_account_id` is Composio's opaque reference to a
 * grant; the token it stands for never reaches this database. It is withheld
 * from every client role anyway, because one deployment-wide `COMPOSIO_API_KEY`
 * opens every workspace's accounts — so on that arrangement the id IS the
 * boundary, and a member who could read another row's would be able to execute
 * against somebody else's mailbox. Same treatment, different reason.
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
  // A Composio row holds no credential at all — neither its own nor a borrowed
  // one. The token is at Composio and what reaches them is the deployment's API
  // key, which is an environment variable rather than anything in this table.
  // Refused loudly rather than falling through to the query below, where it
  // would read a NULL ciphertext and fail with a sentence about a missing
  // credential that is true of every row and explains nothing.
  if (connection.transport === "composio") {
    throw new Error("a connected app keeps its credential at Composio, not in this row");
  }

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
  // Composio authenticates the DEPLOYMENT, not the row. There is no envelope to
  // decrypt and no per-workspace credential to find: one API key opens every
  // connected account on this deployment, which is exactly why 0063 keeps the
  // account reference out of every client role's reach.
  if (connection.transport === "composio") {
    if (!env.COMPOSIO_API_KEY) {
      throw new Error("this deployment has no COMPOSIO_API_KEY set");
    }
    return { "x-api-key": env.COMPOSIO_API_KEY };
  }

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
 * Which Composio account a connection executes against, and on whose behalf.
 *
 * The two columns 0063 withholds from every client role, for a connection the
 * caller has already been found — through their own client, by
 * `loadConnection` — to be allowed to have. Same order and same discipline as
 * everything else in this file: ask, then fetch.
 *
 * **Which halves are required depends on the shape of the row, and the row says
 * which shape it is.** For a `composio` row both are, because a call missing
 * one is a call Composio would answer for the wrong account or not at all. For
 * a `composio_no_auth` row there is no account to name — the application needs
 * no credential, so Composio holds nothing on its behalf and the operation
 * executes on `user_id` alone (covan#253). Read off `auth_kind`, which 0072
 * made the discriminator and which no client role may write, rather than
 * inferred from a null: a managed row that has genuinely lost its account must
 * stay the error it is, and the two are otherwise indistinguishable here.
 *
 * The row type is the reminder that the permission question is already behind
 * us.
 */
export async function composioAccount(
  env: ToolEnv,
  connection: ToolConnection,
): Promise<{ connectedAccountId: string; composioUserId: string } | null> {
  const { data, error } = await serviceClient(env)
    .from("tool_connections")
    .select("connected_account_id, composio_user_id")
    .eq("id", connection.id)
    .maybeSingle();
  if (error || !data) return null;
  const connectedAccountId =
    typeof data.connected_account_id === "string" ? data.connected_account_id : "";
  const composioUserId = typeof data.composio_user_id === "string" ? data.composio_user_id : "";
  if (!composioUserId) return null;
  if (connection.auth_kind === "composio_no_auth")
    return { connectedAccountId: "", composioUserId };
  if (!connectedAccountId) return null;
  return { connectedAccountId, composioUserId };
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
  summaryVersion: number,
): Promise<void> {
  const { error } = await serviceClient(env)
    .from("tool_connections")
    .update({
      config: {
        ...connection.config,
        summary,
        // What rendered it. A summary written by an older build is refetched
        // once rather than served forever — see `SUMMARY_VERSION`.
        summary_version: summaryVersion,
        summary_cached_at: new Date().toISOString(),
      },
    })
    .eq("id", connection.id);
  if (error) console.error("could not cache connection summary", error);
}

/**
 * Remember that this connection cannot run an operation, so the next search
 * stops offering it.
 *
 * Composio's execute endpoint is the only thing that knows which subset of a
 * toolkit's catalogue a connected account actually has: it answers
 * `404 Tool_ToolNotFound` for a slug that is in the catalogue and not on the
 * account. `find_tool` cannot ask in advance — `/api/v3.1/tools` has no
 * parameter that names a connected account — so the fact is learnt here, the
 * one place that finds it out, and read back by `unavailableTools` in
 * `lib/harness/connections.ts`.
 *
 * It is worth writing down because it was measured: twenty of the thirty
 * `run_tool` failures ever recorded are this, more than every other cause
 * combined, and the same slug was bought three times in one conversation on
 * 2026-09-28 because the withdrawal only lasted the turn.
 *
 * Service role, for exactly `cacheConnectionSummary`'s reason above: 0059 lets
 * only the connection's creator or a workspace admin update the row, which is
 * right for somebody editing a connection and wrong for a cache write nobody
 * chose to make. Same allowlist entry, same best-effort contract — a failed
 * write costs one more failed call later and must never fail the tool.
 *
 * Read-modify-write on a jsonb bag, so two 404s landing together can lose one
 * of the two. That is accepted rather than locked: the cost is one extra failed
 * call, and the alternative is a transaction on the critical path of a tool that
 * has already failed.
 */
export async function recordUnavailableTool(
  env: ToolEnv,
  connection: ToolConnection,
  slug: string,
): Promise<void> {
  const raw = connection.config.unavailable_tools;
  const bag =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  // Newest last, then trimmed from the front, so a connection that has met a
  // lot of missing operations keeps the most recent ones rather than the first
  // ones it ever saw. The cap is for `config`, which is read on every prompt
  // that renders the manifest.
  const next: Record<string, unknown> = { ...bag, [slug]: new Date().toISOString() };
  const keys = Object.keys(next);
  const trimmed =
    keys.length <= MAX_UNAVAILABLE_TOOLS
      ? next
      : Object.fromEntries(
          keys.slice(keys.length - MAX_UNAVAILABLE_TOOLS).map((k) => [k, next[k]]),
        );

  const { error } = await serviceClient(env)
    .from("tool_connections")
    .update({ config: { ...connection.config, unavailable_tools: trimmed } })
    .eq("id", connection.id);
  if (error) console.error("could not record an unavailable tool", error);
}

/**
 * How many missing operations one connection remembers.
 *
 * A ceiling on `config`, which rides in every prompt that renders the
 * connection manifest. GitHub's catalogue is the largest here at a few hundred
 * operations, so this is generous enough that a real workspace never reaches it
 * and small enough that the bag cannot grow without bound.
 */
const MAX_UNAVAILABLE_TOOLS = 200;

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
