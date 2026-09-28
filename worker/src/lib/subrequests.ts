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
 * **This counts, and since 2026-09-28 it also stops the tool loop.** The first
 * version of this file argued at length that it was observability and not a
 * gate, on the grounds that a Paid turn's measured worst case is roughly 300 of
 * 10,000 — so a budget enforced here could only refuse turns that would have
 * finished. That argument is about **Paid**, and it is still true there:
 * `headroom` below never binds at 10,000.
 *
 * The gate is for **Free**, which is the open build. On Free the cap is fifty
 * and an eight-step turn spending every step on a connected app already needs
 * about seventy-five, so the ceiling is not hypothetical — it is where a
 * self-hoster's first real question lands. Counting alone let that turn walk
 * into the wall and report `Connection error.`; `lib/harness/loop.ts` now asks
 * `headroom` before each pass and stops honestly instead. That is #177, and the
 * warn flag below is kept beside it because the two do different jobs: the flag
 * explains a failure that already happened, and the gate is what stops there
 * being one.
 *
 * **It binds on Cloudflare and nowhere else.** `planLimits` answers Free — and
 * therefore fifty — whenever `WORKER_PLAN` is unset, which is every Node and
 * Docker deployment, where no such ceiling exists at all. A gate that trusted
 * the number alone would cut a self-hosted turn short at forty-five for a limit
 * that is not there, which is a worse bug than the one it fixes. So `headroom`
 * asks where it is running first, the way `lib/routines/source.ts` does.
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
 * How many more outbound calls this invocation can make, or `null` when nothing
 * is counting or the count does not bind.
 *
 * `null` rather than `Infinity` so a caller has to decide what "no ceiling"
 * means rather than compare against a number that silently always passes. Two
 * ways to get it, and both are the ordinary case somewhere:
 *
 * - **No meter.** Every path outside a chat turn — a scheduled run, the eval,
 *   a unit test. Those spend subrequests too; they simply have nobody counting,
 *   and a gate that guessed would be guessing about the cron Worker, which
 *   already does this arithmetic by hand in `lib/routines/dispatcher.ts`.
 * - **Not on Workers.** `planLimits` answers fifty for an unset `WORKER_PLAN`,
 *   which is every Docker and Node install — and there the platform imposes no
 *   subrequest ceiling whatsoever. Reading the number there would stop turns
 *   that were going to finish.
 *
 * The runtime check is the one `lib/routines/source.ts:26-28` established and
 * `workers-bundle.static.test.ts` already polices the spelling of.
 */
export function headroom(env: Pick<RoutineEnv, "SUBREQUESTS">): number | null {
  const meter = env.SUBREQUESTS;
  if (!meter) return null;
  const onWorkers =
    typeof navigator !== "undefined" && navigator.userAgent === "Cloudflare-Workers";
  if (!onWorkers) return null;
  return Math.max(0, meter.limit - meter.count);
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
