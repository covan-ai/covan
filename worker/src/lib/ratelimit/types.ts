/**
 * How often a caller may ask.
 *
 * Nothing in this API bounded that until now. Request *size* was bounded — 10 MB
 * for a document, 2 MB for audio — and that is a different thing: it caps what
 * one call costs, not how many calls arrive. `POST /chat/stream` and
 * `POST /transcribe` spend money at OpenAI every time, so an authenticated user
 * with a loop, or one leaked password, was an unbounded bill rather than an
 * outage. Authentication is not the mitigation: a limiter has to sit in front of
 * the thing it protects, and both of those routes are already past the door.
 *
 * Two implementations, for the same reason `lib/docstore` has two: Cloudflare
 * has a rate limiting binding and Docker does not. Routes and middleware depend
 * on this interface and never on either one, or the Node build breaks silently.
 */

/** Which bucket a request is counted in. */
export type RateTier = "standard" | "expensive";

export type RateVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /**
       * What to put in `Retry-After`. Both implementations answer with the
       * window length rather than the exact time remaining: Cloudflare's binding
       * reports only success or failure, and a limiter that promises a precise
       * wait it cannot compute is worse than one that rounds up honestly.
       */
      retryAfterSeconds: number;
    };

export interface RateLimiter {
  /**
   * Counts one request against `key` and says whether it may proceed.
   *
   * Never throws. A limiter that fails closed turns its own outage into the
   * API's; one that fails open leaves the bill unbounded for the duration.
   * Both implementations choose the second and log, because the thing being
   * protected here is money rather than integrity — see the note in each.
   */
  check(key: string): Promise<RateVerdict>;
}

/**
 * The window every tier is measured over.
 *
 * Fixed at a minute because Cloudflare's binding accepts only 10 or 60, and a
 * ten-second window makes a burst of legitimate work — opening a workspace
 * fires several requests at once — look like abuse. Both implementations use
 * this so the two runtimes cannot disagree about what a limit means.
 */
export const RATE_PERIOD_SECONDS = 60;

/**
 * Requests per minute when nothing is configured.
 *
 * `standard` is keyed by IP and has to survive a shared office behind one
 * address, so it is generous: it exists to protect the token check in front of
 * it, which costs a round trip to Supabase on every request, not to ration
 * ordinary use.
 *
 * `expensive` is keyed by the user and covers only the two routes that spend at
 * OpenAI. Twenty a minute is more than a person can type and far less than a
 * loop can.
 */
export const DEFAULT_LIMITS: Record<RateTier, number> = {
  standard: 120,
  expensive: 20,
};
