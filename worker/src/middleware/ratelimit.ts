import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";
import type { RateTier } from "../lib/ratelimit";
import { getRateLimiter } from "../lib/ratelimit";

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
 * `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed by the client on
 * that path. `X-Forwarded-For` can be, so it is used only as the fallback the
 * Docker deployment needs, and only its first entry. An unknown address is
 * counted under one shared key rather than waved through: better that a request
 * we cannot attribute shares a bucket than that "no address" becomes the way
 * around the limit.
 */
export function rateLimitKey(c: Context<AppEnv>): string {
  const user = c.get("user");
  if (user?.id) return `user:${user.id}`;

  const cf = c.req.header("CF-Connecting-IP");
  if (cf) return `ip:${cf}`;

  const forwarded = c.req.header("X-Forwarded-For");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return `ip:${first}`;

  return "ip:unknown";
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
