/**
 * HMAC-SHA256, and the comparison that has to go with it.
 *
 * Both halves were written once for Slack's signature check
 * (`lib/slack/verify.ts`) and are about to be written a second time for
 * outgoing webhooks, which sign with the same scheme deliberately. Two copies
 * of a signature routine do not stay identical — they drift, and the direction
 * they drift in is `===`, a comparison that answers a byte at a time and tells
 * anyone willing to measure how much of their guess was right.
 *
 * So there is one implementation and the verifiers around it are thin.
 */

/** Lowercase hex, the form every signature header in this codebase carries. */
function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The MAC over `message` keyed by `secret`, as lowercase hex.
 *
 * WebCrypto rather than `node:crypto`, because this runs on Workers and on Node
 * and only WebCrypto exists in both. It throws on a zero-length key, so a
 * caller with no secret configured has to refuse before it gets here — see the
 * first line of `verifySlackSignature`. Turning a missing secret into a 500 on
 * every delivery is the failure this note exists to prevent.
 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

/** Constant time in the length-equal case, which is the only one that matters. */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
