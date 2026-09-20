/**
 * Proving a request really came from Slack.
 *
 * The events endpoint is a public URL that runs an agent and spends the
 * workspace's allowance, so this is the only thing standing between it and
 * anybody who can type a curl command. Slack signs every delivery; the check is
 * an HMAC over a fixed string, and the two ways to get it wrong are both quiet.
 *
 * The first is comparing strings with `===`, which leaks the position of the
 * first wrong byte to anyone willing to measure. The second is skipping the
 * timestamp, which turns one captured request into a replay that works forever
 * — and a replayed question re-answers, re-posts and re-charges.
 */

import { hmacSha256Hex, timingSafeEqual } from "../hmac";

/**
 * How far out of date a signed request may be.
 *
 * Slack's own recommendation. It has to allow for the network and for a
 * server's clock being a little off; longer would widen the replay window for
 * no benefit, since Slack itself retries within seconds.
 */
const MAX_SKEW_SECONDS = 5 * 60;

/** The version prefix Slack puts on its signatures, and the one we accept. */
const VERSION = "v0";

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

/**
 * Verify one delivery.
 *
 * `body` has to be the raw text, byte for byte. Re-serialising the parsed JSON
 * produces a different string — key order, whitespace, unicode escapes — and
 * the signature is over what Slack sent, not over what it meant.
 */
export async function verifySlackSignature(
  signingSecret: string,
  headers: { signature: string | undefined; timestamp: string | undefined },
  body: string,
  now = Date.now(),
): Promise<SignatureCheck> {
  if (!signingSecret) return { ok: false, reason: "no signing secret configured" };
  if (!headers.signature || !headers.timestamp) return { ok: false, reason: "unsigned" };

  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(now / 1000 - timestamp) > MAX_SKEW_SECONDS) {
    return { ok: false, reason: "stale" };
  }

  const mac = await hmacSha256Hex(signingSecret, `${VERSION}:${headers.timestamp}:${body}`);
  const expected = `${VERSION}=${mac}`;

  return timingSafeEqual(expected, headers.signature)
    ? { ok: true }
    : { ok: false, reason: "signature mismatch" };
}
