import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import type { RateTier } from "../lib/ratelimit";
import { getRateLimiter, RATE_PERIOD_SECONDS } from "../lib/ratelimit";

/**
 * The address of whoever is on the other end, as far as this runtime can know
 * it — or `null` when it cannot.
 *
 * On Cloudflare, `CF-Connecting-IP`: the edge sets it and overwrites anything a
 * client sent under that name. On Node there is no edge, and that same header
 * is just text a client typed — believing it made every request a new caller
 * with a new allowance. So on Node (`PEER_ADDR` present, which `node.ts`
 * guarantees) the socket is the caller, unless the operator has said how many
 * proxies stand in front (`TRUST_PROXY`). Each proxy appends the address it was
 * handed to `X-Forwarded-For`, so with N trusted proxies the caller is the Nth
 * entry from the right; everything left of that is the client's own claim. A
 * header shorter than N stops at its leftmost entry, the way Express's
 * `trust proxy` does.
 */
export function clientAddress(c: Context<AppEnv>): string | null {
  const peer = c.env?.PEER_ADDR;
  if (peer === undefined) return c.req.header("CF-Connecting-IP")?.trim() || null;

  const hops = trustedHops(c.env.TRUST_PROXY);
  if (hops === 0) return peer || null;

  const forwarded = (c.req.header("X-Forwarded-For") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const chain = [peer, ...forwarded.reverse()];
  return chain[Math.min(hops, chain.length - 1)] || null;
}

/** `TRUST_PROXY` as a hop count. Anything that is not a whole number is none. */
function trustedHops(raw: string | undefined): number {
  const n = Number(raw ?? "");
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/**
 * Who to count this request against.
 *
 * After `authMiddleware` there is a user, and the user is the right key: a
 * limit keyed by address would punish a whole office for one person's loop, and
 * reward anyone with more than one address. Before it there is not, so the
 * caller's address is all there is — which is also the point, because the token
 * check itself costs a round trip to Supabase and something has to bound how
 * often that can be provoked.
 *
 * An unknown address is counted under one shared key rather than waved through:
 * better that a request we cannot attribute shares a bucket than that "no
 * address" becomes the way around the limit.
 */
export function rateLimitKey(c: Context<AppEnv>): string {
  const user = c.get("user");
  if (user?.id) return `user:${user.id}`;
  return `ip:${clientAddress(c) ?? "unknown"}`;
}

/**
 * Refuse a request that has asked too often.
 *
 * `standard` goes in front of everything, including the token check.
 * `expensive` goes in front of the two routes that spend money at OpenAI, and
 * is the one that matters — see `lib/ratelimit/types.ts` for what each is for.
 *
 * 429 with `Retry-After`, because a client that is told to back off can, and one
 * that is handed a bare error retries immediately and makes it worse.
 */
export function rateLimit(tier: RateTier): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const limiter = getRateLimiter(c.env, tier);
    const verdict = await limiter.check(`${tier}:${rateLimitKey(c)}`);

    if (!verdict.allowed) {
      c.header("Retry-After", String(verdict.retryAfterSeconds));
      return c.json({ error: "rate_limited" }, 429);
    }

    await next();
  };
}

/**
 * The doors that check their own proof — a Slack signature, an ingest token —
 * and so stand in front of the per-address limit rather than behind it.
 *
 * They have to. Slack and GitHub deliver from a handful of shared addresses, so
 * a limit keyed by address counts every tenant's deliveries together: one
 * workspace's busy repository spent everybody's allowance, and the 429s landed
 * on strangers. Behind the proof there is something better to count by — the
 * Slack team, the routine — and each door counts by that.
 *
 * What the address still bounds is the cost of failing the proof, which for an
 * ingest token is a database lookup. Only failures are counted, so a sender
 * whose deliveries verify never spends anything here however busy it is. Once
 * an address has failed `standard`'s allowance in a window it is remembered
 * until the window ends and refused before the lookup — the limiter itself
 * cannot be asked without being charged, so this map is what turns its "no"
 * into a refusal at the door. On Cloudflare the map is per isolate: the binding
 * is still the count, and the map only saves the lookups after it has spoken.
 */
const spentAddresses = new Map<string, number>();
const MAX_REMEMBERED = 10_000;

/** Exposed for tests. */
export function resetMisses(): void {
  spentAddresses.clear();
}

/** Whether this address has failed a door's proof too often to be asked again yet. */
export function hasSpentMisses(c: Context<AppEnv>, now = Date.now()): boolean {
  const key = `ip:${clientAddress(c) ?? "unknown"}`;
  const until = spentAddresses.get(key);
  if (until === undefined) return false;
  if (now < until) return true;
  spentAddresses.delete(key);
  return false;
}

/** Counts one failed proof against the caller's address. */
export async function countMiss(c: Context<AppEnv>, now = Date.now()): Promise<void> {
  const key = `ip:${clientAddress(c) ?? "unknown"}`;
  const verdict = await getRateLimiter(c.env, "standard").check(`standard:miss:${key}`);
  if (verdict.allowed) return;
  if (spentAddresses.size >= MAX_REMEMBERED) {
    const oldest = spentAddresses.keys().next().value;
    if (oldest !== undefined) spentAddresses.delete(oldest);
  }
  spentAddresses.set(key, now + verdict.retryAfterSeconds * 1000);
}

/** The refusal both doors give a spent address. */
export function refuseSpent(c: Context<AppEnv>): Response {
  c.header("Retry-After", String(RATE_PERIOD_SECONDS));
  return c.json({ error: "rate_limited" }, 429);
}
