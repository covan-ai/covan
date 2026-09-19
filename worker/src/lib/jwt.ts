/**
 * Reading and writing the tokens this API trusts, without a JWT library.
 *
 * WebCrypto rather than a dependency: both runtimes this ships on have it, and
 * each algorithm below is one `sign` or `verify` call. A dependency here would
 * be a supply chain for a page of code.
 *
 * Two algorithms, because there are two kinds of deployment and they do not
 * agree. A self-hosted stack runs GoTrue with a shared `JWT_SECRET` and signs
 * HS256. A Supabase project with signing keys enabled signs ES256 and publishes
 * the public half at `/auth/v1/.well-known/jwks.json` — the secret is not a
 * secret any more because there is nothing symmetric left to keep. covan.app is
 * the second kind; `docker-compose.yml` is the first.
 *
 * Verifying locally is worth this much code because the alternative runs on
 * every single request: see `middleware/auth.ts`.
 */

export type TokenUser = { id: string; email: string };

/**
 * Three outcomes, not two, and the third is the one that matters.
 *
 * `invalid` is a decision: the signature is wrong, or the token has expired,
 * or it is not a session token at all. The caller should refuse it.
 *
 * `unknown` is the absence of one — no secret configured, no key set
 * reachable, a `kid` this deployment has never seen. The caller must fall back
 * to asking GoTrue rather than turn away a session that may well be live.
 * Collapsing the two would mean a Supabase outage, or a key rotation, logging
 * everybody out.
 */
export type Verdict =
  { status: "valid"; user: TokenUser } | { status: "invalid" } | { status: "unknown" };

const INVALID: Verdict = { status: "invalid" };
const UNKNOWN: Verdict = { status: "unknown" };

/** Exported because `api-keys.ts` spells an API key with it too. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64url(segment: string): Uint8Array | null {
  try {
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

function decodeJson(segment: string): Record<string, unknown> | null {
  const bytes = decodeBase64url(segment);
  if (!bytes) return null;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function encodeSegment(value: object): string {
  return base64url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function signHs256(secret: string, payload: object): Promise<string> {
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

/**
 * What a session token has to say beyond being correctly signed.
 *
 * `aud` is the load-bearing one. A project's anon key is signed with the very
 * same secret and would verify perfectly; it is not a session and its audience
 * says so.
 */
function userFromClaims(payload: Record<string, unknown>): TokenUser | null {
  const exp = payload.exp;
  if (typeof exp !== "number" || exp <= Math.floor(Date.now() / 1000)) return null;
  if (payload.aud !== "authenticated") return null;
  const sub = payload.sub;
  if (typeof sub !== "string" || sub === "") return null;
  return { id: sub, email: typeof payload.email === "string" ? payload.email : "" };
}

type Jwks = { keys?: Record<string, unknown>[] };

/**
 * The project's public keys, fetched once per isolate rather than per request.
 *
 * A miss on `kid` is worth exactly one refetch per minute: keys rotate, and a
 * token signed by a key newer than this cache is a real and temporary state.
 * Without the floor, a token bearing a `kid` that will never appear — a stale
 * session from a project that rotated long ago, or noise — would make every
 * request carrying it fetch the key set again.
 */
const REFETCH_AFTER_MS = 60_000;

let jwks: { keys: Map<string, CryptoKey>; fetchedAt: number } | null = null;

/** Test escape hatch, for the same reason `resetRateLimiters` exists. */
export function resetJwks(): void {
  jwks = null;
}

async function importJwk(jwk: Record<string, unknown>): Promise<CryptoKey | null> {
  // Only the key material. `alg` and `use` are descriptive, and some runtimes
  // reject a JWK import that carries fields they did not expect.
  const { kty, crv, x, y } = jwk;
  if (kty !== "EC" || crv !== "P-256") return null;
  try {
    return await crypto.subtle.importKey(
      "jwk",
      { kty, crv, x, y, ext: true } as JsonWebKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }
}

async function loadJwks(supabaseUrl: string): Promise<void> {
  const keys = new Map<string, CryptoKey>();
  try {
    const response = await fetch(`${supabaseUrl}/auth/v1/.well-known/jwks.json`);
    if (response.ok) {
      const body = (await response.json()) as Jwks;
      for (const jwk of body.keys ?? []) {
        const kid = jwk.kid;
        if (typeof kid !== "string") continue;
        const key = await importJwk(jwk);
        if (key) keys.set(kid, key);
      }
    }
  } catch {
    // Left empty on purpose: an unreachable key set is `unknown`, not invalid.
  }
  jwks = { keys, fetchedAt: Date.now() };
}

async function publicKeyFor(supabaseUrl: string, kid: string): Promise<CryptoKey | null> {
  if (!jwks) await loadJwks(supabaseUrl);
  const hit = jwks?.keys.get(kid);
  if (hit) return hit;
  if (jwks && Date.now() - jwks.fetchedAt > REFETCH_AFTER_MS) {
    await loadJwks(supabaseUrl);
    return jwks?.keys.get(kid) ?? null;
  }
  return null;
}

/**
 * Verify a caller's bearer token against what this deployment knows, without
 * going near the network on the happy path.
 */
export async function verifyAccessToken(
  env: { SUPABASE_URL: string; SUPABASE_JWT_SECRET?: string },
  token: string,
): Promise<Verdict> {
  const parts = token.split(".");
  if (parts.length !== 3) return INVALID;
  const [headerSegment, payloadSegment, signatureSegment] = parts;

  const header = decodeJson(headerSegment);
  const payload = decodeJson(payloadSegment);
  const signature = decodeBase64url(signatureSegment);
  if (!header || !payload || !signature) return INVALID;

  const body = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);

  let signatureIsGood: boolean;

  if (header.alg === "HS256") {
    const secret = env.SUPABASE_JWT_SECRET;
    if (!secret) return UNKNOWN;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    signatureIsGood = await crypto.subtle.verify("HMAC", key, signature, body);
  } else if (header.alg === "ES256") {
    if (typeof header.kid !== "string") return INVALID;
    const key = await publicKeyFor(env.SUPABASE_URL, header.kid);
    if (!key) return UNKNOWN;
    signatureIsGood = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      body,
    );
  } else {
    // Including `none`, which is the attack this branch exists to not have.
    return UNKNOWN;
  }

  if (!signatureIsGood) return INVALID;

  const user = userFromClaims(payload);
  return user ? { status: "valid", user } : INVALID;
}
