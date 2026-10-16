/**
 * Proving a delivery really came from Composio.
 *
 * `POST /composio/events` is one public URL for every trigger in the project,
 * and what it does on a valid delivery is start a routine — a model call billed
 * to somebody's workspace. So this check is the whole of what stands between
 * that URL and anybody who can type a curl command, for the reason
 * `lib/slack/verify.ts` gives about Slack's.
 *
 * Composio signs the way Svix does, which is the convention most webhook
 * senders settled on: three headers, an HMAC-SHA256 over
 * `${webhook-id}.${webhook-timestamp}.${body}`, base64, sent as `v1,<mac>` —
 * several of them space-separated while a secret is being rotated, any one of
 * which may match. (Svix's convention, not its key handling: see below.) The two quiet ways to get it wrong are the same two as
 * Slack's: `===` (use `timingSafeEqual`), and ignoring the timestamp, which
 * turns one captured delivery into a replay that starts the same routine
 * forever. The event id below is a delivery claim too (`evt:composio:<id>`),
 * so a replay inside the window runs nothing either.
 */

import { timingSafeEqual } from "../hmac";

/** How far out of date a delivery may be. Svix's own default. */
const MAX_SKEW_SECONDS = 5 * 60;

export type WebhookHeaders = {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
};

export type WebhookCheck = { ok: true } | { ok: false; reason: string };

/**
 * The secret is the key as it is, byte for byte — not base64-decoded, and no
 * prefix stripped. That is what both of Composio's SDKs do (`crypto.ts` in the
 * TypeScript one, `triggers.py` in the Python one), and a Svix habit of
 * decoding a `whsec_` secret would compute a MAC nobody sent.
 */
async function macBase64(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  return btoa(String.fromCharCode(...mac));
}

/**
 * Verify one delivery. `body` has to be the raw text, byte for byte —
 * re-serialised JSON is a different string, and the MAC is over what was sent.
 */
export async function verifyComposioWebhook(
  secret: string,
  headers: WebhookHeaders,
  body: string,
  now = Date.now(),
): Promise<WebhookCheck> {
  if (!secret) return { ok: false, reason: "no webhook secret configured" };
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { ok: false, reason: "unsigned" };
  }

  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(now / 1000 - timestamp) > MAX_SKEW_SECONDS) return { ok: false, reason: "stale" };

  const expected = await macBase64(secret, `${headers.id}.${headers.timestamp}.${body}`);
  // Every `v1,` entry is a candidate; the rest (a future version) is skipped.
  const candidates = headers.signature
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1,"))
    .map((part) => part.slice(3));
  let matched = false;
  // Every candidate is compared, so how many there were and which one matched
  // is not something the time taken can tell anybody.
  for (const candidate of candidates) {
    if (timingSafeEqual(expected, candidate)) matched = true;
  }
  return matched ? { ok: true } : { ok: false, reason: "signature mismatch" };
}
