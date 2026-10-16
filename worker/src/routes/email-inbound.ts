import { Hono } from "hono";
import type { AppEnv } from "../types";
import { deferred } from "../lib/defer";
import { getRateLimiter } from "../lib/ratelimit";
import { readCapped } from "../lib/routines/source";
import { countMiss, hasSpentMisses, refuseSpent } from "../middleware/ratelimit";
import {
  inboundDomain,
  localPartsOn,
  runOfReply,
  tokenOfAgentLocalPart,
} from "../lib/inbound-email/address";
import {
  RECEIVED_ID,
  fetchReceivedEmail,
  isAutomatic,
  passesAuthentication,
  verifyResendWebhook,
  type ReceivedEmail,
} from "../lib/inbound-email/resend";
import { receiveEvent } from "../lib/routines/events/receive";
import { receiveReply } from "../lib/routines/replies";
import { startPokedRun } from "../lib/routines/poke-room";

/**
 * `POST /email/inbound` — Resend, telling us mail arrived on
 * `INBOUND_EMAIL_DOMAIN`.
 *
 * One URL for the deployment, like `/composio/events`: Resend's receiving
 * webhook delivers every message on the domain here, and which routine it is
 * for is the address it was sent to (`lib/inbound-email/address.ts`):
 *
 *   r-<run><mac>@…        an answer to a routine's report (`receiveReply`)
 *   <name>-<token>@…      mail to a routine's own address (`receiveEvent`,
 *                         provider `email`)
 *
 * Unauthenticated in the Covan sense, like the other doors. What stands in for
 * a caller is, in order: Resend's signature (Svix's scheme, `whsec_` secret),
 * checked before the body is parsed; the sender's domain having vouched for
 * the message (SPF, DKIM, DMARC, as the receiving server judged them); and the
 * address, whose token only this deployment can have made. An auto-reply is
 * dropped before any of it starts anything (`isAutomatic`).
 *
 * Off — 404 — unless `INBOUND_EMAIL_DOMAIN`, `RESEND_INBOUND_WEBHOOK_SECRET`
 * and `RESEND_API_KEY` are all set: the webhook carries no body, and reading
 * the message needs the API key.
 */
export const emailInbound = new Hono<AppEnv>();

/**
 * The webhook body is an envelope — addresses, a subject, attachment names —
 * so it is small. 64 KB is room for a message sent to a long list, and the
 * ceiling on what a forged request costs to read.
 */
const MAX_BODY_BYTES = 64 * 1024;

/** A message to more of our addresses than this is not somebody writing to a routine. */
const MAX_RECIPIENTS = 5;

type Envelope = {
  type?: unknown;
  data?: { email_id?: unknown; to?: unknown; cc?: unknown; received_for?: unknown };
};

function addresses(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

emailInbound.post("/email/inbound", async (c) => {
  if (hasSpentMisses(c)) return refuseSpent(c);

  const domain = inboundDomain(c.env);
  const secret = c.env.RESEND_INBOUND_WEBHOOK_SECRET ?? "";
  if (!domain || !c.env.RESEND_API_KEY) return c.json({ error: "not found" }, 404);

  const announced = Number(c.req.header("Content-Length") ?? "");
  if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }
  let body: string;
  try {
    body = await readCapped(c.req.raw, MAX_BODY_BYTES);
  } catch {
    return c.json({ error: "payload too large" }, 413);
  }

  const check = await verifyResendWebhook(
    secret,
    {
      id: c.req.header("svix-id"),
      timestamp: c.req.header("svix-timestamp"),
      signature: c.req.header("svix-signature"),
    },
    body,
  );
  if (!check.ok) {
    await countMiss(c);
    return c.json({ error: "invalid signature" }, 401);
  }

  let envelope: Envelope;
  try {
    envelope = JSON.parse(body) as Envelope;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  // Anything but a received message (a sent mail's delivery report, should
  // the webhook be set to send those) is acknowledged and dropped.
  if (envelope?.type !== "email.received") return c.json({ ok: true, ignored: true });

  const emailId = typeof envelope.data?.email_id === "string" ? envelope.data.email_id : "";
  if (!RECEIVED_ID.test(emailId)) return c.json({ error: "no email id" }, 400);

  const locals = localPartsOn(domain, [
    ...addresses(envelope.data?.to),
    ...addresses(envelope.data?.cc),
    ...addresses(envelope.data?.received_for),
  ]).slice(0, MAX_RECIPIENTS);
  if (locals.length === 0) return c.json({ ok: true, ignored: true });

  // The message itself. A failure here is answered with an error, so Resend
  // delivers again later rather than the mail being lost.
  let email: ReceivedEmail;
  try {
    email = await fetchReceivedEmail(c.env.RESEND_API_KEY, emailId);
  } catch (err) {
    console.error("could not read a received email", err);
    return c.json({ error: "could not read the message" }, 502);
  }
  if (!passesAuthentication(email)) return c.json({ ok: true, status: "unauthenticated" });
  if (isAutomatic(email)) return c.json({ ok: true, status: "automatic" });

  const run = (
    _env: unknown,
    routine: Parameters<typeof startPokedRun>[1],
    trigger: Parameters<typeof startPokedRun>[2],
  ) => startPokedRun(c.env, routine, trigger);
  const defer = (work: Promise<unknown>) => deferred(c, work);

  const results: string[] = [];
  for (const local of locals) {
    // Per address: one report's Reply-To, or one routine's own address, is one
    // routine's spend — `routine-hooks.ts`' reasoning about a token.
    const verdict = await getRateLimiter(c.env, "expensive").check(`email-in:${local}`);
    if (!verdict.allowed) {
      results.push("rate_limited");
      continue;
    }

    if (local.startsWith("r-")) {
      const runId = await runOfReply(c.env.ROUTINE_SECRET_KEY, local);
      if (!runId) {
        // A Reply-To this deployment never made.
        await countMiss(c);
        results.push("unknown");
        continue;
      }
      const outcome = await receiveReply(c.env, runId, email, { defer, run });
      results.push(outcome.status);
      continue;
    }

    const token = tokenOfAgentLocalPart(local);
    if (!token) {
      results.push("unknown");
      continue;
    }
    const outcome = await receiveEvent(
      c.env,
      { provider: "email", externalId: token },
      { email },
      {
        defer,
        run,
      },
    );
    if (outcome.status === "unknown") await countMiss(c);
    results.push(outcome.status);
  }

  // 200 whatever happened to each: a message that reached nobody is handled,
  // and an error would only have Resend send it again.
  return c.json({ ok: true, results });
});
