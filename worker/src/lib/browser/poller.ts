import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { hasBrowserKey, stopTask, taskStatus } from "./client";
import { deliverBrowserTask } from "./deliver";
import { finishedRun, settleBrowserTask, type ReportedOutcome } from "./settle";
import { cancelRun, isTerminalRun, runStatus, runSummary } from "./v4";

/**
 * One tick of the browser-task poller.
 *
 * A browser task takes minutes and a chat turn cannot wait minutes, so the
 * waiting happens outside the model loop, where a poll costs a subrequest
 * rather than a transcript entry. `lib/harness/tools/browse.ts` explains why
 * that distinction is the whole design.
 *
 * **This is now the fallback clock, not the first one.** An open chat tab
 * polls `GET /sessions/:id/browser-tasks` every three seconds and settles a v4
 * run the moment it ends (`live.ts`), so a person watching is answered in
 * seconds rather than minutes. This tick is for everyone else — the tab that
 * was closed, the laptop that went to sleep — and for the v2 tasks written
 * before 0078, which it drains on the v2 API until none are left. Both clocks
 * settle through `settleBrowserTask`, whose conditional claim is what makes
 * them deliver one answer between them rather than two.
 *
 * Shaped like `lib/routines/dispatcher.ts` on purpose: claim with
 * `for update skip locked`, cap the batch, settle every row, and let one
 * failure not strand the others. Its `overrides: Partial<Deps>` injection is
 * copied too, because that is how every dispatcher here is tested.
 */

/**
 * How many tasks one tick may poll.
 *
 * The arithmetic `lib/routines/dispatcher.ts:20-52` does, for this work.
 * Workers Free allows 50 subrequests per invocation. A tick spends 1 on the
 * claim. A task that is still running spends 2 — the provider's status
 * endpoint and one row update. A task that has FINISHED spends about 6: the
 * status read, the agent read, the model call, the message insert, the
 * session touch and the row update, plus up to 2 more if there is a delivery
 * channel to notify. A v4 run that has finished adds 2 — its summary, read
 * once, and handing the browser back from the agent — and 2 more when no open
 * tab ever named the run's browser (`settle.ts`'s `recordOpenBrowser`: the
 * provider's list and the write, for the idle sweep's marker, ruling R20). So
 * the worst case is 1 + 3 x 12 = 37, still inside 50 and leaving room for the
 * routine tick's and the two sweeps' idle claims that run before it.
 *
 * Three rather than more because the ceiling is not the only cost: a tick
 * that cannot drain the backlog leaves the rest for five minutes later, and
 * that is a latency a person waiting on a browser will not notice. A tick
 * that dies at the ceiling records a task as failed for a reason nothing in
 * the row would explain.
 */
export const BATCH_SIZE = 3;

/**
 * How many times one task may be polled before it is given up on.
 *
 * The cron trigger fires every five minutes, so this is about forty. The
 * provider caps a free session at fifteen minutes of runtime and a paid one
 * at four hours, but it guarantees no terminal status — and a row polled
 * forever is a person who is never told anything, which is the worst of the
 * available failures because it looks like the feature simply does not work.
 *
 * Reaching it stops the task at the provider as well as ending the row: a
 * task left running bills browser time at $0.02/hour for work nobody will
 * read.
 */
export const MAX_POLLS = 8;

/**
 * How long to wait before the next poll.
 *
 * Deliberately flat rather than geometric, which is a departure from
 * `lib/connections/sync.ts:741-785` and worth saying why: a backoff exists to
 * stop hammering something that is failing, and this is not failing — it is
 * working, and the answer is wanted the moment it exists. The real floor is
 * the five-minute cron anyway, so a cleverer curve here would change nothing
 * except how hard it is to read. It is below five minutes so that a tick
 * which runs slightly early still finds the row due.
 */
export const POLL_INTERVAL_MS = 4 * 60 * 1000;

/** The columns the poller reads. `provider_task_id` is here and nowhere a client can reach. */
export type BrowserTaskRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  user_id: string;
  session_id: string;
  provider_task_id: string;
  task: string;
  status: string;
  poll_count: number;
  /**
   * 0078. Optional because a v2 row read before the migration, or built by a
   * test, says nothing — and nothing is v2, which is the column's default.
   */
  api_version?: string;
  /** The v4 run. 0078 also writes it into `provider_task_id`; this one is preferred. */
  provider_run_id?: string | null;
  browser_session_id?: string | null;
};

/** How a task ended, in the shape the delivery step wants. */
export type FinishedTask = {
  status: "finished" | "failed" | "stopped";
  output: string | null;
  error: string | null;
  costUsd: number | null;
  /**
   * What a v4 run said it ended with (`settle.ts`'s `readOutcome`). Absent on
   * a v2 task, which had no such thing, and the delivery answers it as today.
   */
  reported?: ReportedOutcome;
  /** Written to `stop_reason` (0078) when the run was stopped rather than finished. */
  stopReason?: "cancelled";
};

export type PollerDeps = {
  db: SupabaseClient;
  now: () => Date;
  finish: (
    row: BrowserTaskRow,
    outcome: FinishedTask,
    env: RoutineEnv,
    db: SupabaseClient,
  ) => Promise<void>;
};

export async function pollDueBrowserTasks(
  env: RoutineEnv,
  overrides: Partial<PollerDeps> = {},
): Promise<{ claimed: number; ok: number; failed: number }> {
  // Asked before anything is claimed, the way `background.ts` asks whether
  // this Worker can do the work at all. A claimed row with nobody able to
  // poll it is worse than an unclaimed one.
  if (!hasBrowserKey(env)) {
    console.warn(
      "browser tasks not polled: this Worker has no BROWSER_USE_API_KEY. Set it here as well " +
        "as on the API Worker, or tasks are created and never finished.",
    );
    return { claimed: 0, ok: 0, failed: 0 };
  }

  const db = overrides.db ?? serviceClient(env);
  const now = overrides.now ?? (() => new Date());
  const finish = overrides.finish ?? deliverBrowserTask;

  const { data, error } = await db.rpc("claim_due_browser_tasks", { p_limit: BATCH_SIZE });
  if (error) throw new Error(`claim_due_browser_tasks failed: ${error.message}`);

  const due = (data ?? []) as BrowserTaskRow[];
  if (due.length === 0) return { claimed: 0, ok: 0, failed: 0 };

  // One task blowing up must not strand the others in a claimed state.
  const results = await Promise.allSettled(
    due.map((row) => pollOne(row, env, { db, now, finish })),
  );
  // Spelled the way `lib/routines/dispatcher.ts` spells it, including the
  // redundant-looking `=== "fulfilled"`: it is what narrows the union so
  // `r.value` is readable at all.
  const failed = results.filter(
    (r) => r.status === "rejected" || (r.status === "fulfilled" && r.value === false),
  ).length;

  return { claimed: due.length, ok: due.length - failed, failed };
}

/**
 * v2 or v4, by the row's own word. A v2 task id sent to the runs API would be
 * a 404 and a failed task that had in fact finished, so the branch is on
 * `api_version` and never on the shape of the id.
 *
 * @returns false when this task could not be settled this tick.
 */
function pollOne(row: BrowserTaskRow, env: RoutineEnv, deps: PollerDeps): Promise<boolean> {
  return row.api_version === "v4" ? pollRun(row, env, deps) : pollTask(row, env, deps);
}

/** A v4 run: the one-word status, then the summary once, when it has ended. */
async function pollRun(row: BrowserTaskRow, env: RoutineEnv, deps: PollerDeps): Promise<boolean> {
  const polls = row.poll_count + 1;
  const runId = row.provider_run_id || row.provider_task_id;

  const status = await runStatus(env, runId, { signal: AbortSignal.timeout(15_000) });

  if (status.kind === "error") {
    // `pollTask`'s reasoning: a 404 is nothing to come back to, anything else
    // is worth another look.
    if (status.status === 404) {
      await settle(
        row,
        deps,
        polls,
        {
          status: "failed",
          output: null,
          error: "browser-use no longer has a record of this run",
          costUsd: null,
        },
        env,
      );
      return true;
    }
    await release(row, deps, polls);
    return false;
  }

  if (!isTerminalRun(status.value.status)) {
    if (polls >= MAX_POLLS) {
      // Cancelled at the provider, so a browser nobody will read stops
      // billing; best-effort, for `pollTask`'s reason. The cancel is
      // asynchronous at the provider, and that is fine here: the row ends now
      // whatever the run does next, and the claim below is what keeps a late
      // answer from being delivered after "this took too long".
      const cancelled = await cancelRun(env, runId, { signal: AbortSignal.timeout(15_000) });
      if (cancelled.kind === "error") {
        console.error("could not cancel a browser run we gave up on", row.id, cancelled.status);
      }
      await settle(
        row,
        deps,
        polls,
        {
          status: "stopped",
          output: null,
          error: "this took too long and was given up on",
          costUsd: null,
          stopReason: "cancelled",
        },
        env,
      );
      return true;
    }
    await release(row, deps, polls);
    return true;
  }

  const summary = await runSummary(env, runId, { signal: AbortSignal.timeout(15_000) });
  if (summary.kind === "error") {
    // Ended, but its answer could not be read. Another look next tick — up to
    // the same ceiling as a run that never ends, because a row that is polled
    // forever is a person who is never told anything.
    if (polls >= MAX_POLLS) {
      await settle(
        row,
        deps,
        polls,
        {
          status: "failed",
          output: null,
          error: "the browser finished, but its answer could not be read",
          costUsd: null,
        },
        env,
      );
      return true;
    }
    await release(row, deps, polls);
    return false;
  }

  await settle(row, deps, polls, finishedRun(summary.value), env);
  return true;
}

/** A v2 task, drained on the v2 API exactly as before 0078. */
async function pollTask(row: BrowserTaskRow, env: RoutineEnv, deps: PollerDeps): Promise<boolean> {
  const polls = row.poll_count + 1;

  const status = await taskStatus(env, row.provider_task_id, {
    signal: AbortSignal.timeout(15_000),
  });

  if (status.kind === "error") {
    // 404 means there is nothing to come back to. Anything else — a 500, a
    // timeout, a network fault — is worth another look, so the claim is
    // released and the row stays due.
    if (status.status === 404) {
      await settle(
        row,
        deps,
        polls,
        {
          status: "failed",
          output: null,
          error: "browser-use no longer has a record of this task",
          costUsd: null,
        },
        env,
      );
      return true;
    }
    await release(row, deps, polls);
    return false;
  }

  const { status: state, output, isSuccess, costUsd } = status.value;

  if (state === "queued" || state === "running") {
    if (polls >= MAX_POLLS) {
      // Stopped at the provider as well, so a browser nobody will read stops
      // billing. Best-effort: the row ends either way, because a task we have
      // given up on must not be polled again whatever the provider says.
      const stopped = await stopTask(env, row.provider_task_id, {
        signal: AbortSignal.timeout(15_000),
      });
      if (stopped.kind === "error") {
        console.error("could not stop a browser task we gave up on", row.id, stopped.message);
      }
      await settle(
        row,
        deps,
        polls,
        {
          status: "stopped",
          output: null,
          error: "this took too long and was given up on",
          costUsd,
        },
        env,
      );
      return true;
    }
    await release(row, deps, polls);
    return true;
  }

  /**
   * `isSuccess: false` on a finished task is the provider saying it ran and
   * did not manage it — which is a failure that nonetheless has something
   * worth reporting, because `output` usually says what stopped it ("the page
   * asked me to sign in"). Recorded as failed so the row is honest, with the
   * output kept so the person is told why.
   */
  const ended: FinishedTask =
    state === "finished" && isSuccess !== false
      ? { status: "finished", output, error: null, costUsd }
      : {
          status: state === "stopped" ? "stopped" : "failed",
          output,
          error: output ? null : `the browser task ${state} without producing an answer`,
          costUsd,
        };

  await settle(row, deps, polls, ended, env);
  return true;
}

/**
 * Still running: release the claim, book the next look.
 *
 * **Conditional on the row not having ended**, and that condition is new with
 * the second clock. The open tab may settle a run between this tick's claim
 * and this write; an unconditional `status = 'running'` would put the row
 * back in the due index, and the next tick would deliver the same answer a
 * second time.
 */
async function release(row: BrowserTaskRow, deps: PollerDeps, polls: number): Promise<void> {
  const at = deps.now();
  const { error } = await deps.db
    .from("browser_tasks")
    .update({
      status: "running",
      claimed_at: null,
      poll_count: polls,
      next_poll_at: new Date(at.getTime() + POLL_INTERVAL_MS).toISOString(),
    })
    .eq("id", row.id)
    .in("status", ["queued", "running"]);
  if (error) console.error("could not release a browser task claim", row.id, error);
}

/** Ended: claim it terminal and deliver it, unless the other clock already did. */
async function settle(
  row: BrowserTaskRow,
  deps: PollerDeps,
  polls: number,
  outcome: FinishedTask,
  env: RoutineEnv,
): Promise<void> {
  await settleBrowserTask(env, { ...row, poll_count: polls }, outcome, {
    db: deps.db,
    now: deps.now,
    deliver: deps.finish,
  });
}
