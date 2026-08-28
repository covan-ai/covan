import type { User } from "@supabase/supabase-js";
import type { Bindings } from "../types";
import { serviceClient } from "./supabase";

/**
 * API keys: a credential that outlives a browser session.
 *
 * The whole authorization model rests on `auth.uid()` resolving inside RLS, and
 * an opaque key resolves to nothing on its own. So a key is not a second way to
 * be authorized — it is a way to become the person who owns it. Look the key up,
 * mint a very short-lived JWT for that user, and make the request with it. From
 * Postgres's side nothing has changed, which is the property worth protecting:
 * the alternative is re-implementing tenancy in the API, which
 * `service-client.static.test.ts` exists to stop.
 *
 * Every request that arrives with a key pays for two round trips before it does
 * any work — the key lookup and the user lookup. That is the price of not having
 * a session, and it is bounded by the standard rate limit like anything else.
 */

/**
 * What a Covan key looks like. The prefix is load-bearing rather than
 * decorative: `authMiddleware` uses it to tell a key from a JWT without trying
 * to parse either, and a secret scanner can match on it.
 */
export const API_KEY_PREFIX = "covan_sk_";

/** How much of a key is shown in the interface so a row can be recognised. */
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 6;

/**
 * How long the minted token lives. Long enough for one request and its retries,
 * short enough that a token captured in a log is worthless by the time anyone
 * reads it. It is never returned to the caller and never leaves the Worker.
 */
const MINTED_TOKEN_TTL_SECONDS = 60;

/**
 * How stale `last_used_at` may get before it is worth a write. A forgotten key
 * is recognised at this resolution, which is all the interface asks for; writing
 * on every request would put an UPDATE in front of every read.
 */
const TOUCH_AFTER_MS = 5 * 60 * 1000;

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

/** A new key, and the two things that get stored instead of it. */
export async function generateApiKey(): Promise<{
  token: string;
  tokenHash: string;
  prefix: string;
}> {
  // 32 bytes of CSPRNG, base64url so the whole key is one selectable word.
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = API_KEY_PREFIX + base64url(bytes);
  return {
    token,
    tokenHash: await hashApiKey(token),
    prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

/**
 * SHA-256 hex, and deliberately not a password hash. The token is 32 random
 * bytes, so there is no dictionary for bcrypt's slowness to defend against —
 * it would cost Worker CPU on every request and buy nothing. What matters is
 * that the database never holds anything that can be replayed.
 */
export async function hashApiKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type ResolvedApiKey = {
  keyId: string;
  workspaceId: string;
  user: User;
  /** The stored value, so the caller can decide whether a write is worth it. */
  lastUsedAt: string | null;
};

/**
 * Turn a key into the person who owns it, or null.
 *
 * Null for every failure — unknown, revoked, or owned by a user who no longer
 * exists — because the caller turns all of them into the same 401. Telling a
 * holder which of those it was tells them something about a key they do not have.
 *
 * This is the fifth place in the API that reaches past RLS, and the reason is
 * the same one `authClient` has: authentication cannot be performed by the
 * caller's own client, because there is no caller yet. It goes no further than
 * the row it was given a hash for.
 */
export async function resolveApiKey(env: Bindings, token: string): Promise<ResolvedApiKey | null> {
  const admin = serviceClient(env);

  const { data: row, error } = await admin
    .from("api_keys")
    .select("id, workspace_id, user_id, last_used_at")
    .eq("token_hash", await hashApiKey(token))
    .is("revoked_at", null)
    .maybeSingle();

  if (error || !row) return null;

  // The authoritative source for the email the minted token has to carry, and
  // the check that the account still exists at all — a deleted user leaves the
  // row behind only until the cascade runs.
  const { data: found, error: userError } = await admin.auth.admin.getUserById(
    row.user_id as string,
  );
  if (userError || !found?.user) return null;

  return {
    keyId: row.id as string,
    workspaceId: row.workspace_id as string,
    user: found.user,
    lastUsedAt: (row.last_used_at as string | null) ?? null,
  };
}

/**
 * A JWT the project will accept, for a user we have already identified.
 *
 * HS256 against the project's JWT secret, which is the same secret GoTrue signs
 * a browser's session with — so the token below is indistinguishable from one,
 * except that it expires in a minute and names no session. `role` is what
 * PostgREST switches into, and `sub` is what `auth.uid()` reads; the rest is
 * what the client libraries expect to find.
 */
export async function mintUserToken(secret: string, user: User): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return signHs256(secret, {
    sub: user.id,
    email: user.email ?? "",
    role: "authenticated",
    aud: "authenticated",
    iat: now,
    exp: now + MINTED_TOKEN_TTL_SECONDS,
  });
}

/**
 * Record that a key was used, if it has been long enough to be worth a write.
 *
 * Called through `deferred`, so it runs past the end of the response and a
 * failure costs nothing — a `last_used_at` that is five minutes behind is not
 * worth failing a request over.
 */
export async function touchApiKey(env: Bindings, key: ResolvedApiKey): Promise<void> {
  const last = key.lastUsedAt ? Date.parse(key.lastUsedAt) : 0;
  if (Number.isFinite(last) && Date.now() - last < TOUCH_AFTER_MS) return;

  await serviceClient(env)
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", key.keyId);
}

// ---- signing ---------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeSegment(value: object): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

/**
 * WebCrypto rather than a JWT library: both runtimes this ships on have it, and
 * the whole of HS256 is one `sign` call. A dependency here would be a supply
 * chain for eleven lines.
 */
async function signHs256(secret: string, payload: object): Promise<string> {
  const body = `${encodeSegment({ alg: "HS256", typ: "JWT" })}.${encodeSegment(payload)}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));

  return `${body}.${base64url(new Uint8Array(signature))}`;
}
