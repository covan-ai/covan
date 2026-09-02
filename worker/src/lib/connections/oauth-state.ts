import { decryptSecret, encryptSecret } from "../secret-box";
import type { ProviderId } from "./types";

/**
 * The `state` parameter, and why it is encrypted rather than random.
 *
 * The OAuth callback is the one route in this API that cannot be authenticated:
 * the browser arrives on a redirect from Notion or Google, carrying no bearer
 * token and no cookie we set. Something has to say who this grant belongs to,
 * and the only thing that crosses the gap is `state`.
 *
 * The usual answer is a random nonce stored server-side. That would need a
 * table, an expiry sweep, and a second round trip on a route whose whole job is
 * to be fast. The answer here is to make `state` itself the record: the payload
 * below is JSON, encrypted with AES-GCM under the same key that protects the
 * tokens it is about to create. AES-GCM is authenticated, so a forged or edited
 * state does not decrypt — which is exactly the CSRF property a nonce is for —
 * and `issuedAt` bounds how long a captured redirect stays usable.
 *
 * What it is deliberately NOT is a bearer token: it names a user and a bundle,
 * and everything it names is re-checked against RLS before a row is written.
 */

/** How long a started flow stays completable. Long enough to read a consent screen. */
const STATE_TTL_MS = 15 * 60 * 1000;

export type OAuthState = {
  provider: ProviderId;
  userId: string;
  workspaceId: string;
  bundleId: string;
  /** Epoch milliseconds. */
  issuedAt: number;
};

export async function signState(
  state: Omit<OAuthState, "issuedAt">,
  keyB64: string,
  now = Date.now(),
): Promise<string> {
  const payload: OAuthState = { ...state, issuedAt: now };
  // base64url so it survives a query string untouched — Notion and Google both
  // echo `state` back verbatim, and a raw `+` in a URL is a space.
  return toUrlSafe(await encryptSecret(JSON.stringify(payload), keyB64));
}

export async function readState(
  raw: string,
  keyB64: string,
  now = Date.now(),
): Promise<OAuthState | null> {
  try {
    const json = await decryptSecret(fromUrlSafe(raw), keyB64);
    const parsed = JSON.parse(json) as OAuthState;
    if (!parsed.provider || !parsed.userId || !parsed.workspaceId || !parsed.bundleId) return null;
    if (!Number.isFinite(parsed.issuedAt) || now - parsed.issuedAt > STATE_TTL_MS) return null;
    // A clock that has gone backwards is a reason to refuse rather than to
    // guess: an `issuedAt` in the future is what a replayed state from a
    // machine with a wrong clock looks like.
    if (parsed.issuedAt - now > 60_000) return null;
    return parsed;
  } catch {
    // Tampered, expired key, or simply not ours. All the same answer: this is
    // not a state we issued.
    return null;
  }
}

const toUrlSafe = (s: string): string => s.replace(/\+/g, "-").replace(/\//g, "_");
const fromUrlSafe = (s: string): string => s.replace(/-/g, "+").replace(/_/g, "/");
