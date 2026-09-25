import type { RoutineEnv } from "../types";
import { planLimits } from "./limits";
import type { RuntimeLimitFlag } from "./runtime-limit";

/**
 * Counting what the platform counts, so the turn can say so before it breaks.
 *
 * Cloudflare allows one invocation a fixed number of subrequests — fifty on
 * Free, ten thousand on Paid — and every database read, model call and
 * connected-app call spends one. Past that, `fetch` simply stops working, and
 * `lib/runtime-limit.ts` exists because of how that arrives: the first thing to
 * hit the ceiling sees the real message and everything after it sees a broken
 * `fetch`, which the OpenAI SDK reports as `Connection error.` An evening was
 * lost to that on 2026-09-24.
 *
 * **This is observability, not a gate, and the distinction is deliberate.** A
 * Paid chat turn's measured worst case is roughly 300 of 10,000, so a second
 * budget enforced here could only ever refuse turns that would have finished.
 * It does exactly one thing besides count: at `WARN_AT` of the limit it raises
 * the runtime-limit flag, so the honest sentence — *ask for something narrower*
 * — reaches the person **before** the first disguised failure rather than after
 * it.
 *
 * WHERE IT MATTERS MOST is the open build, not covan.app. On Free the cap is
 * fifty, and an eight-step turn spending every step on a connected app already
 * needs about seventy-five. A self-hoster meeting that today gets
 * `Connection error.`; with this they get a sentence that names the real
 * problem.
 *
 * HOW IT TRAVELS. On `env`, which is the one thing every client factory already
 * receives. Threading a parameter instead would mean touching all thirty-nine
 * places that build a service-role client, to carry something none of them care
 * about. It is created per request and rides on an OVERLAY of the environment —
 * never by mutating the bindings object, which is shared between the requests an
 * isolate serves.
 *
 * It starts in the auth middleware rather than in a route, because the caller's
 * own Supabase client is built there and every read a route makes to work out
 * who is asking goes through it. On Free that is a real share of fifty.
 *
 * WHAT IT DOES NOT COUNT: the token check that runs before the caller exists —
 * `verifyAccessToken`'s key-set fetch, and the GoTrue fallback behind it. Those
 * use the anon client, they happen before there is a caller to attribute them
 * to, and there are at most a couple of them. So the log line is a FLOOR rather
 * than a total, and `subrequestReport` is worded so that reading it as exact
 * would still not mislead: it says what was counted, not what was spent.
 */

/** The fraction of the limit at which a turn starts saying so. */
export const WARN_AT = 0.9;

export type SubrequestMeter = {
  count: number;
  /** What this deployment's plan allows one invocation. */
  limit: number;
  /** Raised when the count crosses `WARN_AT`, so the route can explain itself. */
  runtimeLimit: RuntimeLimitFlag;
};

/** A fresh count for one request, sized to this deployment's plan. */
export function subrequestMeter(
  env: Pick<RoutineEnv, "WORKER_PLAN">,
  runtimeLimit: RuntimeLimitFlag,
): SubrequestMeter {
  return { count: 0, limit: planLimits(env).subrequests, runtimeLimit };
}

/**
 * The environment a metered request runs in.
 *
 * An overlay, in the shape `withProviderKeys` already established: the bindings
 * object is shared across every request an isolate serves, so the meter is
 * added to a copy and never written onto it.
 */
export function withMeter<E extends object>(env: E, meter: SubrequestMeter): E {
  return { ...env, SUBREQUESTS: meter };
}

/**
 * A `fetch` that counts, or `undefined` when nothing is counting.
 *
 * Undefined rather than an identity wrapper so a client factory can omit the
 * option entirely — passing `fetch: undefined` is not the same thing to every
 * SDK as not passing it.
 */
export function meteredFetch(env: Pick<RoutineEnv, "SUBREQUESTS">): typeof fetch | undefined {
  const meter = env.SUBREQUESTS;
  if (!meter) return undefined;
  return (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    meter.count += 1;
    // At the line rather than past it: the point is to be able to say so while
    // `fetch` still works. Set rather than toggled — nothing lowers it, because
    // a turn that got this far spent the subrequests whatever happens next.
    if (meter.count >= meter.limit * WARN_AT) meter.runtimeLimit.hit = true;
    return fetch(input, init);
  };
}

/**
 * What the turn spent, for the log.
 *
 * A floor rather than a total — see the note on the auth middleware above — and
 * phrased so that reading it as exact would still not mislead: it says what was
 * counted, not what was spent.
 */
export function subrequestReport(meter: SubrequestMeter): string {
  const pct = Math.round((meter.count / meter.limit) * 100);
  return `subrequests: ${meter.count} counted of ${meter.limit} allowed (${pct}%)`;
}
