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
 *
 * **Who the grant goes to is decided by who finishes it, not by the state.**
 * The state says who STARTED a flow. The callback used to
 * trust that alone: it exchanged the code and stored the token as the
 * state's person, in the state's workspace. So an attacker could start a flow,
 * send the provider's genuine consent link to somebody else, and have that
 * person's Drive, Notion pages or Slack team land in the attacker's workspace
 * — "connection planting". A Drive token planted that way read the victim's
 * whole Drive.
 *
 * So the callback no longer exchanges anything. It seals what it was given
 * (the code, the state, the redirect URI) into a grant — `sealGrant` below,
 * under its own purpose so a state can never be handed back as one — and sends
 * the browser to the app with it. The app then completes the flow with an
 * authenticated request, and completing requires two things the state names:
 *
 *  - the caller is the person who started it (`userId`), so a grant that
 *    reaches somebody else's browser completes nothing; and
 *  - the browser holds the nonce whose hash the flow started with
 *    (`nonceHash`), kept in that tab's session storage, so the flow is bound
 *    to the browser that began it as well as to the account.
 *
 * Neither needs a cookie, which is what the old note here said a binding would
 * require: the API and the app are separate origins and a cross-site cookie
 * fails closed for a large share of browsers. The proof travels in an
 * authenticated request instead.
 */

/**
 * How long a started flow stays completable.
 *
 * Long enough to read a consent screen and pick pages in Notion's picker, short
 * enough to bound the window in the residual case above.
 */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * What a grant is for.
 *
 * Slack is here despite not being a `connections` provider, because the thing
 * that needs saying — who started this, in which workspace, and recently — is
 * the same sentence for both, and a second state format would be a second set
 * of expiry rules to keep in step.
 */
export type GrantKind = ProviderId | "slack";

export type OAuthState = {
  provider: GrantKind;
  userId: string;
  workspaceId: string;
  /**
   * The bundle a connection will feed. Absent for a Slack install, which feeds
   * nothing — it points an existing agent at a channel.
   */
  bundleId?: string;
  /**
   * The connection this grant replaces, when the flow was started by
   * Reconnect rather than by Connect.
   *
   * Present means "update that row"; absent means "insert a new one", which is
   * every flow that existed before 0057. The callback re-checks the id against
   * the workspace in this same state before it writes, for the reason every
   * other claim in here is re-checked: the state says what the person asked
   * for, and the database says whether it is still true.
   *
   * It is the id of a row, not a capability. Holding one lets somebody replace
   * the token on a connection in a workspace they are a writing member of,
   * which they could already do by deleting it and connecting again.
   */
  connectionId?: string;
  /**
   * SHA-256 hex of the nonce the starting browser holds in session storage.
   * Completing the flow asks for the nonce itself. See the header.
   */
  nonceHash: string;
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
  return toUrlSafe(await encryptSecret(JSON.stringify(payload), keyB64, "covan/oauth-state/v2"));
}

export async function readState(
  raw: string,
  keyB64: string,
  now = Date.now(),
): Promise<OAuthState | null> {
  try {
    const json = await decryptSecret(fromUrlSafe(raw), keyB64, "covan/oauth-state/v2");
    const parsed = JSON.parse(json) as OAuthState;
    if (!parsed.provider || !parsed.userId || !parsed.workspaceId) return null;
    if (typeof parsed.nonceHash !== "string" || !/^[0-9a-f]{64}$/.test(parsed.nonceHash)) {
      return null;
    }
    // A connection with no bundle would have nowhere to put its documents, and
    // the callback would discover that after spending the code.
    if (parsed.provider !== "slack" && !parsed.bundleId) return null;
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

/**
 * What a provider handed the callback, sealed for the app to complete with.
 *
 * The callback cannot tell who is at the browser, so it decides nothing: it
 * seals the code with the state it came with and the exact redirect URI the
 * code was issued against (the exchange must repeat it), and the completing
 * request — authenticated — decides. Sealed under its own purpose, so neither
 * a state nor a stored secret opens as a grant.
 */
export type OAuthGrant = { state: OAuthState; code: string; redirectUri: string };

export async function sealGrant(grant: OAuthGrant, keyB64: string): Promise<string> {
  return toUrlSafe(await encryptSecret(JSON.stringify(grant), keyB64, "covan/oauth-grant/v1"));
}

/** Null for anything that is not a grant we sealed, or whose flow has run out. */
export async function openGrant(
  raw: string,
  keyB64: string,
  now = Date.now(),
): Promise<OAuthGrant | null> {
  try {
    const parsed = JSON.parse(
      await decryptSecret(fromUrlSafe(raw), keyB64, "covan/oauth-grant/v1"),
    ) as OAuthGrant;
    const state = parsed?.state;
    if (!state || typeof parsed.code !== "string" || typeof parsed.redirectUri !== "string") {
      return null;
    }
    // The flow's own clock: a grant is as old as the state it carries.
    if (!Number.isFinite(state.issuedAt) || now - state.issuedAt > STATE_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** SHA-256 hex, to compare a presented nonce with the hash a state carries. */
export async function nonceHashOf(nonce: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(nonce));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const toUrlSafe = (s: string): string => s.replace(/\+/g, "-").replace(/\//g, "_");
const fromUrlSafe = (s: string): string => s.replace(/-/g, "+").replace(/_/g, "/");
