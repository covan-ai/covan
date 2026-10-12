import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { entitlementsFor, type Entitlements } from "../entitlements";
import { serviceClient } from "../supabase";
import { deliverBrowserTask } from "./deliver";
import { bareHost, OUTCOME_STATUSES, type OutcomeStatus } from "./outcome";
import { advanceBrowserQueue } from "./queue";
import type { BrowserTaskRow, FinishedTask } from "./poller";
import { browsersFor, type RunSummary } from "./v4";

/**
 * From "the provider says it ended" to "the row is terminal and the answer is
 * in the conversation" — once, whichever clock got there first.
 *
 * There are two clocks now. An open chat tab polls
 * `GET /sessions/:id/browser-tasks` every three seconds, so an answer lands
 * while the person is still looking; and the five-minute cron poller stays, as
 * the fallback for a tab that was closed. Both can see the same run end in the
 * same second, and the person must be told once.
 *
 * **The claim is the first statement, and it is the whole mechanism.**
 * `update browser_tasks set status = <terminal> where id = ? and status in
 * ('queued', 'running') returning …` — Postgres serialises two such updates
 * on one row, so exactly one of them gets a row back, and only that one goes
 * on to deliver. No row means somebody else settled it (the other clock, or a
 * take-over, which stops the task with this same condition — ruling R5), and
 * the answer is theirs to give or not give. `closeTakeover`'s discipline in
 * `takeover.ts`, for the same reason: a side effect that must happen once is
 * gated on a write that can succeed once.
 *
 * Nothing is read first. A read-then-write would be two clocks both reading
 * `running` and both delivering, which is the bug this file exists to not
 * have.
 *
 * **Through the service role**, for the poller's reasons: `provider_*` and
 * the browser's `live_state` are granted to no client role, and the answer is
 * an assistant message, which 0009 forbids a caller to write. Both callers
 * hand in a row they resolved themselves — the cron from
 * `claim_due_browser_tasks`, the open tab from a read narrowed to the caller's
 * own rows — and the browser written to is the one the CLAIMED row names, not
 * the one the caller passed.
 */

/** What a run said it ended with, read the R8 way. See `readOutcome`. */
export type ReportedOutcome = {
  status: OutcomeStatus;
  host: string | null;
  answer: string | null;
};

/**
 * Why a run ended without its answer, when it said so itself: `stop_reason`
 * for the panel. `failed` with no `error` is a login wall, a block and a run
 * that did not complete but returned text alike, so the reported word is the
 * only positive signal the panel's "needs you to sign in" can key on — and it
 * is kept nowhere else.
 */
function reportedReason(outcome: FinishedTask): "login_required" | "blocked" | null {
  if (outcome.status === "finished") return null;
  const said = outcome.reported?.status;
  return said === "login_required" || said === "blocked" ? said : null;
}

function textOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** An object in `outcome.ts`'s shape with a status word it knows, or null. */
function asOutcome(value: unknown): ReportedOutcome | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (!(OUTCOME_STATUSES as readonly unknown[]).includes(row.status)) return null;
  return {
    status: row.status as OutcomeStatus,
    host: textOf(row.host),
    answer: textOf(row.answer),
  };
}

/** A ```json fence around the whole thing, which a model asked for JSON often adds. */
const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;

function parsedResult(result: string): ReportedOutcome | null {
  const bare = result.trim();
  const inner = FENCE.exec(bare)?.[1] ?? bare;
  try {
    return asOutcome(JSON.parse(inner));
  } catch {
    return null;
  }
}

/**
 * How a run ended, in `outcome.ts`'s words — ruling R8, in this order:
 *
 * 1. `output`, when the provider honoured `outputSchema` and handed back an
 *    object with a status word the schema has;
 * 2. else `result` parsed as that JSON (the preamble asks for it there too),
 *    tolerating whitespace and a ```json fence;
 * 3. else `result` as a plain answer, which is `done`.
 *
 * Null when the run said nothing at all. A status word the schema does not
 * have is not trusted from either channel: `login_required` is the one word
 * the panel acts on, so it has to be the provider's or the agent's and not a
 * guess. The operator's end-to-end run decides which channel stays.
 */
export function readOutcome(
  summary: Pick<RunSummary, "output" | "result">,
): ReportedOutcome | null {
  const structured = asOutcome(summary.output);
  if (structured) return structured;
  const result = textOf(summary.result);
  if (!result) return null;
  return parsedResult(result) ?? { status: "done", host: null, answer: result };
}

/**
 * What the run wrote in `result`, as the answer when the outcome it reported
 * carried none.
 *
 * `answer` is optional in `OUTCOME_SCHEMA`, so a provider that honoured the
 * schema can hand back `{status: "done"}` and put what it found in `result`
 * as prose. That prose is the answer. Unless `result` is the outcome JSON
 * itself (the preamble asks for it there too), in which case it says nothing
 * the outcome did not, and delivering the JSON as the person's answer would be
 * a message of braces.
 */
function proseOf(result: string | null): string | null {
  const text = textOf(result);
  if (!text) return null;
  return parsedResult(text) ? null : text;
}

/**
 * A terminal run summary as the settle and the delivery want it.
 *
 * Shaped the way the v2 poller shapes `isSuccess: false`: a run that completed
 * but stopped at a login wall or a block did not do what was asked, so the row
 * says `failed` — and what it reported travels with it, so the message can
 * name the site. A cancelled run is `stopped`, and says why.
 */
export function finishedRun(summary: RunSummary): FinishedTask {
  const reported = readOutcome(summary);
  const answer = reported?.answer ?? proseOf(summary.result);
  const base = {
    output: answer,
    costUsd: summary.totalCostUsd,
    ...(reported ? { reported } : {}),
  };
  if (summary.status === "completed" && (reported?.status ?? "done") === "done") {
    return { status: "finished", error: null, ...base };
  }
  const said = answer !== null || reported !== null;
  return {
    status: summary.status === "cancelled" ? "stopped" : "failed",
    error:
      summary.error ??
      (said ? null : `the browser run ${summary.status} without producing an answer`),
    ...base,
    ...(summary.status === "cancelled" ? { stopReason: "cancelled" as const } : {}),
  };
}

export type SettleDeps = {
  db: SupabaseClient;
  now: () => Date;
  deliver: (
    row: BrowserTaskRow,
    outcome: FinishedTask,
    env: RoutineEnv,
    db: SupabaseClient,
  ) => Promise<void>;
  /**
   * Told the provider's id of the browser this settle has just named on the
   * session row (`recordOpenBrowser`), so a caller that read the row before
   * settling can answer from what was written rather than from what it read.
   * Not called when the row already named one, or the settle named none.
   */
  onBrowserNamed?: (providerBrowserId: string) => void;
  /**
   * Start what was waiting behind this task in its browser (0080). Defaults
   * to `advanceBrowserQueue` through the same client.
   */
  advance?: (browserSessionId: string) => Promise<unknown>;
  /** Where the provider's own figure is charged. Defaults to `entitlementsFor(env)`. */
  entitlements?: Pick<Entitlements, "record">;
};

function problem(error: { code?: string; message?: string } | null): {
  code?: string;
  message?: string;
} {
  return { code: error?.code, message: error?.message };
}

/**
 * Settle one task: claim it terminal, let go of its browser, deliver.
 *
 * @returns true when THIS call claimed the row and delivered; false when the
 *   row had already ended (another clock, a take-over) or the claim could not
 *   be written. A false is never a reason for the caller to deliver itself.
 */
export async function settleBrowserTask(
  env: RoutineEnv,
  row: BrowserTaskRow,
  outcome: FinishedTask,
  overrides: Partial<SettleDeps> = {},
): Promise<boolean> {
  const db = overrides.db ?? serviceClient(env);
  const now = overrides.now ?? (() => new Date());
  const deliver = overrides.deliver ?? deliverBrowserTask;

  const stopReason = outcome.stopReason ?? reportedReason(outcome);
  const { data: claimed, error } = await db
    .from("browser_tasks")
    .update({
      status: outcome.status,
      claimed_at: null,
      poll_count: row.poll_count,
      output: outcome.output,
      error: outcome.error,
      cost_usd: outcome.costUsd,
      // Where the run needed a sign-in, kept on the row because the outcome it
      // was read from is not kept anywhere else, and the panel's prompt ("…
      // needs you to sign in") has only the row to ask. In the claim, not a
      // second write: the status flip is the one write that can succeed once.
      signin_host:
        outcome.reported?.status === "login_required" ? bareHost(outcome.reported.host) : null,
      finished_at: now().toISOString(),
      // A cancel says so; otherwise the run's own word for a wall it stopped
      // at. Same write, for `signin_host`'s reason.
      ...(stopReason ? { stop_reason: stopReason } : {}),
    })
    .eq("id", row.id)
    .in("status", ["queued", "running"])
    // Not `credential_id` (final review #6): the claim is the one write every
    // settle depends on, so it names no column of 0079's — a worker deployed
    // before that migration still settles. See `carriedLogin` below.
    .select("id, browser_session_id")
    .maybeSingle();

  // Written BEFORE the delivery, and the order matters: the row reaching a
  // terminal status is what stops this task being settled again. A delivery
  // that fails after this leaves a recorded task with no message, which is
  // recoverable by hand; the other order delivers on every tick forever.
  if (error) {
    console.error("could not record a finished browser task", row.id, problem(error));
    return false;
  }
  if (!claimed) return false;

  await chargeSettled(env, row, outcome, overrides.entitlements);

  /**
   * Ruling R4: the agent lets go of the browser, so the panel stops showing it
   * at work. Only from `agent` — `human` is the person holding the controls
   * after a take-over, and a run ending underneath them does not take the
   * browser back. Best-effort: the answer matters more than the hairline.
   */
  const browserSessionId =
    typeof claimed.browser_session_id === "string" ? claimed.browser_session_id : null;
  if (browserSessionId) {
    const { data: released, error: releaseError } = await db
      .from("browser_sessions")
      .update({ live_state: "none" })
      .eq("id", browserSessionId)
      .eq("live_state", "agent")
      .select("provider_session_id, provider_browser_id")
      .maybeSingle();
    if (releaseError) {
      console.error("could not hand a browser back from the agent", row.id, problem(releaseError));
    } else if (released && !released.provider_browser_id && released.provider_session_id) {
      const named = await recordOpenBrowser(
        env,
        db,
        browserSessionId,
        String(released.provider_session_id),
      );
      if (named) overrides.onBrowserNamed?.(named);
    }
  }

  const credentialId = await carriedLogin(db, row.id, outcome);
  await deliver({ ...row, credential_id: credentialId }, outcome, env, db);

  /**
   * The browser is free: start the next task in its line (0080), after the
   * answer, so a person reads the first result before the second is under
   * way. Only the call that won the claim gets here, and the queue's own
   * claim keeps two clocks from starting one task twice. What it cannot start
   * now — a line held by a sign-in, a busy provider — the cron starts later.
   */
  if (browserSessionId) {
    try {
      await (overrides.advance ?? ((id: string) => advanceBrowserQueue(env, id, { db })))(
        browserSessionId,
      );
    } catch (err) {
      console.error("could not start the next browser task in line", row.id, err);
    }
  }
  return true;
}

/**
 * Ruling R32: which saved login the run carried, read back from the row rather
 * than trusted from `row`. The two clocks hand `settleBrowserTask` rows read
 * with different column lists — the cron's claim returns the whole row, the
 * open tab's read names its columns — and "the saved login did not work" must
 * not depend on which of them settled the run.
 *
 * Read only for a login wall, the one outcome `deliver` asks it about, and
 * after the claim rather than in it (final review #6): one subrequest on that
 * path alone, and the claim stays independent of 0079. A read that fails is a
 * wall delivered as one no saved login was tried at — today's sign-in
 * sentence — and is logged as a code, never a row.
 */
async function carriedLogin(
  db: SupabaseClient,
  taskId: string,
  outcome: FinishedTask,
): Promise<string | null> {
  if (outcome.reported?.status !== "login_required") return null;
  const { data, error } = await db
    .from("browser_tasks")
    .select("credential_id")
    .eq("id", taskId)
    .maybeSingle();
  if (error) {
    console.error("could not read which saved login a run carried", taskId, error.code);
    return null;
  }
  return typeof data?.credential_id === "string" ? data.credential_id : null;
}

/**
 * Name the browser a run left open, when nothing has named it yet.
 *
 * Ruling R20's marker. A run's browser stays open at the provider after the
 * run ends — *"A completed run … does not immediately stop its cloud
 * browser"* — and the sweep's idle arm stops it by `provider_browser_id`. Only
 * an open tab's event drain (`live.ts`, `browser.ready`) used to write that
 * column, so a run whose tab was closed, or that ended before the tab's first
 * poll, left a browser the sweep could not see. The end of the run is when it
 * is learned instead, from the provider's list for the session.
 *
 * Asked only when the release's own write answered a row that names none, so
 * it costs nothing when the tab already named it; otherwise two subrequests,
 * once per run (the list and the write). Narrowed to a row still naming none,
 * so a tab that named it meanwhile is not overwritten. Answers the id it found,
 * or null, so the poll that settled the run can say the browser is ready.
 * Best-effort: the answer
 * matters more than the marker, and a browser left unnamed is the provider's
 * own idle cleanup's, as it always was. Logs statuses only — the list carries
 * live view URLs, which go nowhere.
 */
async function recordOpenBrowser(
  env: RoutineEnv,
  db: SupabaseClient,
  browserSessionId: string,
  providerSessionId: string,
): Promise<string | null> {
  const browsers = await browsersFor(env, providerSessionId, {
    signal: AbortSignal.timeout(10_000),
  });
  if (browsers.kind === "error") {
    console.warn("could not list a finished run's browsers", browsers.status);
    return null;
  }
  const open = browsers.value.find((b) => b.status === "active" && b.id);
  if (!open) return null;
  const { error } = await db
    .from("browser_sessions")
    .update({ provider_browser_id: open.id })
    .eq("id", browserSessionId)
    .is("provider_browser_id", null);
  if (error) {
    console.error("could not record a finished run's browser", problem(error));
    return null;
  }
  // Answered for the caller that read the row before this settle: the id is
  // the provider's and stays inside the worker, but "a browser is named" is
  // what the panel's `browserReady` says. A row a tab named meanwhile is
  // named all the same, so the update matching nothing is no reason to say no.
  return open.id;
}

/**
 * True the start's hold up to what the provider says the run cost.
 *
 * After the claim, so a task settled twice (two clocks, a take-over) is
 * charged once — and the hosted ledger makes the TOTAL for this task equal the
 * figure, so even a second call would add nothing.
 *
 * Nothing when the provider gave no figure: the hold stands, which errs
 * towards the operator. Nothing for the one free retry after a login wall
 * (`retry_of`, see `retryBrowserTask`): the person did nothing wrong, and the
 * run still carries the original's `maxCostUsd`.
 *
 * Never throws: the run is over and its answer is on its way.
 */
async function chargeSettled(
  env: RoutineEnv,
  row: BrowserTaskRow,
  outcome: FinishedTask,
  entitlements: Pick<Entitlements, "record"> | undefined,
): Promise<void> {
  if (typeof outcome.costUsd !== "number" || !Number.isFinite(outcome.costUsd)) return;
  if (row.retry_of) return;
  try {
    await (entitlements ?? entitlementsFor(env)).record(
      row.workspace_id,
      [{ kind: "browser_task", stage: "settled", browserTaskId: row.id, costUsd: outcome.costUsd }],
      { userId: row.user_id, sessionId: row.session_id, browserTaskId: row.id },
    );
  } catch (err) {
    console.error("failed to charge a finished browser task", row.id, err);
  }
}
