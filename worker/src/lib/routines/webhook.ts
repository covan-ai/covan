/**
 * The outgoing webhook channel: a routine's result, POSTed somewhere a program
 * is listening.
 *
 * Slack and email deliver to a person. This delivers to whatever the workspace
 * runs — a queue, a deploy, a ticket tracker, a spreadsheet script — which is
 * what turns a routine's output into somebody else's input. It is deliberately
 * generic: no vendor is named anywhere in this file, because the breadth is
 * supposed to come from the adapter rather than from a list of connectors that
 * has to be extended one name at a time.
 *
 * Three things in here are a public contract the moment the first receiver is
 * written against them — the payload shape, the headers, and the signature —
 * so each carries a version and none of them may change meaning in place.
 */

import { base64url } from "../jwt";
import { hmacSha256Hex } from "../hmac";

/**
 * The prefix on a signing secret.
 *
 * Deliberately not `covan_sk_`: `looksLikeApiKey()` matches on that prefix to
 * tell an API key from a JWT, and a signing secret is not a credential for
 * calling this API — it proves a body came from us, in the other direction.
 * `whsec_` is also what the ecosystem's other signed webhooks use, which means
 * a secret scanner already has a rule for it.
 */
export const SIGNING_SECRET_PREFIX = "whsec_";

/** The payload's `version`. Bump only for a change a receiver must notice. */
export const PAYLOAD_VERSION = 1;

/** The signature scheme's version, carried in the header as `v1=<hex>`. */
export const SIGNATURE_VERSION = "v1";

/**
 * What happened. A receiver switches on this rather than on the URL it chose.
 *
 * The engine's own notices go out through the routine's channel too — that is
 * how a paused routine reaches its owner — so a webhook receiver sees them as
 * well, and must be able to tell "here is this week's digest" from "this
 * routine has stopped". Without the distinction, a pause notice would be filed
 * as a result, which for a receiver that writes results somewhere is a wrong
 * row rather than a missing one.
 */
export const EVENT_DELIVERED = "routine.delivered";
export const EVENT_PAUSED = "routine.paused";
export const EVENT_QUOTA_EXHAUSTED = "routine.quota_exhausted";
export const EVENT_TEST = "routine.test";

export const HEADER_EVENT = "X-Covan-Event";
export const HEADER_DELIVERY = "X-Covan-Delivery";
export const HEADER_TIMESTAMP = "X-Covan-Timestamp";
export const HEADER_SIGNATURE = "X-Covan-Signature";

/** What a `webhook` channel's decrypted secret holds. */
export type WebhookConfig = { url: string; signingSecret: string };

/**
 * A new signing secret: 32 bytes of CSPRNG, base64url, shown once.
 *
 * The same shape as `lib/api-keys.ts` mints, and for the same reason — one
 * selectable word with no characters that a shell, a YAML file or a URL will
 * argue about. It is stored encrypted rather than hashed, which is the one
 * difference that matters and is forced: verifying a signature means computing
 * one, so this side needs the secret back, not a digest of it.
 */
export function generateSigningSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return SIGNING_SECRET_PREFIX + base64url(bytes);
}

/**
 * The plaintext that goes into `secret_ciphertext` for this kind.
 *
 * JSON rather than a delimiter, and versioned, because this string is written
 * by one deploy and read by every later one: a `v` that a future reader can
 * refuse is worth the four bytes. See 0054 for why it shares one column with
 * the URL instead of getting a column of its own.
 */
export function serialiseWebhookSecret(config: WebhookConfig): string {
  return JSON.stringify({ v: 1, url: config.url, signingSecret: config.signingSecret });
}

/**
 * Read it back, refusing anything that is not exactly the shape written above.
 *
 * Loud rather than lenient. A channel whose secret cannot be read is a channel
 * that cannot deliver, and the useful failure says so once — a lenient parse
 * that fell back to "treat the whole string as a URL" would POST an unsigned
 * body to a receiver that is about to reject it, five times, and then pause a
 * working routine over it.
 */
export function parseWebhookSecret(plaintext: string): WebhookConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("webhook channel secret is not readable");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("webhook channel secret is not readable");
  }
  const { v, url, signingSecret } = parsed as Record<string, unknown>;
  if (v !== 1) throw new Error(`unsupported webhook secret version: ${String(v ?? "(none)")}`);
  if (typeof url !== "string" || !url) throw new Error("webhook channel has no url");
  if (typeof signingSecret !== "string" || !signingSecret) {
    throw new Error("webhook channel has no signing secret");
  }
  return { url, signingSecret };
}

/**
 * The body a receiver parses.
 *
 * `run.id` is deliberately absent. `deliver()` is called before `finish()`
 * writes the run row, so at the moment this payload is built there is no run id
 * to put in it — and inventing one here that the row later disagrees with is
 * worse than omitting it. What a receiver actually needs is an idempotency key,
 * and `deliveryId` is that: unique per POST, including per retry of a POST that
 * failed after the receiver had already processed it.
 *
 * `routine` and `run` are present on every event a routine produced and absent
 * on `routine.test`, which is sent from the channel's own screen before any
 * routine is attached to it. A receiver switches on `event` — the field that
 * exists to be switched on — rather than discovering the difference as two
 * undefined reads.
 */
export type WebhookPayload = {
  version: number;
  event: string;
  deliveryId: string;
  sentAt: string;
  routine?: { id: string; name: string; agentId: string };
  run?: { itemsNew: number; itemsOverflow: number; triggeredBy: string };
  subject: string;
  body: string;
};

export type PayloadInput = {
  event: string;
  deliveryId: string;
  sentAt: Date;
  routine?: { id: string; name: string; agentId: string };
  run?: { itemsNew: number; itemsOverflow: number; triggeredBy: string };
  subject: string;
  body: string;
};

export function buildWebhookPayload(input: PayloadInput): WebhookPayload {
  // Named field by field rather than spread from the input, so the wire format
  // is this list: adding a field to `PayloadInput` for some internal reason
  // cannot quietly widen a contract receivers are already written against.
  //
  // An absent routine is omitted rather than sent as null, so a receiver
  // checking `if (p.routine)` and one checking `if ("routine" in p)` agree.
  return {
    version: PAYLOAD_VERSION,
    event: input.event,
    deliveryId: input.deliveryId,
    sentAt: input.sentAt.toISOString(),
    ...(input.routine ? { routine: input.routine } : {}),
    ...(input.run ? { run: input.run } : {}),
    subject: input.subject,
    body: input.body,
  };
}

/**
 * The signature, over `v1:<timestamp>:<raw body>`.
 *
 * Byte-identical to Slack's scheme apart from the version string, and that is
 * the feature: a receiver that already verifies Slack — or that copies one of
 * the many snippets which do — works here by changing two names. The
 * alternative, a scheme of our own, would be no more secure and would have to
 * be explained from first principles in the documentation.
 *
 * The timestamp is inside the signed string so a captured body cannot be
 * replayed forever, and `rawBody` must be the exact bytes sent: re-serialising
 * the parsed JSON on either side produces a different string and a signature
 * that will not match.
 */
export async function signWebhookBody(
  signingSecret: string,
  timestampSeconds: number,
  rawBody: string,
): Promise<string> {
  const mac = await hmacSha256Hex(
    signingSecret,
    `${SIGNATURE_VERSION}:${timestampSeconds}:${rawBody}`,
  );
  return `${SIGNATURE_VERSION}=${mac}`;
}

/** The headers that go with a signed body. */
export function webhookHeaders(input: {
  event: string;
  deliveryId: string;
  timestampSeconds: number;
  signature: string;
}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": "covan-routines/1.0",
    [HEADER_EVENT]: input.event,
    [HEADER_DELIVERY]: input.deliveryId,
    [HEADER_TIMESTAMP]: String(input.timestampSeconds),
    [HEADER_SIGNATURE]: input.signature,
  };
}
