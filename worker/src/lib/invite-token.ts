import { base64url } from "./jwt";

/**
 * The secret an invitation email carries (0090).
 *
 * Accepting an invitation used to need only a confirmed account at the
 * invited address, and "confirmed" proves a mailbox only on an install that
 * actually sends a confirmation — the compose stack auto-confirms. So the
 * email now carries a token, and holding the email is what is proved: 32 bytes
 * of CSPRNG, base64url, of which the database keeps a SHA-256 hex that
 * `accept_invitation` recomputes from what the link hands back.
 *
 * The same shape and the same hashing reasoning as `lib/api-keys.ts` and the
 * routine ingest token: random bytes need no slow hash, and nothing replayable
 * is stored.
 */
export async function generateInviteToken(): Promise<{ token: string; tokenHash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = base64url(bytes);
  return { token, tokenHash: await hashInviteToken(token) };
}

/** Must agree with `encode(sha256(convert_to(token, 'UTF8')), 'hex')` in 0090. */
export async function hashInviteToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Where the email's button goes.
 *
 * In the fragment, not the query: a fragment is never sent to a server, so the
 * token does not land in an access log, a proxy, or a `Referer` header on the
 * next page. `src/routes/invite.tsx` reads it, keeps it in this browser and
 * takes it out of the address bar before anything else runs.
 */
export function inviteUrl(appUrl: string, inviteId: string, token: string): string {
  return `${appUrl}/invite#id=${encodeURIComponent(inviteId)}&token=${encodeURIComponent(token)}`;
}
