import type { Context, MiddlewareHandler, Next } from "hono";
import type { AppEnv } from "../types";
import { authClient, userClient } from "../lib/supabase";
import { looksLikeApiKey, mintUserToken, resolveApiKey, touchApiKey } from "../lib/api-keys";
import { deferred } from "../lib/defer";
import { base64url, claimedAal, verifyAccessToken, type TokenUser } from "../lib/jwt";
import { runtimeLimitFlag } from "../lib/runtime-limit";
import { subrequestMeter, withMeter } from "../lib/subrequests";

/**
 * Validates the `Authorization: Bearer <token>` header, then attaches:
 *   - c.set("user", <the authenticated user>)
 *   - c.set("db", <a request-scoped Supabase client carrying that token>)
 *
 * The `db` client is what downstream routes must use for data access — it
 * ensures Postgres RLS (`auth.uid()`) resolves to the caller, so tenant
 * isolation is enforced by the database, not by application code.
 *
 * Two kinds of credential arrive here and both end in the same place. A browser
 * sends the session JWT GoTrue gave it. A script sends a `covan_sk_` API key,
 * which is exchanged below for a sixty-second JWT belonging to the key's owner.
 * What `c.set("db")` receives is a token-scoped client either way — the branch
 * is about how the caller proved who they are, never about what they may do.
 *
 * ## Why the session branch does not call GoTrue
 *
 * It used to, on every request, valid or not: one `GET /auth/v1/user` from
 * wherever this Worker runs to wherever Supabase runs, in front of a page that
 * makes several requests to paint. A session token is signed, and `lib/jwt.ts`
 * can check a signature without leaving the isolate.
 *
 * What that gives up is precise: GoTrue knows a session has been signed out and
 * a signature does not. Between a sign-out and the token's own expiry, a
 * verified-locally token is still accepted. The bound on that is the project's
 * access-token lifetime, which is a Supabase setting and the right dial for it.
 * Nothing about *authorization* moves — RLS is enforced by Postgres against the
 * same token, exactly as before.
 *
 * The fallback keeps the old behaviour wherever the signature cannot be judged:
 * a self-hosted stack with no `SUPABASE_JWT_SECRET`, an unreachable key set, a
 * `kid` from a rotation this isolate has not seen. Those ask GoTrue, and the
 * answer is cached briefly so a burst of requests behind one page load pays for
 * at most one.
 *
 * ## The second step
 *
 * An account with an authenticator owes a code after its password, and a
 * session that has not given it is `aal1`. Postgres refuses such a session on
 * every PostgREST request (0108), which covers every route that reads through
 * `c.get("db")` before doing anything. Not every route does: some reach for the
 * service client first, or for a model or a third party, and those would serve
 * a stolen password as readily as a whole sign-in. So the question is asked
 * here, once, in front of all of them — see `secondFactorSatisfied`.
 */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;

  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  // Before either branch builds a client, because the caller's own client is
  // the first thing in a request that spends a subrequest and counting it from
  // the route would miss every read the route makes to find out who is asking.
  // See `lib/subrequests.ts`.
  const runtimeLimit = runtimeLimitFlag();
  c.set("runtimeLimit", runtimeLimit);
  c.set("subrequests", subrequestMeter(c.env, runtimeLimit));

  if (looksLikeApiKey(token)) {
    return authenticateWithApiKey(c, token, next);
  }

  const verdict = await verifyAccessToken(c.env, token);

  if (verdict.status === "invalid") {
    return c.json({ error: "unauthorized" }, 401);
  }

  const user = verdict.status === "valid" ? verdict.user : await askGoTrue(c, token);

  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const db = userClient(withMeter(c.env, c.get("subrequests")), token);

  if (claimedAal(token) !== "aal2") {
    const satisfied = await secondFactorSatisfied(db, token);
    if (satisfied === null) return c.json({ error: "could not check your sign-in" }, 503);
    if (!satisfied) return c.json({ error: "second factor required" }, 403);
  }

  c.set("user", user);
  c.set("db", db);

  await next();
};

/**
 * Answers this deployment could not work out for itself, remembered briefly.
 *
 * Keyed by a digest rather than the token: this map outlives the request, and a
 * bearer token sitting in module scope is a credential waiting for the next
 * thing that reads memory. The digest is enough to recognise the same token
 * again and no use to anybody who obtains it.
 *
 * A minute is chosen against what it costs to be wrong. Only sign-out and
 * account deletion make a live token stale, and this path is already the
 * fallback — the deployments on it are the ones whose signatures cannot be
 * checked, which is not covan.app.
 *
 * Isolates are many and short-lived, so this is a hit-rate improvement and
 * never a guarantee; `lib/ratelimit/index.ts` says the same about its own
 * module-scope map, for the same runtime reason.
 */
const GOTRUE_CACHE_TTL_MS = 60_000;
const GOTRUE_CACHE_LIMIT = 1024;

const recentlyVerified = new Map<string, { user: TokenUser; at: number }>();

/** Test escape hatch, as `resetRateLimiters` is for the limiter's map. */
export function resetAuthCache(): void {
  recentlyVerified.clear();
  secondFactorChecked.clear();
}

async function fingerprint(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return base64url(new Uint8Array(digest));
}

async function askGoTrue(c: Context<AppEnv>, token: string): Promise<TokenUser | null> {
  const key = await fingerprint(token);
  const hit = recentlyVerified.get(key);
  if (hit && Date.now() - hit.at < GOTRUE_CACHE_TTL_MS) return hit.user;

  const { data, error } = await authClient(c.env).auth.getUser(token);
  if (error || !data?.user) return null;

  const user: TokenUser = { id: data.user.id, email: data.user.email ?? "" };

  // Failures are not cached: they cost one round trip to establish and caching
  // them would hold a refreshed token out for up to a minute.
  if (recentlyVerified.size >= GOTRUE_CACHE_LIMIT) {
    const oldest = recentlyVerified.keys().next().value;
    if (oldest !== undefined) recentlyVerified.delete(oldest);
  }
  recentlyVerified.set(key, { user, at: Date.now() });

  return user;
}

/**
 * Whether an `aal1` session may be served: it may, unless its account has a
 * verified authenticator. `null` when the database could not be asked.
 *
 * The token alone cannot say — an `aal1` token is what every account without
 * an authenticator carries too — so this is one PostgREST call, answered by
 * `second_factor_satisfied()` (0108). An account that owes a code does not even
 * get that far: the pre-request hook answers its call with 403 / `PT403`,
 * which is the "no" this reads.
 *
 * Remembered for a minute per token, by digest, for `recentlyVerified`'s
 * reasons. A token's own claim cannot change; what can is the account adding
 * its first authenticator while an older `aal1` token is still live somewhere
 * else, and for that token this answer may be a minute late. Failures to ask
 * are not remembered.
 */
const secondFactorChecked = new Map<string, { satisfied: boolean; at: number }>();

async function secondFactorSatisfied(
  db: ReturnType<typeof userClient>,
  token: string,
): Promise<boolean | null> {
  const key = await fingerprint(token);
  const hit = secondFactorChecked.get(key);
  if (hit && Date.now() - hit.at < GOTRUE_CACHE_TTL_MS) return hit.satisfied;

  const { data, error } = await db.rpc("second_factor_satisfied");
  let satisfied: boolean;
  if (!error) satisfied = data === true;
  else if (error.code === "PT403") satisfied = false;
  // No such function: a database from before 0108, where nothing requires a
  // second step either. Answering 503 here would turn deploying the API ahead
  // of the migration into an outage for everybody.
  else if (error.code === "PGRST202") satisfied = true;
  else return null;

  if (secondFactorChecked.size >= GOTRUE_CACHE_LIMIT) {
    const oldest = secondFactorChecked.keys().next().value;
    if (oldest !== undefined) secondFactorChecked.delete(oldest);
  }
  secondFactorChecked.set(key, { satisfied, at: Date.now() });

  return satisfied;
}

/**
 * The API-key half.
 *
 * `apiKeyId` on the context is not bookkeeping — it is what lets a route refuse
 * to do something a key must not do, and the one that matters is minting more
 * keys. Without it a leaked key writes itself permanent successors and revoking
 * the original achieves nothing. See routes/api-keys.ts.
 */
async function authenticateWithApiKey(c: Context<AppEnv>, token: string, next: Next) {
  const secret = c.env.SUPABASE_JWT_SECRET;

  // No secret, no minting, so a key cannot be honoured however valid it looks.
  // A deployment that has not set one has not turned this on; saying so is
  // better than a 401 that reads like a bad key.
  if (!secret) {
    return c.json({ error: "api keys are not enabled on this deployment" }, 401);
  }

  const resolved = await resolveApiKey(c.env, token);

  // Unknown, revoked, owned by an account that no longer exists, or owned by
  // somebody no longer in the key's workspace — one answer for all four.
  // Distinguishing them tells a holder about a key they do not have.
  if (!resolved) {
    return c.json({ error: "unauthorized" }, 401);
  }

  c.set("user", { id: resolved.user.id, email: resolved.user.email ?? "" });
  c.set(
    "db",
    userClient(
      withMeter(c.env, c.get("subrequests")),
      await mintUserToken(secret, resolved.user, resolved),
    ),
  );
  c.set("apiKeyId", resolved.keyId);
  c.set("apiKeyWorkspaceId", resolved.workspaceId);

  await next();

  // After the response, and only if the stored value is stale enough to be
  // worth a write. Nothing downstream should wait on bookkeeping.
  deferred(c, touchApiKey(c.env, resolved));
}
