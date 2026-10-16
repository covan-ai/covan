import { Hono } from "hono";
import type { AppEnv } from "../types";
import { deferred } from "../lib/defer";
import { getRateLimiter } from "../lib/ratelimit";
import { readCapped } from "../lib/routines/source";
import { verifyComposioWebhook } from "../lib/composio/webhook";
import { countMiss, hasSpentMisses, refuseSpent } from "../middleware/ratelimit";
import { receiveEvent } from "../lib/routines/events/receive";
import { lapseSubscriptions } from "../lib/routines/events/lifecycle";
import { announceLapsedSubscription } from "../lib/routines/dispatcher";
import { cancelOrphanTrigger } from "../lib/routines/events/composio";

/**
 * `POST /composio/events` — Composio, telling us one of our triggers fired.
 *
 * One URL for the whole deployment, because that is how Composio delivers: a
 * project has one webhook subscription (`worker/scripts/composio-webhook-
 * subscribe.ts` makes it), and every trigger instance on every connected
 * account in the project is delivered there. Which routine a delivery is for is
 * the trigger instance's id in `metadata.trigger_id`, which
 * `routine_event_subscriptions.external_id` holds (0109).
 *
 * Unauthenticated in the Covan sense, like `routine-hooks.ts` and the Slack
 * events route: no session, no `auth.uid()`. What stands in for a caller is the
 * signature (`lib/composio/webhook.ts`) — and after it, `events/receive.ts`
 * decides whether the subscription and its routine are still running, exactly
 * as it does for every other provider.
 *
 * Three kinds of delivery are understood, and everything else is acknowledged
 * and dropped, so a new event kind turned on in Composio's dashboard does not
 * become a retry storm:
 *
 *   composio.trigger.message            a trigger fired
 *   composio.connected_account.expired  a grant lapsed; its routines are told
 *   composio.trigger.disabled           Composio switched a trigger off by
 *                                       itself (it does, when a grant lapses);
 *                                       its routines are told
 *   (anything else)                     200, nothing done
 */
export const composioEvents = new Hono<AppEnv>();

/**
 * How much body is read before the connection is dropped. A trigger's payload
 * is a description of one event — a mail's text, a calendar entry — and Gmail's
 * with a long thread quoted is the largest of them. 256 KB is room for that
 * and a ceiling on what a forged request costs to read before the signature
 * turns it away.
 */
const MAX_BODY_BYTES = 256 * 1024;

/** What a Composio trigger instance id looks like (`ti_…`). */
const TRIGGER_ID = /^[A-Za-z0-9_-]{1,128}$/;

type Delivery = {
  id?: unknown;
  type?: unknown;
  metadata?: { trigger_id?: unknown; trigger_slug?: unknown; connected_account_id?: unknown };
  data?: unknown;
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

composioEvents.post("/composio/events", async (c) => {
  if (hasSpentMisses(c)) return refuseSpent(c);

  const secret = c.env.COMPOSIO_WEBHOOK_SECRET ?? "";
  // Unset means this deployment never asked Composio for deliveries; there is
  // nothing to verify against, and answering 404 says so without a lookup.
  if (!secret) return c.json({ error: "not found" }, 404);

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

  // The signature before the body is so much as parsed. A failure costs one
  // HMAC and is counted against the address, which is all an address is good
  // for here: Composio delivers for every customer it has from a few of them.
  const check = await verifyComposioWebhook(
    secret,
    {
      id: c.req.header("webhook-id"),
      timestamp: c.req.header("webhook-timestamp"),
      signature: c.req.header("webhook-signature"),
    },
    body,
  );
  if (!check.ok) {
    await countMiss(c);
    return c.json({ error: "invalid signature" }, 401);
  }

  let delivery: Delivery;
  try {
    delivery = JSON.parse(body) as Delivery;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }
  if (!delivery || typeof delivery !== "object") return c.json({ error: "invalid json" }, 400);

  const type = str(delivery.type);

  if (type === "composio.connected_account.expired") {
    const accountId = connectedAccountOf(delivery);
    if (accountId) {
      deferred(
        c,
        lapseSubscriptions(
          c.env,
          { state: { connectedAccountId: accountId } },
          "The app's connection expired.",
          { announce: announceLapsedSubscription },
        ),
      );
    }
    return c.json({ ok: true });
  }

  if (type === "composio.trigger.disabled") {
    const data = delivery.data as Record<string, unknown> | null | undefined;
    const triggerId = data && typeof data === "object" ? str(data.id) : "";
    if (TRIGGER_ID.test(triggerId)) {
      deferred(
        c,
        lapseSubscriptions(
          c.env,
          { provider: "composio", externalId: triggerId },
          "The app stopped sending events, usually because its connection expired.",
          { announce: announceLapsedSubscription },
        ),
      );
    }
    return c.json({ ok: true });
  }

  if (type !== "composio.trigger.message") return c.json({ ok: true, ignored: true });

  // Checked for shape as well as presence: it is matched in a PostgREST filter
  // further down (`cancelOrphanTrigger`), and an id is letters, digits, `_`
  // and `-` — anything else is not one of Composio's.
  const triggerId = str(delivery.metadata?.trigger_id);
  if (!TRIGGER_ID.test(triggerId)) return c.json({ ok: true, ignored: true });

  // Counted per trigger instance, which names one routine: the row that
  // spends its workspace's credits every time this fires — `routine-hooks.ts`'s
  // reasoning about tokens, with Composio's id in the token's place. The
  // flood fuse in `receive.ts` is the real bound; this stops a burst before it
  // reaches the database at all.
  const verdict = await getRateLimiter(c.env, "expensive").check(`composio-trigger:${triggerId}`);
  if (!verdict.allowed) {
    c.header("Retry-After", String(verdict.retryAfterSeconds));
    return c.json({ error: "rate_limited" }, 429);
  }

  const outcome = await receiveEvent(
    c.env,
    { provider: "composio", externalId: triggerId },
    delivery,
    { defer: (work) => deferred(c, work) },
  );

  // A trigger nothing here is waiting for: a routine deleted while Composio
  // was unreachable, or a subscription that was replaced. Ended at the source,
  // so it stops costing a delivery — see `cancelOrphanTrigger` for the one
  // case where that would be wrong and how it is told apart.
  if (outcome.status === "unknown") deferred(c, cancelOrphanTrigger(c.env, triggerId));

  // 200 for every outcome: an event that was filtered out or arrived for a
  // paused routine is handled, and telling Composio otherwise would only have
  // it sent again.
  return c.json({ ok: true, status: outcome.status });
});

/**
 * Which connected account an expiry is about. Read from both places it has
 * been seen — `metadata` on a trigger-shaped delivery, `data` on an account
 * event — because a lapse missed is a routine that goes quiet without anybody
 * being told.
 */
function connectedAccountOf(delivery: Delivery): string {
  const fromMetadata = str(delivery.metadata?.connected_account_id);
  if (fromMetadata) return fromMetadata;
  const data = delivery.data as Record<string, unknown> | null | undefined;
  if (!data || typeof data !== "object") return "";
  return str(data.connected_account_id) || str(data.id) || str(data.nanoid);
}
