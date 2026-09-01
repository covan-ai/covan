import type { RateLimiter, RateVerdict } from "./types";
import { RATE_PERIOD_SECONDS } from "./types";

/**
 * A fixed-window counter in process memory, for the Node runtime.
 *
 * Cloudflare has a rate limiting binding and Docker has nothing equivalent, so
 * this is what makes a default `docker compose up` bounded rather than a
 * promise in the documentation that the operator has to keep themselves.
 *
 * Two honest limitations, both documented in docs/self-hosting.md rather than
 * left to be discovered:
 *
 * - **One process, one counter.** Run two replicas behind a load balancer and
 *   each keeps its own, so the effective limit is the configured one times the
 *   number of replicas. Anyone running replicas is running a proxy in front of
 *   them and should set the real limit there.
 * - **A fixed window, not a sliding one.** A caller can spend the whole
 *   allowance in the last second of one window and the whole of it again in the
 *   first second of the next. That is the classic burst at the boundary, and it
 *   is a factor of two on a limit whose job is to turn "unbounded" into
 *   "bounded". A sliding window costs more memory per key for a sharper edge
 *   nobody here needs.
 */
export function memoryRateLimiter(opts: {
  limit: number;
  periodSeconds?: number;
  /** Injectable for tests. Defaults to the wall clock. */
  now?: () => number;
}): RateLimiter {
  const periodSeconds = opts.periodSeconds ?? RATE_PERIOD_SECONDS;
  const periodMs = periodSeconds * 1000;
  const now = opts.now ?? (() => Date.now());
  const windows = new Map<string, { count: number; startedAt: number }>();

  /**
   * Keys are user ids and client addresses, so the map grows with the number of
   * distinct callers rather than with traffic — but it never shrinks on its
   * own, and an unbounded map in a long-lived process is a leak whatever fills
   * it. Sweeping only past a threshold keeps the common path a single lookup.
   */
  const SWEEP_ABOVE = 10_000;
  function sweep(at: number): void {
    for (const [key, window] of windows) {
      if (at - window.startedAt >= periodMs) windows.delete(key);
    }
  }

  return {
    async check(key: string): Promise<RateVerdict> {
      const at = now();
      const window = windows.get(key);

      if (!window || at - window.startedAt >= periodMs) {
        if (windows.size > SWEEP_ABOVE) sweep(at);
        windows.set(key, { count: 1, startedAt: at });
        return { allowed: true };
      }

      if (window.count >= opts.limit) {
        return { allowed: false, retryAfterSeconds: periodSeconds };
      }

      window.count += 1;
      return { allowed: true };
    },
  };
}
