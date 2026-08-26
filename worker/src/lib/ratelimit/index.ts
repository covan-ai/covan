import type { Bindings } from "../../types";
import type { RateLimiter, RateTier } from "./types";
import { DEFAULT_LIMITS, RATE_PERIOD_SECONDS } from "./types";
import { cloudflareRateLimiter } from "./cloudflare";
import { memoryRateLimiter } from "./memory";

export type { RateLimiter, RateTier, RateVerdict } from "./types";
export { RATE_PERIOD_SECONDS, DEFAULT_LIMITS } from "./types";

/** Allows everything. What an operator gets when they set a limit of 0. */
export const unlimitedRateLimiter: RateLimiter = {
  async check() {
    return { allowed: true };
  },
};

/**
 * The Node limiters have to outlive the request.
 *
 * `memoryRateLimiter` closes over its own Map, so building one per request would
 * count every request as the first one and limit nothing at all — a bug that
 * passes every unit test of the limiter itself and shows up only as a limit that
 * never trips. They are cached here, keyed by tier and configured limit so a
 * test that changes the limit gets a fresh counter rather than a stale one.
 *
 * There is no equivalent concern on Cloudflare: the binding is the counter, and
 * the wrapper around it holds nothing.
 */
const processLimiters = new Map<string, RateLimiter>();

/** Exposed for tests. Production never needs it — the process is the lifetime. */
export function resetRateLimiters(): void {
  processLimiters.clear();
}

/**
 * How many requests per minute this tier allows, from the environment.
 *
 * Only the Node runtime reads this. On Cloudflare the number lives in
 * `wrangler.toml`, because the binding owns the counter and there is nowhere
 * else to put it.
 *
 * `0` means unlimited, and is the documented way for an operator who rate-limits
 * in nginx or Cloudflare to turn this off rather than fight it. A value that is
 * not a non-negative number is treated as unset: a typo should not silently
 * remove the limit.
 */
export function configuredLimit(env: Bindings, tier: RateTier): number {
  const raw =
    tier === "expensive" ? env.RATE_LIMIT_EXPENSIVE_PER_MINUTE : env.RATE_LIMIT_STANDARD_PER_MINUTE;
  if (raw === undefined || raw.trim() === "") return DEFAULT_LIMITS[tier];

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(
      `Ignoring RATE_LIMIT_${tier.toUpperCase()}_PER_MINUTE=${raw}: not a non-negative number. ` +
        `Using the default of ${DEFAULT_LIMITS[tier]}.`,
    );
    return DEFAULT_LIMITS[tier];
  }
  return Math.floor(parsed);
}

const warnedTiers = new Set<RateTier>();

/** Exposed for tests, which need each case to warn again. */
export function resetRateLimitWarnings(): void {
  warnedTiers.clear();
}

/**
 * A tripwire for one specific deployment mistake, in the same spirit as the one
 * in `lib/entitlements`.
 *
 * On Cloudflare the in-process fallback is close to no limit at all: isolates
 * are many and short-lived, so each keeps its own counter and a caller spread
 * across them is barely counted. A deploy whose wrangler.toml is missing
 * `[[ratelimits]]` therefore still boots, still serves, and silently stops
 * limiting — which is the failure this whole seam exists to prevent, arriving
 * through the back door.
 *
 * `DOCS` is the discriminator `getDocStore` already uses for "am I on
 * Cloudflare", so there is no new mode flag to keep in sync. Logged rather than
 * fatal: refusing to serve would turn a missing limit into an outage.
 */
function warnIfCloudflareWithoutBinding(env: Bindings, tier: RateTier): void {
  if (!env.DOCS || warnedTiers.has(tier)) return;
  warnedTiers.add(tier);
  console.error(
    `Running on Cloudflare with no RATE_LIMIT_${tier.toUpperCase()} binding — falling back to a ` +
      `per-isolate counter, which does not meaningfully limit anything. Add the [[ratelimits]] ` +
      `block from worker/wrangler.toml.example.`,
  );
}

/**
 * Pick a limiter from the environment.
 *
 * The binding's presence is the runtime discriminator, exactly as `env.DOCS` is
 * for `getDocStore` — no mode flag to keep in sync, and no way for a Cloudflare
 * deploy to silently fall back to a per-isolate counter as long as the binding
 * is declared.
 */
export function getRateLimiter(env: Bindings, tier: RateTier): RateLimiter {
  const binding = tier === "expensive" ? env.RATE_LIMIT_EXPENSIVE : env.RATE_LIMIT_STANDARD;
  if (binding) return cloudflareRateLimiter(binding, RATE_PERIOD_SECONDS);

  warnIfCloudflareWithoutBinding(env, tier);
  const limit = configuredLimit(env, tier);
  if (limit === 0) return unlimitedRateLimiter;

  const cacheKey = `${tier}:${limit}`;
  let limiter = processLimiters.get(cacheKey);
  if (!limiter) {
    limiter = memoryRateLimiter({ limit });
    processLimiters.set(cacheKey, limiter);
  }
  return limiter;
}
