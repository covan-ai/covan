import type { RateLimiter, RateVerdict } from "./types";
import { RATE_PERIOD_SECONDS } from "./types";

/**
 * Cloudflare's rate limiting binding.
 *
 * The counter lives in the edge rather than in the isolate, which is the whole
 * point: a Worker gets a fresh isolate whenever the runtime feels like it, and
 * there are many of them, so the in-process counter that is correct under Docker
 * would be close to no limit at all here.
 *
 * The limit and the window are declared in `wrangler.toml` under `[[ratelimits]]`
 * and cannot be read back at runtime — `limit()` answers `{ success }` and
 * nothing else. So `retryAfterSeconds` is the window we were told about at
 * construction; keep it in step with the `simple.period` in that file. The
 * binding accepts only 10 or 60, and `RATE_PERIOD_SECONDS` is 60.
 */
export function cloudflareRateLimiter(
  binding: RateLimit,
  periodSeconds: number = RATE_PERIOD_SECONDS,
): RateLimiter {
  return {
    async check(key: string): Promise<RateVerdict> {
      try {
        const { success } = await binding.limit({ key });
        return success ? { allowed: true } : { allowed: false, retryAfterSeconds: periodSeconds };
      } catch (err) {
        // Fail open. This limiter guards a bill, not a door: every route behind
        // it has already checked a bearer token, and refusing every request
        // because the limiter is unavailable would convert a Cloudflare hiccup
        // into an outage of our own. Logged so it is not silent.
        console.error("rate limiter unavailable, allowing request", err);
        return { allowed: true };
      }
    },
  };
}
