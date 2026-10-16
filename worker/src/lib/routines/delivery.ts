import type { SupabaseClient } from "@supabase/supabase-js";
import { sendEmail } from "../email";
import { emailShell } from "../email-layout";
import { renderMarkdown } from "../email-markdown";
import { decryptSecret } from "../secret-box";
import { pinnedRequest, readCapped, resolvesPublicly } from "./source";
import { assertFetchableUrl, ownHostsFrom } from "./url-guard";
import { UpstreamError } from "./upstream-error";
import {
  buildWebhookPayload,
  parseWebhookSecret,
  signWebhookBody,
  webhookHeaders,
  EVENT_DELIVERED,
} from "./webhook";
import { escapeMrkdwn } from "../slack/mrkdwn";
import { inboundDomain, replyLocalPart } from "../inbound-email/address";

export type DeliveryKind = "slack_webhook" | "email" | "webhook";

export type DeliveryChannel = {
  kind: DeliveryKind;
  secret_ciphertext: string;
  /**
   * When an email channel's address agreed to these messages (0096). Read by
   * `deliver` for email only, and absent counts as never: a caller that forgot
   * to select it sends nothing rather than mailing an address that never said
   * yes. `readyForDelivery` in `address-confirmation.ts` is how to get it.
   */
  confirmed_at?: string | null;
};

/** What `deliver` throws for an email address that has not confirmed. */
export const UNCONFIRMED_ADDRESS =
  "delivery failed: this address has not confirmed it wants these messages yet. " +
  "Covan has emailed it a link; once somebody there opens it, delivery starts.";

export type DeliveryDeps = {
  fetchImpl: typeof fetch;
  secretKey: string;
  resendApiKey: string;
  resendFrom: string;
  /** Hosts this service answers on — a channel must not be pointed at us. */
  ownHosts: string[];
  /** Overridden in tests so a signature is reproducible. */
  now?: () => Date;
  /**
   * `INBOUND_EMAIL_DOMAIN` where inbound mail is on (`inboundDomain`), else
   * absent: an emailed report then carries a Reply-To naming its run.
   */
  inboundDomain?: string | null;
};

/**
 * What a program on the other end is told about the run that produced this.
 *
 * Carried for every kind and used by one: Slack and email deliver prose to a
 * person, who has the routine's name in the subject and needs nothing else.
 */
export type DeliveryContext = {
  event: string;
  routine?: { id: string; name: string; agentId: string };
  run?: { itemsNew: number; itemsOverflow: number; triggeredBy: string };
  /**
   * The id the run's `routine_runs` row is written with. An emailed report
   * puts it in its Reply-To when inbound mail is on, so an answer finds the
   * report it answers. Kept out of `run`, which a webhook receiver is sent.
   */
  runId?: string;
  /** Set when this report answers a reply: the thread it belongs in. */
  thread?: EmailThread;
};

/**
 * The thread an answer to a reply belongs in: the reply's own Message-ID, the
 * chain before it, and the subject it was sent under.
 */
export type EmailThread = { inReplyTo: string; references: string; subject: string };

/** How much of a failing upstream's body reaches routine_runs.error. */
const MAX_ERROR_BODY = 200;

/**
 * How much of a response is read before the connection is dropped.
 *
 * Only the first 200 bytes are ever stored, so this is about what it costs to
 * *get* those bytes. A receiver that answers an error with a megabyte of HTML —
 * or with an endless stream — was previously read to completion and then
 * truncated, which spends the memory first and decides it was too much
 * afterwards. That is no cap at all, and the routine engine runs where memory
 * is the tightest.
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * How long a receiver has to answer.
 *
 * `source.ts`'s constant, for the same reason: a tick has other routines to
 * run, and an endpoint that holds the connection open costs the whole batch.
 */
const DELIVERY_TIMEOUT_MS = 10_000;

/** How much of the summary an inbox gets to show beside the subject. */
const MAX_PREHEADER = 140;

/**
 * The inbox preview line.
 *
 * Taken from the summary's own first line, with its Markdown stripped: left
 * unset, a client takes the opening of the HTML body, which for a digest that
 * starts with a heading is the heading — the subject again, twice on one row.
 */
function preheaderOf(body: string): string {
  const firstLine =
    body
      .split("\n")
      .map((line) => line.replace(/^[#>\-*\s]+/, "").trim())
      .find((line) => line.length > 0) ?? "";
  return firstLine.replace(/[*_`]/g, "").slice(0, MAX_PREHEADER);
}

/** The narrow slice of the Supabase client this module needs. */
export type DeliveryDb = Pick<SupabaseClient, "from">;

/** What an environment has to carry for a channel to be deliverable from it. */
export type DeliveryEnv = {
  ROUTINE_SECRET_KEY: string;
  RESEND_API_KEY: string;
  RESEND_FROM: string;
  ALLOWED_ORIGIN: string;
  WORKER_HOST?: string;
  INBOUND_EMAIL_DOMAIN?: string;
  RESEND_INBOUND_WEBHOOK_SECRET?: string;
};

/**
 * Build the deps from an environment.
 *
 * Two callers now — the routine engine on its tick, and the test-send button on
 * the channel's own screen — and the reason this is a function rather than two
 * object literals is `ownHosts`. A copy that forgets it does not fail: it
 * delivers, to anywhere, including back into this API.
 *
 * `fetch` has to be bound. The Workers runtime refuses to run global fetch with
 * a `this` that is not the global scope, so passing the bare reference down and
 * calling it as `deps.fetchImpl(...)` throws "Illegal invocation" — and only in
 * production, because Node's fetch is an ordinary function that does not care.
 */
export function deliveryDepsFrom(env: DeliveryEnv): DeliveryDeps {
  return {
    fetchImpl: fetch.bind(globalThis),
    secretKey: env.ROUTINE_SECRET_KEY,
    resendApiKey: env.RESEND_API_KEY,
    resendFrom: env.RESEND_FROM,
    ownHosts: ownHostsFrom(env),
    inboundDomain: inboundDomain(env),
  };
}

/**
 * Read enough of a failed response to say what went wrong, and no more.
 *
 * Never throws: this runs on the error path, and a body that cannot be read is
 * not a second, more interesting failure than the status that got us here.
 */
async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await readCapped(res, MAX_RESPONSE_BYTES)).slice(0, MAX_ERROR_BODY).trim();
  } catch {
    return "";
  }
}

/**
 * Turn a delivery response into nothing, or into the right kind of failure.
 *
 * The distinction is the one `executor.ts` pauses on. A 400 or a 404 or a 401
 * is a statement about this channel — the URL is wrong, the secret was revoked,
 * the endpoint was removed — and retrying it twenty times changes nothing, so
 * it counts against `MAX_FAILURES`. A 429 or a 5xx is a statement about the
 * receiver's afternoon, and pausing a working routine because somebody's API
 * gateway had a bad ten minutes is the failure mode that makes people stop
 * trusting the feature.
 *
 * This is a behaviour change for Slack and email as well as for the new kind:
 * before this, every delivery failure counted the same and five of them paused
 * the routine. A Slack outage could do that, and did not deserve to.
 */
async function assertDelivered(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await readErrorBody(res);
  if (res.status === 429 || res.status >= 500) throw new UpstreamError(res.status, body);
  throw new Error(`delivery failed: ${res.status} ${body}`.trim());
}

/**
 * POST the run to an endpoint the workspace chose.
 *
 * The guard runs twice in this feature's life: once when the channel is created
 * and again here, right before the body is sent. That is not belt and braces.
 * A channel is long-lived and DNS is not — a hostname that answered with a
 * public address in March can answer with `169.254.169.254` in September, and
 * the only check that catches it is the one that happens at delivery time.
 *
 * Every 3xx is refused rather than followed. A POST is not idempotent, so a
 * redirect is either a request to repeat a signed body at a host the signature
 * does not name, or — for 301/302 as every client actually implements them — a
 * request to drop the body and send a GET. Neither is a delivery. A receiver
 * that has moved should be re-pointed in the interface, where somebody can see
 * that it happened.
 */
async function postWebhook(
  secret: string,
  message: { subject: string; body: string },
  context: DeliveryContext,
  deps: DeliveryDeps,
): Promise<Response> {
  const config = parseWebhookSecret(secret);
  const url = assertFetchableUrl(config.url, deps.ownHosts);
  const address = await resolvesPublicly(url.hostname);

  const sentAt = (deps.now ?? (() => new Date()))();
  const deliveryId = crypto.randomUUID();
  const timestampSeconds = Math.floor(sentAt.getTime() / 1000);

  const payload = buildWebhookPayload({
    event: context.event,
    deliveryId,
    sentAt,
    routine: context.routine,
    run: context.run,
    subject: message.subject,
    body: message.body,
  });

  // Serialised once and signed as sent. Re-serialising for the signature — or
  // letting `fetch` serialise an object — produces a different string from the
  // one the receiver hashes, and the signature simply never matches.
  const rawBody = JSON.stringify(payload);
  const signature = await signWebhookBody(config.signingSecret, timestampSeconds, rawBody);

  const res = await deps.fetchImpl(
    ...pinnedRequest(url, address, {
      method: "POST",
      redirect: "manual",
      headers: webhookHeaders({
        event: context.event,
        deliveryId,
        timestampSeconds,
        signature,
      }),
      body: rawBody,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    }),
  );

  if (res.status >= 300 && res.status < 400) {
    const location = res.headers.get("Location") ?? "(no Location)";
    throw new Error(
      `delivery failed: ${res.status} redirect to ${location.slice(0, MAX_ERROR_BODY)} — ` +
        `a signed POST is not followed. Point the channel at the final URL.`,
    );
  }
  return res;
}

export async function deliver(
  channel: DeliveryChannel,
  message: { subject: string; body: string },
  deps: DeliveryDeps,
  context: DeliveryContext = { event: EVENT_DELIVERED },
): Promise<void> {
  // Before anything is decrypted or sent. Every caller funnels through here,
  // so this one check is what keeps an address that never agreed off the
  // receiving end of digests, tests and notices alike.
  if (channel.kind === "email" && !channel.confirmed_at) throw new Error(UNCONFIRMED_ADDRESS);

  const secret = await decryptSecret(channel.secret_ciphertext, deps.secretKey);
  const threading = channel.kind === "email" ? await emailThreading(context, deps) : {};

  const res =
    channel.kind === "webhook"
      ? await postWebhook(secret, message, context, deps)
      : channel.kind === "slack_webhook"
        ? await deps.fetchImpl(secret, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Escaped, not converted: the summary stays the Markdown it was
            // written as. But it is a model's summary of feed items somebody
            // else wrote, and unescaped, a `<!channel>` in a post was a ping
            // to the whole channel.
            body: JSON.stringify({
              text: `*${escapeMrkdwn(message.subject)}*\n${escapeMrkdwn(message.body)}`,
            }),
            // Not followed, for `postWebhook`'s reason. The address was checked
            // to be Slack's when the channel was made; a redirect is Slack
            // asking the body to go somewhere that check never saw. A 3xx is
            // not `ok`, so `assertDelivered` fails it.
            redirect: "manual",
            // Slack answers in milliseconds. This bounds the case where it does
            // not, which before this change could hold a whole tick open.
            signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
          })
        : await sendEmail(
            {
              to: secret,
              subject: context.thread?.subject ?? message.subject,
              text: message.body,
              // The summary is model output and arrives as Markdown, because
              // nothing in `summarise.ts` asks it not to. Rendering it here rather
              // than constraining the prompt keeps the text half exactly what the
              // model wrote — which is what Slack and the run record already show.
              html: emailShell({
                preheader: preheaderOf(message.body),
                heading: message.subject,
                bodyHtml: renderMarkdown(message.body),
                // Not "Sent by a Covan routine": the shell's own footer already
                // opens with "Sent by Covan", and the two stack into one column
                // that says it twice.
                footnote: threading.replyTo
                  ? "This digest was produced by a routine. Reply to it and the routine reads your answer and writes back."
                  : "This digest was produced by a routine running on its schedule.",
              }),
              replyTo: threading.replyTo,
              headers: threading.headers,
            },
            { fetchImpl: deps.fetchImpl, apiKey: deps.resendApiKey, from: deps.resendFrom },
          );

  await assertDelivered(res);
}

/**
 * Reserve the items about to be sent. The unique constraint on
 * (routine_id, item_key) means a concurrent or retried run gets back fewer
 * keys — only the ones it actually won — so nothing is delivered twice.
 *
 * Claim-then-send is deliberate. Send-then-record double-sends whenever the
 * record fails, and a duplicate message is the error users actually notice.
 */
export async function claimItemKeys(
  db: DeliveryDb,
  routineId: string,
  keys: string[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const { data, error } = await db
    .from("routine_deliveries")
    .upsert(
      keys.map((item_key) => ({ routine_id: routineId, item_key })),
      { onConflict: "routine_id,item_key", ignoreDuplicates: true },
    )
    .select("item_key");

  if (error) throw new Error(`claim failed: ${error.message}`);
  return (data ?? []).map((r: { item_key: string }) => r.item_key);
}

/** Hand the keys back after a failed send so the next run retries them. */
export async function releaseItemKeys(
  db: DeliveryDb,
  routineId: string,
  keys: string[],
): Promise<void> {
  if (keys.length === 0) return;
  const { error } = await db
    .from("routine_deliveries")
    .delete()
    .eq("routine_id", routineId)
    .in("item_key", keys);
  if (error) throw new Error(`release failed: ${error.message}`);
}

/**
 * What makes an emailed report answerable (`lib/inbound-email/`), when inbound
 * mail is on and the report came from a run.
 *
 * - **Reply-To** names the run, signed, so the answer comes back to this
 *   routine and to this report — and to nobody else's.
 * - **Message-ID** is the run's own, on the same domain, so an answer's
 *   `In-Reply-To` points at something we made.
 * - **In-Reply-To / References**, on an answer to a reply, keep it in the
 *   thread the person is already reading.
 * - **Auto-Submitted: auto-generated** asks out-of-office responders not to
 *   answer, which is the start of a loop (RFC 3834). The receiving side drops
 *   the ones that answer anyway.
 *
 * Notices (paused, out of credits) have no run, and get none of this: an
 * answer to "your routine was paused" has nothing to start.
 */
async function emailThreading(
  context: DeliveryContext,
  deps: DeliveryDeps,
): Promise<{ replyTo?: string; headers?: Record<string, string> }> {
  const domain = deps.inboundDomain;
  if (!domain || !context.runId) return {};
  const headers: Record<string, string> = {
    "Message-ID": `<run-${context.runId}@${domain}>`,
    "Auto-Submitted": "auto-generated",
  };
  if (context.thread) {
    headers["In-Reply-To"] = context.thread.inReplyTo;
    headers.References = context.thread.references;
  }
  return {
    replyTo: `${await replyLocalPart(deps.secretKey, context.runId)}@${domain}`,
    headers,
  };
}
