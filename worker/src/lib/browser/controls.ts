import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import type { CredentialBinding } from "./credentials";
import { conversationRun, jarForRun } from "./outcome";
import {
  browserLiveUrl,
  browserState,
  getProfile,
  jarWrittenSince,
  stopBrowser,
  stopDeclinedBrowser,
} from "./profiles";
import type { LiveState } from "./sessions";
import { JAR_ATTEMPTS, JAR_DELAY_MS, runProfile, type RetryableTask } from "./takeover";
import { cancelWaitingTasks, NOT_STARTED } from "./queue";
import { recordBrowserTask } from "./tasks";
import { browsersFor, cancelRun, createRun, isTerminalRun, runStatus, type RunStatus } from "./v4";

/**
 * Who has the controls of the browser beside a conversation, and the four
 * moves that change it: watch it, take it over, hand it back, stop it.
 *
 * `browse` gives the agent the controls (`recordRunStart`) and the settle
 * takes them away again (`settle.ts`). Everything the PERSON does to that
 * browser is here, behind `routes/browser.ts`'s four `/browser/sessions/:id`
 * routes.
 *
 * **Through the service role, scoped by hand — `providerSessionFor`'s
 * pattern.** The row's provider ids, its cursor and its lease are granted to
 * no client role (0078), and `live_state` is written by the worker alone:
 * `human` is the state in which the panel hands somebody a browser, and a
 * client that could write it could put itself there while the agent was still
 * typing. The route reads the row through `c.get("db")` first, so RLS decides
 * whether the caller may touch it at all; then every read and write here is
 * keyed to that row id AND the caller's own user id. The id arrives in a URL
 * path and this client answers to no policy, so the user id is in every
 * predicate rather than beside it: somebody else's browser answers exactly
 * what no browser answers.
 *
 * **`liveUrl` lives in `liveBrowser`'s return value and nowhere else.**
 * browser-use, verbatim: *"Treat the URL as a credential: anyone with it can
 * interact with the active browser."* So it is in no insert, no update, no
 * log line and no error string; every sentence a caller can be handed from
 * here is a constant, and every log line carries a status or a database
 * error's code and message — never a provider body, never a row.
 */

/** Injected the way `takeover.ts` injects its own: `??` against the real thing. */
export type ControlDeps = {
  db: SupabaseClient;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
};

function resolve(env: RoutineEnv, overrides: Partial<ControlDeps>): ControlDeps {
  return {
    db: overrides.db ?? serviceClient(env),
    now: overrides.now ?? (() => new Date()),
    sleep: overrides.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))),
  };
}

/** A sentence for the person and a status for the route to answer with. */
type Refusal = { kind: "error"; status: number; message: string };

/** `takeover.ts`'s rule: a database error's `details` quotes the failing row. */
function problem(error: { code?: string; message?: string } | null): {
  code?: string;
  message?: string;
} {
  return { code: error?.code, message: error?.message };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function toLiveState(raw: unknown): LiveState {
  return raw === "human" || raw === "agent" ? raw : "none";
}

/** Whose browser, by the row id the route resolved AND the caller. */
type Owned = { browserSessionId: string; userId: string };

const NOT_FOUND: Refusal = { kind: "error", status: 404, message: "no such browser" };

// ---- take over --------------------------------------------------------------

/**
 * How many times the take-over asks whether the cancelled run has ended, a
 * second apart (ruling R6): ten seconds, then it answers `cancelling`.
 *
 * **Worst case this request spends about fifteen subrequests** — the route's
 * read, the task read, the cancel, the claim, ten status reads and the switch
 * — inside Workers Free's 50, and over the plan's approximate ten; R6 accepts
 * that. Most cancels land within a poll or two, and the 202 exists precisely
 * so the wait is bounded. With no run to stop it is about seven: the two
 * reads, the row's provider ids, at most three to confirm the browser is
 * still open (`confirmBrowser`), and the switch.
 */
export const TAKE_OVER_POLLS = 10;
const TAKE_OVER_DELAY_MS = 1_000;

export type TakeOverResult =
  | { kind: "human"; humanSince: number }
  /** The run has not reported terminal yet: the agent keeps the controls. */
  | { kind: "cancelling" }
  | Refusal;

const UNSTOPPABLE =
  "the agent could not be stopped just now, so the browser is still in its hands. Try again " +
  "in a moment.";

/**
 * The run a take-over has to wait out: the newest of this browser's runs, if
 * it is still going or an earlier take-over stopped it and answered
 * `cancelling` before the provider agreed.
 */
async function runToStop(
  db: SupabaseClient,
  input: Owned,
): Promise<{ id: string; runId: string } | null | "failed"> {
  const { data, error } = await db
    .from("browser_tasks")
    .select("id, provider_run_id, provider_task_id, status, stop_reason")
    .eq("browser_session_id", input.browserSessionId)
    .eq("user_id", input.userId)
    .eq("api_version", "v4")
    // A task that never started (0080: waiting its turn, or out of the line
    // before its turn) has no run, and is not what is in the browser.
    .neq("status", "waiting")
    .or(`stop_reason.is.null,stop_reason.neq.${NOT_STARTED}`)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("could not read the run a take-over stops", problem(error));
    return "failed";
  }
  const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
  if (!row) return null;
  const going = row.status === "queued" || row.status === "running";
  if (!going && row.stop_reason !== "handed_to_person") return null;
  const runId = text(row.provider_run_id) ?? text(row.provider_task_id);
  return runId ? { id: String(row.id), runId } : null;
}

/**
 * A run status that means the agent's hands are off the browser. A 404 is
 * one: the provider no longer has the run to drive anything with.
 */
function ended(
  result: { kind: "ok"; value: { status: RunStatus } } | { kind: "error"; status: number },
): boolean {
  return result.kind === "ok" ? isTerminalRun(result.value.status) : result.status === 404;
}

/**
 * What a take-over or a hand-back says when the browser has gone (final-review
 * I2): stopped by the sweep, by the person's own close in another tab, or by
 * the provider's cleanup. A 409, and the one thing that helps — a new run
 * opens a new browser.
 */
const GONE: Refusal = {
  kind: "error",
  status: 409,
  message:
    "the browser beside this conversation has already closed, so there is nothing to take " +
    "over. Ask the agent again and it will open a new one.",
};

const GONE_ON_DONE: Refusal = {
  kind: "error",
  status: 409,
  message:
    "the browser has already closed, so the agent has nothing to continue in. Ask the agent " +
    "again and it will open a new one.",
};

const UNCONFIRMED: Refusal = {
  kind: "error",
  status: 502,
  message: "the browser could not be reached just now. Try again in a moment.",
};

/**
 * Whether this row's browser is still open at the provider: the one it names
 * (`browserState`, which parses no URL), else the session's active one, whose
 * id is then kept. A browser found gone is forgotten on the row — narrowed to
 * the id that was read, so a run that named a new one meanwhile keeps it — so
 * the panel's `browserReady`, and with it the sign-in prompt, stops offering a
 * browser that is not there (ruling R20's marker).
 *
 * Answers the id of the open browser, which a caller that has to name it (the
 * hand-back's R41 stop) cannot take from the row it read: it may just have
 * been replaced here.
 *
 * Subrequests: one when the named browser is open; up to three otherwise (its
 * status, the session's list, the write).
 */
async function confirmBrowser(
  env: RoutineEnv,
  db: SupabaseClient,
  input: Owned,
  ids: { providerSessionId: string | null; providerBrowserId: string | null },
): Promise<{ open: string } | "gone" | "unknown"> {
  const stored = ids.providerBrowserId;
  if (stored) {
    const state = await browserState(env, stored);
    if (state.kind === "ok" && state.value.status === "active") return { open: stored };
    if (state.kind === "error" && state.status !== 404) {
      console.error("could not read whether a browser is open", state.status);
      return "unknown";
    }
  }

  let found: string | null = null;
  if (ids.providerSessionId) {
    const browsers = await browsersFor(env, ids.providerSessionId);
    if (browsers.kind === "error") {
      console.error("could not list a session's browsers", browsers.status);
      return "unknown";
    }
    found = browsers.value.find((b) => b.status === "active" && b.id)?.id ?? null;
  }
  if (found === stored) return found ? { open: found } : "gone";

  const write = db
    .from("browser_sessions")
    .update({ provider_browser_id: found })
    .eq("id", input.browserSessionId)
    .eq("user_id", input.userId);
  const { error } = await (stored
    ? write.eq("provider_browser_id", stored)
    : write.is("provider_browser_id", null));
  // Not fatal either way: the answer is the provider's, and the next call asks again.
  if (error) console.error("could not record a session's browser", problem(error));
  return found ? { open: found } : "gone";
}

/**
 * Take the browser out of the agent's hands and put it in the person's.
 *
 * In this order, and each step is there for a reason:
 *
 * 1. **Cancel the run** (`cancelRun`, idempotent at the provider). A refusal
 *    here changes nothing, so the person is told to try again rather than
 *    handed a browser the agent is still driving.
 * 2. **Claim the task `stopped`, `handed_to_person`, with the settle's own
 *    condition** — `status in ('queued', 'running')` (ruling R5). Before the
 *    wait, not after it, because the wait is exactly when the open tab's poll
 *    sees the run end: claimed first, the settle finds no row and nobody is
 *    told "cancelled" about a browser they took on purpose. Losing the claim
 *    means the run had already ended and somebody settled it; the take-over
 *    goes ahead regardless, and the answer that settle gave stands.
 * 3. **Wait for the provider to say the run ended** (Review focus 2). Cancel
 *    is asynchronous, and a panel that went interactive while the agent was
 *    mid-type would put two pairs of hands on one field. Past
 *    `TAKE_OVER_POLLS` it answers `cancelling` and leaves `live_state` at
 *    `agent`, so the panel stays inert.
 * 4. **Only then `live_state = 'human'`**, with `human_since` (the sweep's
 *    clock, which the open tab then keeps moving — ruling R21),
 *    `human_started_at` (when the person took it, which nothing moves: the
 *    sweep's four-hour bound) and `claimed_at = null` (ruling R11: a lease an
 *    earlier sweep left on this row must not delay this take-over's).
 *
 * **How a `cancelling` finishes: the client asks again.** A second call finds
 * the same run — stopped `handed_to_person` by the first — cancels it again,
 * which the provider answers with the run's real status at no harm, and makes
 * the switch the moment that status is terminal. No background job and no
 * second state to clean up: the only thing between `cancelling` and `human`
 * is the provider agreeing, and asking is how that is found out.
 */
export async function takeOverBrowser(
  env: RoutineEnv,
  input: Owned,
  overrides: Partial<ControlDeps> = {},
): Promise<TakeOverResult> {
  const { db, now, sleep } = resolve(env, overrides);

  const run = await runToStop(db, input);
  if (run === "failed") return { kind: "error", status: 500, message: UNSTOPPABLE };

  if (run) {
    const cancelled = await cancelRun(env, run.runId);
    if (cancelled.kind === "error" && cancelled.status !== 404) {
      console.error("could not cancel a run for a take-over", cancelled.status);
      return { kind: "error", status: 502, message: UNSTOPPABLE };
    }

    const { error: claimError } = await db
      .from("browser_tasks")
      .update({
        status: "stopped",
        stop_reason: "handed_to_person",
        claimed_at: null,
        finished_at: now().toISOString(),
      })
      .eq("id", run.id)
      .eq("user_id", input.userId)
      .in("status", ["queued", "running"]);
    // Not fatal either way: no row is the run having ended first (see step 2),
    // and an error leaves the task for the settle, which says "cancelled".
    if (claimError) console.error("could not record a take-over's stop", problem(claimError));

    let done = ended(cancelled);
    for (let attempt = 0; !done && attempt < TAKE_OVER_POLLS; attempt += 1) {
      await sleep(TAKE_OVER_DELAY_MS);
      const status = await runStatus(env, run.runId);
      if (status.kind === "error" && status.status !== 404) {
        // Asked again on the next second: one refused read is not an answer.
        console.warn("could not read a cancelling run's status", status.status);
      }
      done = ended(status);
    }
    if (!done) return { kind: "cancelling" };
  } else {
    /**
     * No run to stop, so nothing has shown the browser is still there
     * (final-review I2). The idle sweep stops a browser ten minutes after its
     * last run, and the provider cleans one up on its own, so the row's
     * `none` is no promise of a browser: switching on it handed somebody the
     * controls of nothing, under a sign-in prompt, with a Done that spent
     * the free retry. So the provider is asked first, and a browser that is
     * gone is a 409 that says what to do instead.
     */
    const { data: row, error: rowError } = await db
      .from("browser_sessions")
      .select("provider_session_id, provider_browser_id")
      .eq("id", input.browserSessionId)
      .eq("user_id", input.userId)
      .maybeSingle();
    if (rowError) {
      console.error("could not read a browser to take it over", problem(rowError));
      return { kind: "error", status: 500, message: UNSTOPPABLE };
    }
    if (!row) return NOT_FOUND;
    const alive = await confirmBrowser(env, db, input, {
      providerSessionId: text(row.provider_session_id),
      providerBrowserId: text(row.provider_browser_id),
    });
    if (alive === "unknown") return UNCONFIRMED;
    if (alive === "gone") return GONE;
  }

  const since = now();
  const { data: switched, error } = await db
    .from("browser_sessions")
    .update({
      live_state: "human",
      human_since: since.toISOString(),
      human_started_at: since.toISOString(),
      claimed_at: null,
    })
    .eq("id", input.browserSessionId)
    .eq("user_id", input.userId)
    // A second press while the first already switched keeps the first's clock.
    .neq("live_state", "human")
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("could not hand a browser to its person", problem(error));
    return { kind: "error", status: 500, message: UNSTOPPABLE };
  }
  if (switched) return { kind: "human", humanSince: since.getTime() };

  const { data: standing } = await db
    .from("browser_sessions")
    .select("live_state, human_since")
    .eq("id", input.browserSessionId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (!standing) return NOT_FOUND;
  const at = Date.parse(String(standing.human_since));
  return { kind: "human", humanSince: Number.isFinite(at) ? at : since.getTime() };
}

// ---- hand back --------------------------------------------------------------

/**
 * What the follow-up run is told, in front of the original sentence. The
 * plan's words, verbatim; `conversationRun` puts the outcome preamble in front
 * of the whole thing.
 */
export const HAND_BACK_TASK =
  "The person has handled the browser themselves (for example signed in). " +
  "Continue the original task: ";

/**
 * The same, when the hand-back carries a login saved from the sign-in card
 * (R36). The person did not sign in by hand, and telling the agent they did
 * would have it assume a session the browser does not have; it is told a
 * login was saved and to use it. The alias sentence `conversationRun` puts in
 * front names the bindings.
 */
export const HAND_BACK_WITH_LOGIN_TASK =
  "The person has saved a login for this site; sign in with it when the site asks, " +
  "then continue the original task: ";

export type HandBackResult = { kind: "ok"; browserTaskId: string } | Refusal;

const NOT_IN_THEIR_HANDS: Refusal = {
  kind: "error",
  status: 409,
  message: "this browser is not in your hands, so there is nothing to hand back",
};

const NOT_CONTINUED =
  "the browser is yours again, but the agent could not continue just now. Press Done again " +
  "in a moment.";

/**
 * Give the browser back to the person, after a hand-back that did not start.
 *
 * Only from `agent`, which is what the hand-back's own claim set. The clock
 * starts again from now: the person has just pressed Done, so ten minutes from
 * here is the honest point at which an unattended browser is a closed tab.
 * `human_started_at` too, because the hand-back's claim cleared it with
 * `human_since` (ruling R21) and a row in human hands without it would never
 * reach the sweep's four-hour bound.
 */
async function giveBack(db: SupabaseClient, input: Owned, now: Date): Promise<void> {
  const { error } = await db
    .from("browser_sessions")
    .update({
      live_state: "human",
      human_since: now.toISOString(),
      human_started_at: now.toISOString(),
    })
    .eq("id", input.browserSessionId)
    .eq("user_id", input.userId)
    .eq("live_state", "agent");
  if (error) console.error("could not give a browser back to its person", problem(error));
}

/**
 * The person is done (signed in, cleared a captcha): the agent continues the
 * original task in the same browser, once, for free.
 *
 * **The one free retry, `retryBrowserTask`'s rule.** `browse` charged
 * a hold on credits when the task was first asked for, and a login wall is
 * not something the person did wrong — so nothing here touches `spend`,
 * `affordable` or `lib/entitlements`. What bounds the operator's money is
 * `retry_of`: the route refuses an original that already has a successor, this
 * refuses one that is itself a retry, and `browser_tasks_retry_of_idx` is
 * unique underneath both. The run still carries `maxCostUsd` (through
 * `conversationRun`), so the free retry has the same ceiling the meter priced.
 *
 * **The switch to `agent` is the claim, and it is also the run-start
 * bookkeeping.** `recordRunStart` skips its whole update while the person
 * holds the controls (it must never take a browser out of their hands), so
 * the hand-back cannot lean on it: this update writes `live_state = 'agent'`,
 * `last_run_at`, and `events_cursor = 0` — the cursor is the session's and the
 * event log is the run's, so the old run's last id would skip the new run's
 * first events. Conditional on `live_state = 'human'`, which is
 * `closeTakeover`'s status-flip discipline: a double-click runs this twice,
 * and only one of them gets a row back and calls the provider.
 *
 * Taken BEFORE the provider is called, so a run that is refused hands the
 * browser back to the person (`giveBack`) rather than leaving the panel saying
 * the agent has it.
 *
 * **`login`, when the sign-in card's Save sent the person here (R24).** The
 * route resolved it with `credentialsFor` for the caller — the client named a
 * site and nothing else — and it rides into the follow-up exactly as `browse`
 * hands a first run its login: bindings are run-scoped at the provider (*"a
 * follow-up run that needs the same credential must send it again"*), so a
 * login saved a moment ago reaches this run only by being sent with it. The
 * row records which login it carried (R32), so a second wall is "the saved
 * login did not work" rather than "sign in". Absent, the hand-back is the one
 * it always was.
 */
export async function handBackBrowser(
  env: RoutineEnv,
  input: Owned & { original: RetryableTask; login?: CredentialBinding | null },
  overrides: Partial<ControlDeps> = {},
): Promise<HandBackResult> {
  const { db, now } = resolve(env, overrides);
  const { original } = input;

  if (original.retry_of) {
    // A second wall is a conversation, not another free attempt.
    return {
      kind: "error",
      status: 409,
      message: "this task has already been tried again once, so ask the agent to start it afresh",
    };
  }

  const { data: claimed, error: claimError } = await db
    .from("browser_sessions")
    .update({
      live_state: "agent",
      human_since: null,
      human_started_at: null,
      claimed_at: null,
      last_run_at: now().toISOString(),
      events_cursor: 0,
    })
    .eq("id", input.browserSessionId)
    .eq("user_id", input.userId)
    .eq("live_state", "human")
    .select("provider_session_id, provider_browser_id, profile_id")
    .maybeSingle();
  if (claimError) {
    console.error("could not hand a browser back to the agent", problem(claimError));
    return { kind: "error", status: 500, message: NOT_CONTINUED };
  }
  if (!claimed) return NOT_IN_THEIR_HANDS;

  const providerSessionId = text(claimed.provider_session_id);
  if (!providerSessionId) {
    // A take-over needs a browser to take, so this is a row that never opened
    // one. Nothing to continue in.
    await giveBack(db, input, now());
    return { kind: "error", status: 409, message: NOT_CONTINUED };
  }

  /**
   * Final-review I2: the free retry is not spent on a browser that is gone.
   * The provider would accept the run — it gives a session a new browser —
   * but whatever the person did by hand was in the one that stopped, so the
   * retry would meet the same wall in a fresh browser and there would be no
   * second one. Gone is nobody's: the row goes to `none` (from the `agent`
   * this claim set), so the panel offers neither a Done that can only fail
   * nor a prompt for a browser that is not there. Unknown is the provider not
   * answering, and the browser goes back to the person to press Done again.
   */
  const alive = await confirmBrowser(env, db, input, {
    providerSessionId,
    providerBrowserId: text(claimed.provider_browser_id),
  });
  if (alive === "unknown") {
    await giveBack(db, input, now());
    return { kind: "error", status: 502, message: NOT_CONTINUED };
  }
  if (alive === "gone") {
    const { error: releaseError } = await db
      .from("browser_sessions")
      .update({ live_state: "none" })
      .eq("id", input.browserSessionId)
      .eq("user_id", input.userId)
      .eq("live_state", "agent");
    if (releaseError) console.error("could not let go of a closed browser", problem(releaseError));
    return GONE_ON_DONE;
  }

  // The jar the browser was opened with, sent again exactly as `browse` sends
  // it on a follow-up, so the two requests are one shape — and provisioned now
  // if the `browse` that opened this browser could not make one (ruling R19):
  // the sign-in the person just performed is kept only in a profile the
  // browser runs with. One read when the jar exists, as before.
  const jar = await runProfile(env, input.userId, { db, now });
  // Named only when it is the jar this browser was opened with: a browser that
  // had none (or another) is reused as it is, not replaced by a fresh one that
  // has lost the sign-in the person just made. See `jarForSession`. Except
  // under a shared login, which is never signed in inside the person's jar
  // (ruling R38): a browser opened with it is declined for a fresh,
  // profile-less one in the same session. See `jarForRun`.
  const openedWith = text(claimed.profile_id);
  const { profile, withoutProfile, detach } = jarForRun(
    jar,
    { opening: false, openedWith },
    input.login ?? null,
  );
  const created = await createRun(
    env,
    conversationRun(env, {
      task: `${input.login?.bindings.length ? HAND_BACK_WITH_LOGIN_TASK : HAND_BACK_TASK}${original.task}`,
      sessionId: providerSessionId,
      profile,
      withoutProfile,
      login: input.login,
    }),
  );
  if (created.kind === "error") {
    console.error("could not start the run after a hand-back", created.status);
    await giveBack(db, input, now());
    // 409 is the provider's busy session, which is the person's to retry.
    return { kind: "error", status: created.status === 409 ? 409 : 502, message: NOT_CONTINUED };
  }

  /**
   * The run was accepted in a fresh browser without the jar (R38), so the row
   * stops claiming it: a later follow-up sends the jar only when the row names
   * it (R23), and sending it now would decline the profile-less browser for a
   * profiled one. The same write forgets the browser the row names (R41): it
   * is the profiled one the provider declined, and the live view, take-over
   * and settle must converge on the new one. Only once the provider has
   * accepted the run — a refused run replaced nothing — and narrowed to the
   * jar this hand-back read, so a row rewritten meanwhile is left as it is.
   * Not fatal: the run is real, and a row left naming the jar costs the next
   * follow-up a fresh browser, not a shared login in the person's jar.
   *
   * Then the declined browser is stopped (`stopDeclinedBrowser`, R41), which
   * also saves the person's jar (*"always stop the session to persist profile
   * state"*) — by the id this hand-back confirmed open, never by listing the
   * session, whose active browser is now the run's. Best-effort: a refusal
   * logs a status, the run is real, and the sweeps stop every active browser
   * of the session regardless.
   *
   * Subrequests: this write and the stop — two more, on this path only: a
   * shared login handed back into a browser opened with the person's jar.
   */
  if (detach && openedWith) {
    const { error: detachError } = await db
      .from("browser_sessions")
      .update({ profile_id: null, provider_browser_id: null })
      .eq("id", input.browserSessionId)
      .eq("user_id", input.userId)
      .eq("profile_id", openedWith);
    if (detachError) {
      console.error("could not record a browser opened without the jar", problem(detachError));
    }
    await stopDeclinedBrowser(env, alive.open);
  }

  /**
   * The person's own sentence on the row, not the hand-back's: it is what the
   * answer is delivered against. Every id is copied from the original, which
   * the route read back through the caller's own client.
   */
  const browserTaskId = await recordBrowserTask(env, {
    workspaceId: original.workspace_id,
    agentId: original.agent_id,
    userId: original.user_id,
    sessionId: original.session_id,
    task: original.task,
    providerRunId: created.value.id,
    browserSessionId: input.browserSessionId,
    retryOf: original.id,
    // Only a login whose bindings were sent: `conversationRun` drops an empty one.
    ...(input.login?.bindings.length ? { credentialId: input.login.id } : {}),
  });
  if (!browserTaskId) {
    // A run nothing in this database names is one whose answer can never be
    // delivered, driving a browser the panel would call the agent's forever.
    // Stopped, best-effort, and the browser goes back to the person.
    const stopped = await cancelRun(env, created.value.id);
    if (stopped.kind === "error")
      console.error("could not cancel an unrecorded run", stopped.status);
    await giveBack(db, input, now());
    return { kind: "error", status: 500, message: NOT_CONTINUED };
  }

  return { kind: "ok", browserTaskId };
}

// ---- live view --------------------------------------------------------------

export type LiveBrowserResult = { kind: "ok"; liveUrl: string; liveState: LiveState } | Refusal;

const NOTHING_LIVE: Refusal = {
  kind: "error",
  status: 409,
  message: "no browser is open beside this conversation right now",
};

const UNREADABLE: Refusal = {
  kind: "error",
  status: 502,
  message: "the browser could not be reached just now. Try again in a moment.",
};

/** The URL of an active browser, null when it is stopped or gone, or a refusal. */
async function urlOf(env: RoutineEnv, browserId: string): Promise<string | null | Refusal> {
  const read = await browserLiveUrl(env, browserId);
  if (read.kind === "error") {
    if (read.status === 404) return null;
    // The status only. The provider's body is withheld by `send` already, and
    // a log line is not a place the URL may reach by any road.
    console.error("could not read a browser's live view", read.status);
    return UNREADABLE;
  }
  return read.value.status === "active" ? read.value.liveUrl : null;
}

/**
 * The live view's URL, minted fresh for its owner on every call.
 *
 * Idempotent on purpose (Review focus 3): the URL lives in the panel's
 * component state and nowhere else, so a reload must be able to ask again and
 * get the browser back rather than a person locked out of their own sign-in.
 * Nothing is remembered between calls except which browser it is.
 *
 * **The same URL whether the agent or the person has the controls.** The
 * panel embeds it `inert` while the agent drives, and that is a courtesy, not
 * a lock: browser-use's own words are *"View-only embeds are a UI
 * restriction, not a server-enforced permission."* Which is why this is
 * answered to the browser's owner and nobody else — the route's RLS read, and
 * the user id in every predicate here.
 *
 * The browser is `provider_browser_id`, from the run's `browser.ready` event.
 * A browser can change under a session (`browser.reattached`), and a stopped
 * one has no view, so when the stored one is stopped or gone the session's
 * active browser is looked up and its ID — never its URL — is stored for next
 * time. No `browserId` in the answer: the provider's id is granted to no
 * client role, and the panel needs only the URL.
 */
export async function liveBrowser(
  env: RoutineEnv,
  input: Owned,
  overrides: Partial<ControlDeps> = {},
): Promise<LiveBrowserResult> {
  const { db } = resolve(env, overrides);

  const { data: row, error } = await db
    .from("browser_sessions")
    .select("live_state, provider_session_id, provider_browser_id")
    .eq("id", input.browserSessionId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error) {
    console.error("could not read a browser for its live view", problem(error));
    return { kind: "error", status: 500, message: UNREADABLE.message };
  }
  if (!row) return NOT_FOUND;
  const liveState = toLiveState(row.live_state);

  const stored = text(row.provider_browser_id);
  if (stored) {
    const url = await urlOf(env, stored);
    if (typeof url === "string") return { kind: "ok", liveUrl: url, liveState };
    if (url) return url;
  }

  const providerSessionId = text(row.provider_session_id);
  if (!providerSessionId) return NOTHING_LIVE;

  const browsers = await browsersFor(env, providerSessionId);
  if (browsers.kind === "error") {
    console.error("could not list a session's browsers", browsers.status);
    return UNREADABLE;
  }
  const active = browsers.value.find((b) => b.status === "active" && b.id && b.id !== stored);
  if (!active) return NOTHING_LIVE;

  const { error: keepError } = await db
    .from("browser_sessions")
    .update({ provider_browser_id: active.id })
    .eq("id", input.browserSessionId)
    .eq("user_id", input.userId);
  // Not fatal: the next call looks it up again.
  if (keepError) console.error("could not record a session's browser", problem(keepError));

  const url = await urlOf(env, active.id);
  if (typeof url === "string") return { kind: "ok", liveUrl: url, liveState };
  return url ?? NOTHING_LIVE;
}

// ---- stop -------------------------------------------------------------------

export type StopResult = { kind: "ok" } | Refusal;

/**
 * Says what to do rather than when the sweep will get there. The sweep does
 * reach every state a failed close can leave (`human` ten minutes after the
 * tab goes quiet, `none` ten minutes after the last run, both retried on a
 * fifteen-minute lease), but "shortly" was a promise about a cron and a lease
 * the person cannot see, and a press of Close again is the faster road.
 */
const UNSTOPPED: Refusal = {
  kind: "error",
  status: 502,
  message:
    "the browser could not be stopped just now, so what you did in it may not be saved yet. " +
    "Try closing it again in a moment.",
};

/**
 * Stop every active browser of a provider session, for the panel's close and
 * the sweep alike — the one place the stop happens, so the two cannot disagree
 * about what a stopped browser is.
 *
 * **This is the step that saves the jar, not a tidy-up.** browser-use:
 * *"always stop the session to persist profile state"* — a sign-in the person
 * performed in the panel is not kept until the browser stops, and an open one
 * is billed until it does.
 *
 * Found by asking the provider rather than trusting `provider_browser_id`: a
 * session can move to another browser (`browser.reattached`), and the one the
 * row names may be the one that already stopped. A browser already gone (404)
 * is a browser stopped, so a second call is a no-op; a session with no active
 * browser at all (the provider's own cleanup got there first) is stopped too;
 * and a row whose session the provider no longer lists falls back to the
 * stored id.
 *
 * **A 200 is not a stop.** `PATCH {"action":"stop"}` can answer 200 with
 * `status: "active"` (see `sweep.ts`'s takeover arm), so the status word is
 * what is believed.
 *
 * @returns false when a browser could not be confirmed stopped; otherwise the
 *   latest `finishedAt` the provider gave for the browsers it stopped, which is
 *   what `refreshSessionJar` waits for the jar to be written after. Null when
 *   nothing said when — no browser left to stop, or a 404. Nothing here logs
 *   more than a status: no provider id, no body.
 */
export async function stopSessionBrowsers(
  env: RoutineEnv,
  input: {
    providerSessionId: string | null;
    storedBrowserId: string | null;
    /** The sweep's: a hung provider must not eat a cron tick. The panel passes none. */
    signal?: AbortSignal;
  },
): Promise<false | { finishedAt: string | null }> {
  const { providerSessionId, storedBrowserId: stored, signal } = input;
  const opts = signal ? { signal } : undefined;
  let targets: string[] = stored ? [stored] : [];
  if (providerSessionId) {
    const browsers = await browsersFor(env, providerSessionId, opts);
    if (browsers.kind === "ok") {
      targets = browsers.value.filter((b) => b.status === "active" && b.id).map((b) => b.id);
    } else {
      console.error("could not list a session's browsers to stop them", browsers.status);
      // Nothing to stop by name either: letting go of the row now would tell
      // the panel the browser is closed while it runs on with the jar unsaved.
      if (!stored) return false;
    }
  }

  let finishedAt: string | null = null;
  for (const browserId of targets) {
    const stopped = await stopBrowser(env, browserId, opts);
    if (stopped.kind === "error" ? stopped.status !== 404 : stopped.value.status !== "stopped") {
      console.error(
        "could not stop a conversation's browser",
        stopped.kind === "error" ? stopped.status : stopped.value.status,
      );
      return false;
    }
    const at = stopped.kind === "ok" ? (stopped.value.finishedAt ?? null) : null;
    if (at && (!finishedAt || Date.parse(at) > Date.parse(finishedAt))) finishedAt = at;
  }
  return { finishedAt };
}

/**
 * Read the jar back, now that stopping the browser has saved it, and record
 * which sites it holds cookies for.
 *
 * Shared by every stop of a conversation's browser and the takeover sweep —
 * the sweep's arms and the panel's close — so they cannot disagree about what
 * is written. The wait is `JAR_ATTEMPTS` reads a second apart, until
 * `jarWrittenSince` says the provider has written the profile since the stop:
 * it writes the profile some seconds after reporting the
 * browser stopped, so a read straight after the stop can be the list from
 * before it, and for a person who walked away this read is the only one that
 * ever happens. `stoppedAt` is the stop's `finishedAt`, and is what makes the
 * wait about time rather than about whether the list is empty.
 *
 * `cookie_domains` is what the provider's profile holds cookies for, nothing
 * more — it is not a list of sign-ins, and nothing here calls it one. A list
 * the provider has not written since the stop is not recorded: it is the one
 * from before, which the column may already hold, and writing it would say
 * nothing about what this stop saved. An empty answer over a non-empty column
 * is dropped too: a jar does not empty itself (only `forgetProfile` deletes
 * one), so the stale list is the more truthful of the two.
 *
 * Best-effort throughout, and it logs only statuses and database error codes:
 * the stop already happened, and a failure here leaves the column stale until
 * the next stop rewrites it.
 *
 * Subrequests: the profile lookup, up to `attempts` reads, and the write.
 */
export async function refreshSessionJar(
  env: RoutineEnv,
  deps: ControlDeps,
  input: {
    profileId: string | null;
    /** The stop's `finishedAt`, from `stopSessionBrowsers`. Null or absent: no stop to measure from. */
    stoppedAt?: string | null;
    attempts?: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { db, now, sleep } = deps;
  const attempts = input.attempts ?? JAR_ATTEMPTS;
  const stoppedAt = input.stoppedAt ?? null;
  if (!input.profileId) return;

  const { data, error: readError } = await db
    .from("browser_profiles")
    .select("provider_profile_id, cookie_domains")
    .eq("id", input.profileId)
    .maybeSingle();
  const providerProfileId = text(data?.provider_profile_id);
  if (readError || !providerProfileId) {
    console.error("stopped a browser but could not find its profile", problem(readError));
    return;
  }

  let domains: string[] = [];
  let written = false;
  for (let attempt = 0; attempt < attempts && !written; attempt += 1) {
    const read = await getProfile(
      env,
      providerProfileId,
      input.signal ? { signal: input.signal } : undefined,
    );
    if (read.kind === "error") {
      console.error("stopped a browser but could not read the jar back", read.status);
      return;
    }
    domains = read.value.cookieDomains;
    written = jarWrittenSince(read.value, stoppedAt);
    // Not slept after the last attempt: a second that buys no further read.
    if (!written && attempt < attempts - 1) await sleep(JAR_DELAY_MS);
  }

  const held = Array.isArray(data?.cookie_domains) ? data.cookie_domains : [];
  if (!written && stoppedAt) {
    console.log("stopped a browser but its jar was not written since; keeping what we had");
    return;
  }
  if (domains.length === 0 && held.length > 0) {
    console.log("stopped a browser before its jar was written; keeping what we had");
    return;
  }

  const { error } = await db
    .from("browser_profiles")
    .update({ cookie_domains: domains, last_used_at: now().toISOString() })
    .eq("id", input.profileId);
  if (error) console.error("could not record a stopped browser's jar", problem(error));
}

/**
 * Stop the browser beside a conversation, and give the controls to nobody.
 *
 * The stop itself is `stopSessionBrowsers`, and the panel's close calls this so
 * that the person's own Done is what saves the jar; the sweep is the safety net
 * for a tab that closed without it.
 *
 * Only a stop that worked lets go of the row. One that failed leaves
 * `live_state` and `human_since` standing, so the sweep — which claims on
 * exactly those — finds this browser again and saves the jar then.
 */
export async function stopConversationBrowser(
  env: RoutineEnv,
  input: Owned,
  overrides: Partial<ControlDeps> = {},
): Promise<StopResult> {
  const deps = resolve(env, overrides);
  const { db } = deps;

  const { data: row, error } = await db
    .from("browser_sessions")
    .select("provider_session_id, provider_browser_id, profile_id")
    .eq("id", input.browserSessionId)
    .eq("user_id", input.userId)
    .maybeSingle();
  if (error) {
    console.error("could not read a browser to stop it", problem(error));
    return { kind: "error", status: 500, message: UNSTOPPED.message };
  }
  if (!row) return NOT_FOUND;

  /**
   * What was waiting for this browser does not run (0080): somebody who
   * closed it should not find it reopened by the next task in line. Before
   * the stop, so the queue's cron cannot start one in the moment between the
   * stop and this; and whatever the stop then does, because the person asked
   * for the browser to go. Said in the conversation, once.
   */
  await cancelWaitingTasks(env, input.browserSessionId, { db });

  const stopped = await stopSessionBrowsers(env, {
    providerSessionId: text(row.provider_session_id),
    storedBrowserId: text(row.provider_browser_id),
  });
  if (!stopped) return UNSTOPPED;

  /**
   * The jar the stop just saved, read back the way the sweep reads it — the
   * same helper and the same wait for the provider's late write — so Settings
   * → Browser sign-ins shows what the close kept rather than the list from
   * before it. First, for the sweep's reason: a request that dies in the wait
   * leaves the row as it was, and the next close or sweep reads it again.
   *
   * Subrequests, the panel's close at worst: the route's read, this read, the
   * browsers list, one stop, the profile lookup, `JAR_ATTEMPTS` (8) jar reads,
   * the jar write and the row write — fifteen, once, inside Free's 50.
   */
  await refreshSessionJar(env, deps, {
    profileId: text(row.profile_id),
    stoppedAt: stopped.finishedAt,
  });

  const { error: releaseError } = await db
    .from("browser_sessions")
    // `provider_browser_id` too (ruling R20): a confirmed stop is the row's
    // record that its browser is gone, which the idle sweep claims on and the
    // panel's `browserReady` reads. A follow-up still continues the session.
    .update({
      live_state: "none",
      human_since: null,
      human_started_at: null,
      claimed_at: null,
      provider_browser_id: null,
    })
    .eq("id", input.browserSessionId)
    .eq("user_id", input.userId);
  if (releaseError) {
    // The browser is stopped and the jar saved; only the hairline is wrong,
    // and the sweep's stop of an already-stopped browser puts it right.
    console.error("stopped a browser but could not record it", problem(releaseError));
  }
  return { kind: "ok" };
}
