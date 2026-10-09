import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { hasBrowserKey } from "./client";
import { getProfile, stopBrowser, TAKEOVER_PROVIDER_MINUTES } from "./profiles";

/**
 * One tick of the abandoned-takeover sweep.
 *
 * A takeover hands somebody a real browser for ten minutes and asks them to
 * press done when they have signed in. Pressing done is what stops the
 * provider session, and stopping the session is the only thing that saves the
 * cookie jar — browser-use is explicit about it: *"Profile state (cookies,
 * localStorage) is only saved when the session ends. Always call stop when you
 * are done — if a session is left open or times out, changes may not be
 * persisted."*
 *
 * So the person who closes the tab instead of pressing done has performed a
 * login that is about to be thrown away. This is what stops that: it finds the
 * rows nobody closed, stops their browsers, and reads the jar back. Not
 * tidiness — the login itself.
 *
 * Shaped like `poller.ts`, which is shaped like `lib/routines/dispatcher.ts`:
 * claim with `for update skip locked`, cap the batch, settle every row, and let
 * one failure not strand the others. Its `overrides: Partial<Deps>` injection
 * is copied too, because that is how every dispatcher here is tested.
 */

/**
 * How many abandoned takeovers one tick may sweep.
 *
 * `poller.ts:39`'s arithmetic, for cheaper work. A tick spends 1 subrequest on
 * the claim. Each row spends at most 4: the provider stop, the row update, the
 * profile read and the jar update. So three rows is 1 + 12, nowhere near the 50
 * a Cloudflare Free invocation gets — and the ceiling is not what sets this
 * number anyway. Three is the poller's number, and a sweep that cannot drain
 * its backlog leaves the rest for five minutes later, which for a browser
 * nobody is watching is not a latency anybody notices.
 */
export const BATCH_SIZE = 3;

/** Long enough for a stop to be accepted, short enough that a hung one does not eat the tick. */
const STOP_TIMEOUT_MS = 15_000;

/**
 * A row as `claim_due_browser_takeovers` returns it.
 *
 * `provider_session_id` is readable by no client role (0077), for
 * `connected_account_id`'s reason: one deployment-wide `BROWSER_USE_API_KEY`
 * makes that id the boundary between two tenants at the provider. It is
 * readable here because this runs on the cron with the service-role client, and
 * it is never logged — see `problem` below.
 */
type TakeoverRow = {
  id: string;
  user_id: string;
  profile_id: string;
  provider_session_id: string | null;
  status: string;
};

export type SweepDeps = {
  db: SupabaseClient;
  now: () => Date;
};

/**
 * What of a Postgres error is safe to log.
 *
 * The same guard `lib/browser/takeover.ts` installs, for the same reason spec
 * §4a gives. A check violation's `DETAIL` is `Failing row contains (…)` — the
 * whole row, which PostgREST passes through as `details` — and these rows carry
 * `provider_session_id`, which is a live browser. So the code and the message,
 * never the object.
 */
function problem(error: { code?: string | null; message?: string } | null): {
  code: string | null;
  message: string;
} {
  return { code: error?.code ?? null, message: error?.message ?? "unknown" };
}

export async function sweepAbandonedTakeovers(
  env: RoutineEnv,
  overrides: Partial<SweepDeps> = {},
): Promise<{ claimed: number; ok: number; failed: number }> {
  // Asked before anything is claimed, the way `poller.ts:108` asks it. A
  // claimed row with nobody able to stop its browser is worse than an
  // unclaimed one: the claim is what keeps the next tick off it.
  if (!hasBrowserKey(env)) {
    console.warn(
      "abandoned takeovers not swept: this Worker has no BROWSER_USE_API_KEY. Set it here as " +
        "well as on the API Worker, or a browser somebody walked away from is never stopped and " +
        "the sign-in they just performed is lost.",
    );
    return { claimed: 0, ok: 0, failed: 0 };
  }

  const db = overrides.db ?? serviceClient(env);
  const now = overrides.now ?? (() => new Date());

  const { data, error } = await db.rpc("claim_due_browser_takeovers", {
    p_limit: BATCH_SIZE,
    // Passed rather than left to the SQL default, so the TypeScript constant is
    // the single source of truth and the default is a fallback nothing relies
    // on. 0077's own comment promises this; without it the two numbers agree
    // only by coincidence.
    p_stale_after: `${TAKEOVER_PROVIDER_MINUTES} minutes`,
  });
  // Thrown rather than returned, so a tick that cannot claim is a loud failure
  // instead of a quiet success. `poller.ts:121` does the same.
  if (error) throw new Error(`claim_due_browser_takeovers failed: ${error.message}`);

  const due = (data ?? []) as TakeoverRow[];
  if (due.length === 0) return { claimed: 0, ok: 0, failed: 0 };

  const results = await Promise.allSettled(due.map((row) => sweepOne(row, env, { db, now })));
  // Spelled the way `poller.ts:132-134` spells it, including the
  // redundant-looking `=== "fulfilled"`: it is what narrows the union so
  // `r.value` is readable at all.
  const failed = results.filter(
    (r) => r.status === "rejected" || (r.status === "fulfilled" && r.value === false),
  ).length;

  return { claimed: due.length, ok: due.length - failed, failed };
}

/** @returns false when this takeover could not be settled this tick. */
async function sweepOne(row: TakeoverRow, env: RoutineEnv, deps: SweepDeps): Promise<boolean> {
  if (!row.provider_session_id) {
    // Nothing to stop, so nothing to wait for. Marked rather than left,
    // because a row that can never be settled would be claimed forever.
    await settle(row, deps, { stopped: true });
    console.error("a takeover row named no provider session", row.id);
    return true;
  }

  const stopped = await stopBrowser(env, row.provider_session_id, {
    signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
  });

  /**
   * **A 200 is not a stop.**
   *
   * `PATCH {"action":"stop"}` can answer 200 with `status: "active"`, which is
   * why `lib/browser/takeover.ts` settles on the status word rather than on
   * `kind`. Treating the 200 as done here would be worse than anywhere else:
   * this is the last thing that will ever look at this row, so a status written
   * on an unconfirmed stop is a browser that runs to its provider timeout with
   * the jar unsaved and nothing left to reclaim it.
   */
  if (stopped.kind === "error" || stopped.value.status !== "stopped") {
    /**
     * The claim goes back, and that is the whole of the retry.
     *
     * `claimed_at = null` puts the row back in the predicate's
     * `claimed_at is null` branch, so the **next** tick picks it up — five
     * minutes, which is the cron interval `wrangler.cron.toml.example` sets.
     * Leaving the claim set would instead wait out `p_stale_after`, fifteen
     * minutes and means the provider's own fifteen-minute window has closed
     * and the jar is gone anyway. Releasing a handled failure and timing out
     * an unhandled one are two different mechanisms; 0073's header argues the
     * second, and this is the first.
     */
    await release(row, deps);
    console.error(
      "could not stop an abandoned takeover's browser",
      row.id,
      stopped.kind === "error" ? stopped.status : stopped.value.status,
    );
    return false;
  }

  await settle(row, deps, { stopped: true });
  await refreshJar(row, env, deps);
  return true;
}

/**
 * Mark the row finished, and only on a confirmed stop.
 *
 * `expired` is written **here and only here**, which is load-bearing:
 * `claim_due_browser_takeovers` has an arm for `open` past `expires_at` and an
 * arm for `closed` with no `provider_stopped_at`, and **none** for `expired`.
 * So `expired` means "the provider confirmed the stop" and nothing else. A row
 * marked `expired` after a refused stop would sit outside both arms with its
 * browser still running.
 *
 * Conditional on `status = 'open'` for a second reason, and a live one:
 * `closeTakeover` claims with `id + user_id + status = 'open'` and does not
 * read `claimed_at`, so the route can win this row out from under a sweep that
 * is mid-sequence. If it did, it has already written `closed` and started the
 * re-run; overwriting that with `expired` would lose the person's own close.
 * Whoever got there first keeps it.
 */
async function settle(
  row: TakeoverRow,
  deps: SweepDeps,
  outcome: { stopped: true },
): Promise<void> {
  const stamp = deps.now().toISOString();
  const { error } = await deps.db
    .from("browser_takeovers")
    .update({
      status: "expired",
      closed_at: stamp,
      provider_stopped_at: outcome.stopped ? stamp : null,
      claimed_at: null,
    })
    .eq("id", row.id)
    .eq("status", "open");
  if (error) console.error("could not record a swept takeover", row.id, problem(error));
}

/** Hand the claim back so the next tick retries. See `sweepOne`'s note. */
async function release(row: TakeoverRow, deps: SweepDeps): Promise<void> {
  const { error } = await deps.db
    .from("browser_takeovers")
    .update({ claimed_at: null })
    .eq("id", row.id);
  if (error) console.error("could not release a swept takeover's claim", row.id, problem(error));
}

/**
 * Read the cookie jar back, now that stopping it has saved it.
 *
 * Best-effort and last, because it is the only step whose failure costs
 * nothing: `cookie_domains` is display-only — the list of sites this person is
 * signed into, which is the whole of what Covan can tell them about their own
 * logins. The stop already happened; a failed read leaves the column stale
 * until the next takeover's close rewrites it. The same work
 * `takeover.ts`'s `recordStop` does, deliberately sharing nothing with it: the
 * sweep has no caller and no permission question, and a shared helper would
 * have to take both shapes.
 */
async function refreshJar(row: TakeoverRow, env: RoutineEnv, deps: SweepDeps): Promise<void> {
  const { data, error: readError } = await deps.db
    .from("browser_profiles")
    .select("provider_profile_id")
    .eq("id", row.profile_id)
    .maybeSingle();
  if (readError || !data?.provider_profile_id) {
    console.error("swept a takeover but could not find its profile", row.id, problem(readError));
    return;
  }

  const refreshed = await getProfile(env, String(data.provider_profile_id), {
    signal: AbortSignal.timeout(STOP_TIMEOUT_MS),
  });
  if (refreshed.kind === "error") {
    console.error("swept a takeover but could not read the jar back", row.id, refreshed.status);
    return;
  }

  const { error } = await deps.db
    .from("browser_profiles")
    .update({
      cookie_domains: refreshed.value.cookieDomains,
      last_used_at: deps.now().toISOString(),
    })
    .eq("id", row.profile_id);
  if (error) console.error("could not record a swept takeover's jar", row.id, problem(error));
}
