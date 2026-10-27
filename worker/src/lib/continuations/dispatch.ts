import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { settleContinuation, type ContinuationRow } from "./rows";
import { runContinuationTurn, type WakeUp } from "./run";

/**
 * One tick's wake-ups (0142): the timers whose time has come, and the steps
 * after a browser that no tab was there to run.
 *
 * Shaped like `lib/routines/dispatcher.ts`: claim through a service-role
 * function that sets the claim in the statement that selects, run what it
 * handed back, settle every row, and let one failure not strand the others.
 *
 * **One batch for both kinds.** A woken turn is a scheduled run's size — up
 * to `SCHEDULED_MAX_STEPS` tool calls and a model pass per step — so a tick
 * runs at most `BATCH_SIZE` of them, timers first because somebody said when,
 * and the rest of the batch goes to steps after the browser. A busy chain
 * waits a tick, which for a conversation nobody is watching is not a latency
 * anybody notices.
 *
 * **A step after the browser has no row of its own to settle.** The claim set
 * `continued_at` on the task, which is the whole of its bookkeeping (0117): a
 * step that failed to run is a step that was claimed and ran into an error
 * the woken turn logged. The timer's row carries its outcome.
 */

/** How many woken turns one tick may run. Two scheduled runs' worth of subrequests. */
export const BATCH_SIZE = 2;

export type DispatchDeps = {
  db: SupabaseClient;
  run: typeof runContinuationTurn;
};

function resolve(env: RoutineEnv, overrides: Partial<DispatchDeps>): DispatchDeps {
  return {
    db: overrides.db ?? serviceClient(env),
    run: overrides.run ?? runContinuationTurn,
  };
}

type StepRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  user_id: string;
  session_id: string;
  routine_run_id: string | null;
  then_step: string;
};

function problem(error: { code?: string | null; message?: string } | null): {
  code: string | null;
} {
  // The code only: a claim's `details` would quote the row.
  return { code: error?.code ?? null };
}

export async function runDueContinuations(
  env: RoutineEnv,
  overrides: Partial<DispatchDeps> = {},
): Promise<{ claimed: number }> {
  const { db, run } = resolve(env, overrides);

  const timers = await claimTimers(db);
  await Promise.allSettled(
    timers.map(async (row) => {
      const wake: WakeUp = {
        id: row.id,
        kind: "timer",
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        userId: row.user_id,
        sessionId: row.session_id,
        routineRunId: row.routine_run_id ?? null,
        note: row.note,
      };
      let outcome: { status: "done" | "failed"; error?: string };
      try {
        const woken = await run(env, wake, { db });
        outcome =
          woken.status === "done" ? { status: "done" } : { status: "failed", error: woken.error };
      } catch (err) {
        console.error("a wake-up threw", row.id, err);
        outcome = { status: "failed", error: err instanceof Error ? err.message : String(err) };
      }
      await settleContinuation(db, row.id, outcome);
    }),
  );

  const room = BATCH_SIZE - timers.length;
  const steps = room > 0 ? await claimSteps(db, room) : [];
  await Promise.allSettled(
    steps.map(async (row) => {
      const wake: WakeUp = {
        id: `task:${row.id}`,
        kind: "after_browser",
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        userId: row.user_id,
        sessionId: row.session_id,
        routineRunId: row.routine_run_id ?? null,
        note: row.then_step,
      };
      try {
        await run(env, wake, { db });
      } catch (err) {
        console.error("a step after the browser threw", row.id, err);
      }
    }),
  );

  return { claimed: timers.length + steps.length };
}

async function claimTimers(db: SupabaseClient): Promise<ContinuationRow[]> {
  const { data, error } = await db.rpc("claim_due_continuations", { p_limit: BATCH_SIZE });
  if (error) {
    console.error("could not claim due wake-ups", problem(error));
    return [];
  }
  return (Array.isArray(data) ? data : []) as ContinuationRow[];
}

async function claimSteps(db: SupabaseClient, limit: number): Promise<StepRow[]> {
  const { data, error } = await db.rpc("claim_browser_continuations_unwatched", {
    p_limit: limit,
  });
  if (error) {
    console.error("could not claim steps after the browser", problem(error));
    return [];
  }
  return (Array.isArray(data) ? data : []).filter(
    (row): row is StepRow => typeof (row as StepRow).then_step === "string",
  );
}
