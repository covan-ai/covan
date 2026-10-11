import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { hasBrowserKey } from "./client";
import { refreshSessionJar, stopSessionBrowsers } from "./controls";
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
    await settle(row, deps);
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

  await settle(row, deps);
  await refreshJar(row, env, deps);
  return true;
}

/**
 * Record a confirmed stop, in the shape the row's own arm calls for.
 *
 * `claim_due_browser_takeovers` hands out rows from **two** arms and they want
 * different endings, which is the thing this function originally got wrong:
 *
 * - `status = 'open'` and past `expires_at` — somebody walked away without
 *   pressing done. Nobody has closed this, so the sweep does: `expired`, with
 *   the timestamps.
 * - `status = 'closed'` with no `provider_stopped_at` — the person DID press
 *   done, and the provider refused the stop at the time. The close is already
 *   recorded and must not be overwritten; the only thing missing is the
 *   confirmation that the browser is now really stopped. So `closed` stays and
 *   only `provider_stopped_at` is written.
 *
 * **Writing `expired` for both was a silent dead loop.** The update was
 * guarded on `.eq("status", "open")`, so for an arm-two row it matched zero
 * rows — no error, no failure count, `provider_stopped_at` still null — and
 * the row re-entered the claim set on the next tick, forever. Three of them
 * permanently fill `BATCH_SIZE` and genuinely abandoned browsers stop being
 * swept, which is the login loss this file exists to prevent.
 *
 * And the guard itself stays, narrowed to each arm's own status, for a second
 * and live reason: `closeTakeover` claims with `id + user_id + status = 'open'`
 * and does not read `claimed_at`, so the route can win a row out from under a
 * sweep that is mid-sequence. If it did, it has already written `closed` and
 * started the re-run, and `expired` over the top would lose the person's own
 * close. Whoever got there first keeps it.
 *
 * `expired` is still written in exactly one branch of one function, and only
 * behind a provider-confirmed stop — `claim_due_browser_takeovers` has no arm
 * for `expired`, so a row marked that way after a refused stop would sit
 * outside both arms with its browser still running.
 */
async function settle(row: TakeoverRow, deps: SweepDeps): Promise<void> {
  const stamp = deps.now().toISOString();

  if (row.status === "closed") {
    const { error } = await deps.db
      .from("browser_takeovers")
      .update({ provider_stopped_at: stamp, claimed_at: null })
      .eq("id", row.id)
      .eq("status", "closed");
    if (error) console.error("could not confirm a swept takeover's stop", row.id, problem(error));
    return;
  }

  const { error } = await deps.db
    .from("browser_takeovers")
    .update({
      status: "expired",
      closed_at: stamp,
      provider_stopped_at: stamp,
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
    .select("provider_profile_id, cookie_domains")
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

  /**
   * An empty answer over a non-empty column is dropped, and that is the one
   * judgement in this function.
   *
   * The provider writes the profile SOME SECONDS AFTER reporting the browser
   * stopped — 3.1s, measured on the first real run — so an empty list here is
   * usually "not written yet" rather than "nothing saved".
   * `takeover.ts`'s `JAR_ATTEMPTS` waits it out, because a person is on the
   * other end of that request and the answer decides whether their task runs
   * again. Nobody is waiting on this one, and holding a cron tick for it would
   * be spending the tick's budget on a column that is display-only.
   *
   * So the sweep declines instead. Writing the empty list is worse than
   * leaving the column alone: it replaces a correct list of somebody's
   * sign-ins with "none", so the settings screen says nothing has been saved
   * while the jar at the provider still holds it, and the forget control
   * offers nothing to forget. A jar does not empty itself — the only thing
   * that empties one is `forgetProfile`, which deletes the row outright — so
   * the stale list is the more truthful of the two.
   */
  const held = Array.isArray(data.cookie_domains) ? data.cookie_domains : [];
  if (refreshed.value.cookieDomains.length === 0 && held.length > 0) {
    console.log("swept a takeover before its jar was written; keeping what we had", row.id);
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

// ---- the browser beside a conversation ---------------------------------------

/**
 * One tick of the conversation-browser sweep: a browser beside a conversation
 * that nobody is going to stop, in either of two ways.
 *
 * - **In human hands, and nobody pressed Done** — the person took the controls
 *   and closed the tab. Their browser is running at the provider, billing,
 *   with the sign-in they just performed unsaved — browser-use: *"always stop
 *   the session to persist profile state"*. Swept ten minutes after the tab
 *   stopped saying it was open.
 * - **Nobody's (ruling R20)** — the last run ended, nobody took over, and the
 *   provider keeps the browser open until its own idle cleanup ("after
 *   approximately 20 minutes", and "not an exact shutdown deadline"), billing
 *   all the while, with what the run's pages set not yet saved to the
 *   profile. Swept ten minutes after the last run started.
 *
 * `claim_due_browser_sessions` hands out both from one claim and one batch;
 * this stops each (`stopSessionBrowsers`, the same stop the panel's close
 * makes), reads the jar back (`refreshSessionJar`, likewise), and records the
 * stop in the shape the row's arm calls for. Either way a confirmed stop
 * clears `provider_browser_id`: the row's own record that it has seen its
 * browser stopped, which is what keeps the idle arm from claiming the same
 * browser again and what tells the panel there is none to show. The agent
 * session is kept — a follow-up continues it, and the provider gives it a new
 * browser (`browser.reattached`), so nothing reads a null browser as "no
 * session".
 *
 * Its own function rather than a third arm of `sweepAbandonedTakeovers`, which
 * is left exactly as it was: the two claim from different tables with different
 * endings, and `background.ts` sequences them as two stages so a tick spends
 * one stage's subrequests, not both.
 */

/**
 * How many conversation browsers one tick may sweep — both arms together.
 *
 * The takeover sweep's arithmetic with a longer row, and one budget for both
 * arms because they share one claim. A tick spends 1 subrequest on the claim,
 * and a row of either arm spends at most 13: the browsers list, one stop, the
 * profile lookup, up to `JAR_ATTEMPTS` (8) reads of the jar (the provider
 * writes it seconds after the stop, and a browser that set no cookies waits
 * out all of them), the jar update and the row update. Three rows is
 * 1 + 39 = 40. `background.ts` reaches this stage only when no routine was
 * claimed and the takeover sweep claimed nothing, so the two idle claims ahead
 * of it cost 2 more: 42 of a Free invocation's 50. A fourth row would not fit,
 * which is why the idle arm shares these three rather than adding its own, and
 * why this is not a number to raise casually. Human rows are claimed first.
 */
export const BROWSER_BATCH_SIZE = 3;

/**
 * How long a V4 browser can still be alive at the provider: four hours, its
 * hard timeout (the plan's "Facts this codebase learned"). A row older than
 * this — in human hands since the take-over, or idle since its last run — has
 * no browser left to stop, so the sweep gives up on the stop and settles it.
 * It also bounds the retries of a stop that keeps failing, which are leased
 * fifteen minutes apart.
 */
export const HUMAN_GIVE_UP_HOURS = 4;

/** A claimed `browser_sessions` row, as `claim_due_browser_sessions` returns it. */
type SessionRow = {
  id: string;
  live_state: string;
  human_since: string | null;
  /** When the person took over; the four-hour bound counts from here (R21). */
  human_started_at: string | null;
  last_run_at: string | null;
  profile_id: string | null;
  provider_session_id: string | null;
  provider_browser_id: string | null;
};

export type BrowserSweepDeps = SweepDeps & {
  sleep: (ms: number) => Promise<void>;
};

export async function sweepConversationBrowsers(
  env: RoutineEnv,
  overrides: Partial<BrowserSweepDeps> = {},
): Promise<{ claimed: number; ok: number; failed: number }> {
  // Silent, unlike the takeover sweep's identical check: that one runs first on
  // every tick and has already said why, and saying it twice a tick is noise.
  if (!hasBrowserKey(env)) return { claimed: 0, ok: 0, failed: 0 };

  const deps: BrowserSweepDeps = {
    db: overrides.db ?? serviceClient(env),
    now: overrides.now ?? (() => new Date()),
    sleep: overrides.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
  };

  const { data, error } = await deps.db.rpc("claim_due_browser_sessions", {
    p_limit: BROWSER_BATCH_SIZE,
    // The takeover sweep's reason: the TypeScript constant is the one source of
    // truth, and the SQL default is a fallback nothing relies on.
    p_stale_after: `${TAKEOVER_PROVIDER_MINUTES} minutes`,
  });
  if (error) throw new Error(`claim_due_browser_sessions failed: ${error.message}`);

  const due = (data ?? []) as SessionRow[];
  if (due.length === 0) return { claimed: 0, ok: 0, failed: 0 };

  const results = await Promise.allSettled(
    due.map((row) =>
      row.live_state === "human" ? sweepHuman(row, env, deps) : sweepIdle(row, env, deps),
    ),
  );
  const failed = results.filter(
    (r) => r.status === "rejected" || (r.status === "fulfilled" && r.value === false),
  ).length;
  return { claimed: due.length, ok: due.length - failed, failed };
}

// ---- in human hands ------------------------------------------------------------

/**
 * Every write below is `where live_state = 'human'`.
 *
 * The panel's Done (`handBackBrowser`) and Stop (`stopConversationBrowser`)
 * write this row without reading `claimed_at`, so they can win it out from
 * under a sweep that is mid-sequence — the `closeTakeover` situation. Whoever
 * moved the row first keeps it: a sweep that wrote `none` over a hand-back
 * would take the browser from an agent that is already typing in it.
 */
const STILL_HUMAN = ["live_state", "human"] as const;

/** @returns false when this browser could not be stopped this tick. */
async function sweepHuman(
  row: SessionRow,
  env: RoutineEnv,
  deps: BrowserSweepDeps,
): Promise<boolean> {
  if (!row.provider_session_id) {
    // A take-over needs a browser to take, so this row never opened one.
    // Settled rather than left, because a row that can never be stopped would
    // be claimed every fifteen minutes for ever.
    await settleHuman(row, deps);
    console.error("a human-mode browser row named no provider session", row.id);
    return true;
  }

  // From the take-over, not from `human_since`: the open tab moves that one
  // every minute (ruling R21), and the provider's four hours do not reset.
  if (pastProviderLifetime(row.human_started_at, deps.now())) {
    // The provider's own hard timeout has already stopped this browser, so
    // there is nothing to stop and a stop would only fail again and again. The
    // jar is read once (a stopped browser's profile is already written, so no
    // wait), best-effort, and the row is settled rather than left to be
    // claimed every fifteen minutes for ever.
    await refreshSessionJar(env, deps, {
      profileId: row.profile_id,
      attempts: 1,
      signal: timeout(),
    });
    await settleHuman(row, deps);
    console.warn("settled a human-mode browser past the provider's lifetime", row.id);
    return true;
  }

  const stopped = await stopSessionBrowsers(env, {
    providerSessionId: row.provider_session_id,
    storedBrowserId: row.provider_browser_id,
    signal: timeout(),
  });
  if (!stopped) {
    /**
     * Nothing is written, and that is the retry: `human_since` and
     * `live_state` stand, and the claim's lease (`claimed_at`) is KEPT, so the
     * row is claimable again only after `p_stale_after` — fifteen minutes.
     *
     * The claim is not handed back, because this stage short-circuits
     * `runScheduledWork` whenever it claims anything. A row released straight
     * back into the predicate (which has no upper bound on `human_since`)
     * would be claimed again on the very next tick, for as long as the stop
     * kept failing, and the browser poll and the connection sync behind it
     * would never run. Left leased, the ticks in between run the later
     * stages, and a stop that keeps failing is tried four times an hour until
     * `HUMAN_GIVE_UP_HOURS` says there is nothing left to stop.
     */
    console.error("could not stop an abandoned human-mode browser", row.id);
    return false;
  }

  // The jar first, then the row: a worker that dies in the wait leaves the row
  // claimed and human, and the lease's expiry retries it (stopping an
  // already-stopped browser is a no-op) instead of losing the refresh. The
  // failed-stop branch above waits out the same lease on purpose.
  await refreshSessionJar(env, deps, { profileId: row.profile_id, signal: timeout() });
  await settleHuman(row, deps);
  return true;
}

/**
 * The browser is stopped and the jar saved: nobody has the controls any more,
 * and the row names no browser (ruling R20's marker).
 */
async function settleHuman(row: SessionRow, deps: BrowserSweepDeps): Promise<void> {
  const { error } = await deps.db
    .from("browser_sessions")
    .update({
      live_state: "none",
      human_since: null,
      human_started_at: null,
      claimed_at: null,
      provider_browser_id: null,
    })
    .eq("id", row.id)
    .eq(...STILL_HUMAN);
  if (error) console.error("could not record a swept browser", row.id, problem(error));
}

// ---- nobody's (ruling R20) -------------------------------------------------------

/** @returns false when this browser could not be stopped this tick. */
async function sweepIdle(
  row: SessionRow,
  env: RoutineEnv,
  deps: BrowserSweepDeps,
): Promise<boolean> {
  if (pastProviderLifetime(row.last_run_at, deps.now())) {
    // The human arm's reason, counted from the last run: the provider's hard
    // timeout has ended this browser, so the marker is cleared without a stop
    // that could only fail, after one best-effort read of the jar.
    await refreshSessionJar(env, deps, {
      profileId: row.profile_id,
      attempts: 1,
      signal: timeout(),
    });
    await settleIdle(row, deps);
    console.warn("settled an idle browser past the provider's lifetime", row.id);
    return true;
  }

  const stopped = await stopSessionBrowsers(env, {
    providerSessionId: row.provider_session_id,
    storedBrowserId: row.provider_browser_id,
    signal: timeout(),
  });
  if (!stopped) {
    // R15, for this arm too: nothing is written and the lease is kept, so the
    // marker still names the browser and the row is tried again once the lease
    // goes stale, not on the very next tick. See `sweepHuman`'s note.
    console.error("could not stop an idle browser", row.id);
    return false;
  }

  // The jar first, then the row, for `sweepHuman`'s reason.
  await refreshSessionJar(env, deps, { profileId: row.profile_id, signal: timeout() });
  await settleIdle(row, deps);
  return true;
}

/**
 * The browser is stopped: the row names none, and the claim is let go.
 *
 * `live_state` is not written — nobody had the controls, and nobody gets them.
 * Conditional on the row still being nobody's AND on `last_run_at` being the
 * one the claim saw: a `browse` that started meanwhile has taken the browser
 * (`recordRunStart` writes both), and the id the row names may now be that
 * run's browser, which is not the sweep's to forget. Its lease then simply
 * expires.
 */
async function settleIdle(row: SessionRow, deps: BrowserSweepDeps): Promise<void> {
  const { error } = await deps.db
    .from("browser_sessions")
    .update({ provider_browser_id: null, claimed_at: null })
    .eq("id", row.id)
    .eq("live_state", "none")
    .eq("last_run_at", String(row.last_run_at));
  if (error) console.error("could not record a swept idle browser", row.id, problem(error));
}

// ---- both ------------------------------------------------------------------------

/** A hung provider must not eat the tick. */
function timeout(): AbortSignal {
  return AbortSignal.timeout(STOP_TIMEOUT_MS);
}

/** An unparseable or missing clock is not past anything: the stop is tried. */
function pastProviderLifetime(since: string | null, now: Date): boolean {
  const at = Date.parse(String(since));
  return Number.isFinite(at) && now.getTime() - at > HUMAN_GIVE_UP_HOURS * 3_600_000;
}
