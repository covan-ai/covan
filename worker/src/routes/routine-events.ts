import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import { deferred } from "../lib/defer";
import { getRateLimiter } from "../lib/ratelimit";
import { readCapped } from "../lib/routines/source";
import { countMiss, hasSpentMisses, refuseSpent } from "../middleware/ratelimit";
import { receiveEvent } from "../lib/routines/events/receive";
import { GITHUB_HOOK_ID, type GitHubDelivery } from "../lib/routines/events/github";
import { WEBSUB_HOOK_ID, isOurIntent, type WebSubDelivery } from "../lib/routines/events/websub";
import { DRIVE_CHANNEL_ID, type DriveNotification } from "../lib/routines/events/drive";
import type { EventProvider } from "../lib/routines/events/catalog";
import { startPokedRun } from "../lib/routines/poke-room";
import {
  TELEGRAM_HOOK_ID,
  webhookToken,
  type TelegramDelivery,
} from "../lib/routines/events/telegram";
import { timingSafeEqual } from "../lib/hmac";

/**
 * The doors for providers that sign each subscription's deliveries with that
 * subscription's own secret: a GitHub repository's webhook, a WebSub hub, and a
 * Google Drive channel.
 *
 *   POST /routine-events/github/:id    a push, a pull request, an issue
 *   GET  /routine-events/websub/:id    a hub checking we asked (the challenge)
 *   POST /routine-events/websub/:id    a hub pushing a feed that changed
 *   POST /routine-events/drive/:id     a Drive channel saying something changed
 *   POST /routine-events/telegram/:id  a message to a person's own bot
 *
 * Telegram is the exception to what follows: its secret is derived from the
 * id in the path (`webhookToken`), so that door checks it before any lookup,
 * as `/composio/events` does. See `events/telegram.ts`.
 *
 * Unlike `/composio/events`, which checks one deployment-wide signature
 * before reading anything, these cannot know the secret until they know the
 * subscription — so the id in the path finds the row, and the adapter's
 * `authenticate` checks the signature in `receive.ts` before anything about
 * the routine is consulted.
 *
 * WHAT IS NOT COUNTED AGAINST THE ADDRESS. GitHub, Google and Telegram each
 * deliver for every one of their customers from a few shared addresses, and
 * `countMiss` charges an address, not a subscription. A webhook left in a
 * repository after its routine was deleted, or one set up with a mistyped
 * secret, sends a failing delivery on every push; counted against the address,
 * a handful of those would refuse every other customer's GitHub deliveries,
 * and Slack's and Composio's from the same refusal list. So a delivery that
 * reaches `receiveEvent` is never counted, whatever it turns out to be. What
 * bounds it instead: the id is 192 random bits, so there is nothing to guess;
 * each id has its own expensive-tier allowance, taken before the lookup; and an
 * id that is not even the right shape is still counted, because no provider of
 * ours ever sends one.
 *
 * Unauthenticated in the Covan sense, like the other doors: no session and no
 * `auth.uid()`. The id and the signature are what stand in for a caller.
 */
export const routineEvents = new Hono<AppEnv>();

/**
 * How much body is read. A GitHub push with many commits is the largest
 * thing that arrives here — GitHub caps a payload at 25 MB, and a push that
 * size is not something a routine should read anyway — and a fat WebSub ping
 * is a feed. 1 MB is room for an ordinary push of a few hundred commits, and
 * the ceiling on what a forged request costs to read.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Read the body under the cap, or answer for it. Content-Length first, so a
 * sender announcing too much is turned away without a byte read.
 */
async function cappedBody(c: Context<AppEnv>): Promise<string | Response> {
  const announced = Number(c.req.header("Content-Length") ?? "");
  if (Number.isFinite(announced) && announced > MAX_BODY_BYTES) {
    return c.json({ error: "payload too large" }, 413);
  }
  try {
    return await readCapped(c.req.raw, MAX_BODY_BYTES);
  } catch {
    return c.json({ error: "payload too large" }, 413);
  }
}

/**
 * The rest of a delivery's road, the same for both providers: the per-
 * subscription expensive tier (one subscription is one routine's spend, the
 * reasoning `routine-hooks.ts` gives for a token), then `receiveEvent`, then an
 * answer the provider can act on.
 */
async function deliver(
  c: Context<AppEnv>,
  provider: EventProvider,
  id: string,
  raw: GitHubDelivery | WebSubDelivery | DriveNotification | TelegramDelivery,
  options: { unknown?: "not found" | "ok" } = {},
): Promise<Response> {
  const verdict = await getRateLimiter(c.env, "expensive").check(`${provider}-hook:${id}`);
  if (!verdict.allowed) {
    c.header("Retry-After", String(verdict.retryAfterSeconds));
    return c.json({ error: "rate_limited" }, 429);
  }

  const outcome = await receiveEvent(c.env, { provider, externalId: id }, raw, {
    defer: (work) => deferred(c, work),
    run: (_env, routine, trigger) => startPokedRun(c.env, routine, trigger),
  });

  // A URL nothing holds. GitHub shows a 404 against the webhook, which is the
  // person's cue to remove a webhook whose routine is gone, and a hub reads it
  // as "stop pushing". A Drive channel or a Telegram bot left behind is
  // answered 200 instead: a Drive channel that could not be stopped keeps
  // calling for up to a week whatever it is told, and Telegram retries
  // anything else. Neither is counted; see the header.
  if (outcome.status === "unknown") {
    if (options.unknown === "ok") return c.json({ ok: true, status: "unknown" });
    return c.json({ error: "not found" }, 404);
  }
  if (outcome.status === "forged") return c.json({ error: "invalid signature" }, 401);
  // Every other outcome is handled, and a provider told otherwise retries.
  return c.json({ ok: true, status: outcome.status });
}

routineEvents.post("/routine-events/github/:id", async (c) => {
  if (hasSpentMisses(c)) return refuseSpent(c);
  const id = c.req.param("id");
  if (!GITHUB_HOOK_ID.test(id)) {
    await countMiss(c);
    return c.json({ error: "not found" }, 404);
  }
  const body = await cappedBody(c);
  if (typeof body !== "string") return body;
  return deliver(c, "github", id, {
    event: c.req.header("X-GitHub-Event") ?? "",
    delivery: c.req.header("X-GitHub-Delivery") ?? "",
    signature: c.req.header("X-Hub-Signature-256") ?? "",
    body,
  });
});

/**
 * A hub asking whether we really want this topic — after a subscribe, an
 * unsubscribe, and on its own schedule before a lease is renewed. Answered
 * from the URL alone (`isOurIntent`), because the first of these can arrive
 * before the subscribe that caused it has written anything; see
 * `events/websub.ts`. The challenge is echoed as plain text, which is the
 * whole protocol; anything else is a 404, which a hub reads as "no".
 */
routineEvents.get("/routine-events/websub/:id", async (c) => {
  if (hasSpentMisses(c)) return refuseSpent(c);
  const id = c.req.param("id");
  const mode = c.req.query("hub.mode") ?? "";
  const topic = c.req.query("hub.topic") ?? "";
  const challenge = c.req.query("hub.challenge") ?? "";
  const token = c.req.query("t") ?? "";
  if (
    !WEBSUB_HOOK_ID.test(id) ||
    (mode !== "subscribe" && mode !== "unsubscribe") ||
    !topic ||
    !challenge ||
    challenge.length > 512 ||
    !(await isOurIntent(c.env, id, topic, token))
  ) {
    await countMiss(c);
    return c.json({ error: "not found" }, 404);
  }
  return c.text(challenge, 200);
});

routineEvents.post("/routine-events/websub/:id", async (c) => {
  if (hasSpentMisses(c)) return refuseSpent(c);
  const id = c.req.param("id");
  if (!WEBSUB_HOOK_ID.test(id)) {
    await countMiss(c);
    return c.json({ error: "not found" }, 404);
  }
  const body = await cappedBody(c);
  if (typeof body !== "string") return body;
  return deliver(c, "websub", id, {
    signature: c.req.header("X-Hub-Signature") ?? "",
    body,
  });
});

/**
 * A Drive channel saying "look again" (`events/drive.ts`). The body is empty;
 * the channel's token comes back in a header and is the subscription's secret.
 * The channel's first message, `sync`, asks nothing and can arrive before the
 * subscribe that made the channel has written its id, so it is acknowledged
 * without a lookup.
 */
routineEvents.post("/routine-events/drive/:id", async (c) => {
  if (hasSpentMisses(c)) return refuseSpent(c);
  const id = c.req.param("id");
  if (!DRIVE_CHANNEL_ID.test(id)) {
    await countMiss(c);
    return c.json({ error: "not found" }, 404);
  }
  const state = c.req.header("X-Goog-Resource-State") ?? "";
  if (state === "sync") return c.json({ ok: true });
  return deliver(
    c,
    "google_drive",
    id,
    { token: c.req.header("X-Goog-Channel-Token") ?? "", state },
    { unknown: "ok" },
  );
});

routineEvents.post("/routine-events/telegram/:id", async (c) => {
  if (hasSpentMisses(c)) return refuseSpent(c);
  const id = c.req.param("id");
  const given = c.req.header("X-Telegram-Bot-Api-Secret-Token") ?? "";
  // The token is checked before the body is read and before any lookup: it
  // is an HMAC of the id, so nothing about a row is needed to know whether
  // this came from a webhook this deployment set.
  if (
    !TELEGRAM_HOOK_ID.test(id) ||
    !c.env.ROUTINE_SECRET_KEY ||
    !timingSafeEqual(await webhookToken(c.env, id), given)
  ) {
    await countMiss(c);
    return c.json({ error: "invalid signature" }, 401);
  }
  const body = await cappedBody(c);
  if (typeof body !== "string") return body;
  return deliver(c, "telegram", id, { body }, { unknown: "ok" });
});
