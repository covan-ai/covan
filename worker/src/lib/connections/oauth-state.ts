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
 * **On the CSRF this is usually about, and why the usual fix is not here.**
 * The classic OAuth state attack is session fixation: an attacker runs the flow
 * with *their* Notion account, gets a code, and lures a victim into loading the
 * callback, so the attacker's third-party account ends up attached to the
 * victim's app account. The standard defence is to bind the state to the
 * initiating browser with a cookie.
 *
 * That attack cannot land here, because the callback never reads the visiting
 * browser's identity. Who the grant belongs to comes out of `state` — which was
 * minted for the person who started the flow — so a victim who loads an
 * attacker's callback link completes the *attacker's* connection into the
 * *attacker's* workspace, and nothing is written anywhere near the victim.
 * `routes/connections.ts` then re-checks that named person's membership and
 * write access before inserting, so a state issued to somebody who has since
 * been removed from the workspace fails too.
 *
 * The residual case is the mirror image: an attacker who captures somebody
 * else's state before they finish, and completes it with their own Notion — so
 * the victim's bundle fills with documents the attacker chose. It is bounded
 * (documents in, never out — the token stored is the attacker's, and it grants
 * no read of anything in Covan), the connection is visible to every member of
 * the workspace and deletable by any admin, and capturing the state means
 * reading a URL out of a browser that is also carrying that person's session
 * token. The TTL below is what limits the window.
 *
 * A cookie would not close it in this deployment anyway: the API and the
 * frontend are separate origins (`api.covan.app` and `covan.app`), so a binding
 * cookie would have to be `SameSite=None`, which is exactly the kind Safari and
 * Chrome now block — it would fail closed for a large share of real users while
 * defending against an attacker who already has their session. If the two ever
 * share an origin, bind it.
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
    if (!parsed.provider || !parsed.userId || !parsed.workspaceId) return null;
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

const toUrlSafe = (s: string): string => s.replace(/\+/g, "-").replace(/\//g, "_");
const fromUrlSafe = (s: string): string => s.replace(/-/g, "+").replace(/_/g, "/");
