import type { Context, MiddlewareHandler, Next } from "hono";
import type { AppEnv } from "../types";
import { authClient, userClient } from "../lib/supabase";
import { looksLikeApiKey, mintUserToken, resolveApiKey, touchApiKey } from "../lib/api-keys";
import { deferred } from "../lib/defer";

/**
 * Validates the `Authorization: Bearer <token>` header against Supabase auth,
 * then attaches:
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
 */
export const authMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : undefined;

  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  if (looksLikeApiKey(token)) {
    return authenticateWithApiKey(c, token, next);
  }

  const { data, error } = await authClient(c.env).auth.getUser(token);

  if (error || !data?.user) {
    return c.json({ error: "unauthorized" }, 401);
  }

  c.set("user", data.user);
  c.set("db", userClient(c.env, token));

  await next();
};

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

  // Unknown, revoked, or owned by an account that no longer exists — one answer
  // for all three. Distinguishing them tells a holder about a key they do not have.
  if (!resolved) {
    return c.json({ error: "unauthorized" }, 401);
  }

  c.set("user", resolved.user);
  c.set("db", userClient(c.env, await mintUserToken(secret, resolved.user)));
  c.set("apiKeyId", resolved.keyId);

  await next();

  // After the response, and only if the stored value is stale enough to be
  // worth a write. Nothing downstream should wait on bookkeeping.
  deferred(c, touchApiKey(c.env, resolved));
}
