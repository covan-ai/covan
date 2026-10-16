import { Hono } from "hono";
import type { AppEnv } from "../types";
import type { ProviderEnv } from "../lib/connections/types";
import { deferred } from "../lib/defer";
import { hmacSha256Hex, timingSafeEqual } from "../lib/hmac";
import { getRateLimiter } from "../lib/ratelimit";
import { readCapped } from "../lib/routines/source";
import { countMiss, hasSpentMisses, refuseSpent } from "../middleware/ratelimit";
import { receiveEvent, type ReceiveOutcome } from "../lib/routines/events/receive";
import { NOTION_EVENTS, botsOf } from "../lib/routines/events/notion";
import { startPokedRun } from "../lib/routines/poke-room";

/**
 * `POST /notion/events` — Notion, telling us a page changed somewhere our
 * public integration is installed.
 *
 * One URL for the whole deployment, set up once in the integration's settings
 * (Notion → the integration → Webhooks). Which routines a delivery is for is
 * which connections can see the page: `accessible_by` names their bots, and
 * each subscription holds its connection's bot (`events/notion.ts`).
 *
 * THE HANDSHAKE, AND WHY THE TOKEN IS LOGGED. When the subscription is made,
 * Notion POSTs one `{ verification_token }` here, unsigned, and waits for
 * somebody to paste that token into its Verify form; from then on every
 * delivery is signed with it (`X-Notion-Signature: sha256=<hex>`, an HMAC of
 * the raw body keyed with the token). There is nowhere in Covan for an
 * operator to read a value Notion sent, and no session on this request to
 * show it to — so while `NOTION_WEBHOOK_VERIFICATION_TOKEN` is unset, the
 * route writes the token to the Worker's log, which only the operator reads.
 * They paste it into Notion, and set it as the secret. A token somebody else
 * posted would be logged too, and would fail at Notion's Verify form, which is
 * the check that matters: only the token Notion issued verifies.
 *
 * Unset, nothing but that handshake is accepted, and the events are not
 * offered (`NOTION_ADAPTER.isConfigured`). Set, an unsigned or wrongly signed
 * delivery is a 401 counted against the address.
 */
export const notionEvents = new Hono<AppEnv>();

/** A page event is ids and a timestamp; this is room for that many times over. */
const MAX_BODY_BYTES = 64 * 1024;

/** How many connections one delivery is offered to. */
const MAX_BOTS = 10;

const HANDLED = new Set(NOTION_EVENTS.map((s) => s.notionType));

const RANK: Record<ReceiveOutcome["status"], number> = {
  accepted: 0,
  flood: 1,
  filtered: 2,
  ignored: 3,
  inactive: 4,
  unknown: 5,
  forged: 6,
};

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

notionEvents.post("/notion/events", async (c) => {
  if (hasSpentMisses(c)) return refuseSpent(c);
  // No Notion on this deployment at all: there is no integration to deliver.
  if (!(c.env as typeof c.env & ProviderEnv).NOTION_CLIENT_ID) {
    return c.json({ error: "not found" }, 404);
  }

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
  let delivery: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("shape");
    delivery = parsed as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  const secret = c.env.NOTION_WEBHOOK_VERIFICATION_TOKEN ?? "";
  const signature = c.req.header("X-Notion-Signature") ?? "";

  // The handshake: unsigned, carrying the token. Logged for the operator —
  // see the header for why here — and acknowledged. Also accepted once
  // configured, for Notion's "Resend token" after a rotation.
  const offered = str(delivery.verification_token);
  if (!signature && /^secret_[A-Za-z0-9_-]{10,200}$/.test(offered)) {
    console.log(
      `Notion webhook verification token: ${offered} — paste it into the integration's ` +
        "Verify form, then set it as NOTION_WEBHOOK_VERIFICATION_TOKEN on both Workers.",
    );
    return c.json({ ok: true });
  }
  if (!secret) {
    await countMiss(c);
    return c.json({ error: "not found" }, 404);
  }

  const expected = `sha256=${await hmacSha256Hex(secret, body)}`;
  if (!timingSafeEqual(expected, signature)) {
    await countMiss(c);
    return c.json({ error: "invalid signature" }, 401);
  }

  const type = str(delivery.type);
  if (!HANDLED.has(type)) return c.json({ ok: true, ignored: true });

  // Counted per Notion workspace: one workspace's burst of edits is one
  // team's spend, and the flood fuse in `receive.ts` is the real bound.
  const workspace = str(delivery.workspace_id) || "unknown";
  const verdict = await getRateLimiter(c.env, "expensive").check(`notion-workspace:${workspace}`);
  if (!verdict.allowed) {
    c.header("Retry-After", String(verdict.retryAfterSeconds));
    return c.json({ error: "rate_limited" }, 429);
  }

  const outcomes: ReceiveOutcome[] = [];
  for (const bot of botsOf(delivery).slice(0, MAX_BOTS)) {
    outcomes.push(
      await receiveEvent(c.env, { provider: "notion", externalId: bot }, delivery, {
        defer: (work) => deferred(c, work),
        run: (_env, routine, trigger) => startPokedRun(c.env, routine, trigger),
      }),
    );
  }
  // 200 whatever happened: a page nobody listens to is handled, and telling
  // Notion otherwise only has it retried for a day.
  const best = outcomes.sort((a, b) => RANK[a.status] - RANK[b.status])[0];
  return c.json({ ok: true, status: best?.status ?? "unknown" });
});
