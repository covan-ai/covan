import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";

/**
 * A wake-up the agent set for itself (0142): the row, its bounds, and what
 * "still pending" means to a report that is waiting on it.
 *
 * **Through the service role, for `browser_tasks`' reason (0073).** No client
 * role may write `continuations`: a client that could would be writing a
 * turn nobody asked for, with tools, in a conversation of its choosing. Every
 * id written here comes from `ToolContext`, resolved from the authenticated
 * request or the routine row before the tool ran; nothing is decided from
 * what a model wrote except the minutes and the note.
 *
 * **Two bounds, and neither is about a typical chain.** A video takes ten
 * minutes and three looks; a page that never finishes could keep an agent
 * waking up for ever on the workspace's credits. So a conversation may be
 * woken `MAX_WAKEUPS_PER_DAY` times in a day, and a routine's chain ends
 * inside the window its held report already has (`held.ts`'s `HELD_MAX_MS`),
 * less a margin for the last turn to run, so the report still goes out.
 */

/** The cron ticks every five minutes; a shorter wait would wake on the same tick. */
export const MIN_WAIT_MINUTES = 5;

/** Twelve hours: "check tomorrow morning" is a routine, not a wake-up. */
export const MAX_WAIT_MINUTES = 720;

/** How many times one conversation may be woken in a day. */
export const MAX_WAKEUPS_PER_DAY = 24;

/**
 * How long a step after the browser stays claimable by the cron, and how
 * long a routine's chain has in all: the held report's own window. Stated
 * here rather than imported from `held.ts`, which imports this file; the test
 * pins the two equal.
 */
export const UNWATCHED_STEP_WINDOW_MS = 2 * 60 * 60 * 1000;

/** What the last turn of a routine's chain is left to run in. */
export const ROUTINE_WINDOW_MARGIN_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ContinuationStatus = "waiting" | "running" | "done" | "failed" | "cancelled";

export type ContinuationRow = {
  id: string;
  workspace_id: string;
  agent_id: string;
  user_id: string;
  session_id: string;
  routine_run_id: string | null;
  note: string;
  wake_at: string;
  depth: number;
  status: ContinuationStatus;
  attempts: number;
};

/** Injected as `sessions.ts` injects its own; `??` against the real thing. */
export type RowDeps = { db: SupabaseClient; now: () => Date };

function resolve(env: RoutineEnv, overrides: Partial<RowDeps>): RowDeps {
  return {
    db: overrides.db ?? serviceClient(env),
    now: overrides.now ?? (() => new Date()),
  };
}

/** The code and the message, never the object: a failing row would be quoted in `details`. */
function problem(error: { code?: string; message?: string } | null): {
  code?: string;
  message?: string;
} {
  return { code: error?.code, message: error?.message };
}

export type Scheduled =
  { kind: "ok"; id: string; wakeAt: Date } | { kind: "refused"; message: string };

/**
 * Write the wake-up, or say why not.
 *
 * Refuses rather than clamps: a model that asked for three minutes meant
 * "soon", and the honest answer is that soon is five; one that asked for a
 * day meant a routine. The chain bound is counted on the conversation, not
 * the person, because it is the conversation that loops.
 */
export async function scheduleContinuation(
  env: RoutineEnv,
  input: {
    workspaceId: string;
    agentId: string;
    userId: string;
    sessionId: string;
    routineRunId?: string | null;
    minutes: number;
    note: string;
  },
  overrides: Partial<RowDeps> = {},
): Promise<Scheduled> {
  const { db, now } = resolve(env, overrides);
  if (
    !Number.isInteger(input.minutes) ||
    input.minutes < MIN_WAIT_MINUTES ||
    input.minutes > MAX_WAIT_MINUTES
  ) {
    return {
      kind: "refused",
      message: `minutes must be a whole number from ${MIN_WAIT_MINUTES} to ${MAX_WAIT_MINUTES}`,
    };
  }
  const at = now();
  const wakeAt = new Date(at.getTime() + input.minutes * 60_000);

  const { data: today, error: countError } = await db
    .from("continuations")
    .select("id")
    .eq("session_id", input.sessionId)
    .gte("created_at", new Date(at.getTime() - DAY_MS).toISOString());
  if (countError) {
    console.error("could not count a conversation's wake-ups", problem(countError));
    return { kind: "refused", message: "could not read this conversation's wake-ups; say so" };
  }
  const depth = (today ?? []).length + 1;
  if (depth > MAX_WAKEUPS_PER_DAY) {
    return {
      kind: "refused",
      message:
        `this conversation has been woken ${MAX_WAKEUPS_PER_DAY} times today, which is its ` +
        "limit. Stop here, say what is still unfinished, and let the person decide.",
    };
  }

  if (input.routineRunId) {
    const { data: run, error: runError } = await db
      .from("routine_runs")
      .select("started_at")
      .eq("id", input.routineRunId)
      .maybeSingle();
    if (runError || !run) {
      console.error("could not read the run a wake-up belongs to", problem(runError));
      return { kind: "refused", message: "could not read this run, so no wake-up was set; say so" };
    }
    const started = new Date(String(run.started_at)).getTime();
    const windowEnd = started + UNWATCHED_STEP_WINDOW_MS - ROUTINE_WINDOW_MARGIN_MS;
    const left = Math.floor((windowEnd - at.getTime()) / 60_000);
    if (left <= 0) {
      return {
        kind: "refused",
        message:
          "this routine's report has no time left to wait: it goes out now with what it has. " +
          "Finish the report and say what was not checked.",
      };
    }
    if (wakeAt.getTime() > windowEnd) {
      return {
        kind: "refused",
        message:
          `this routine's report can wait at most ${left} minutes more before it goes out. ` +
          "Ask for that or less, or finish the report now.",
      };
    }
  }

  const { data, error } = await db
    .from("continuations")
    .insert({
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      user_id: input.userId,
      session_id: input.sessionId,
      routine_run_id: input.routineRunId ?? null,
      note: input.note,
      wake_at: wakeAt.toISOString(),
      depth,
      status: "waiting",
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("could not write a wake-up", problem(error));
    return { kind: "refused", message: "the wake-up could not be saved; say so and finish" };
  }
  return { kind: "ok", id: String(data.id), wakeAt };
}

/**
 * Whether a held routine run still has a chain to wait for: a wake-up not yet
 * run, or a finished task whose step the cron has yet to claim. Read in code
 * rather than in the filter for the task's three columns, because the rows
 * are few and the question is one `held.ts` asks once per settle.
 *
 * A read that fails answers false: a report that cannot ask goes out, which
 * is what the two-hour sweep would do anyway.
 *
 * `except`: the wake-up that is asking. A woken turn hands its reply over
 * while its own row is still `running` — the dispatcher settles it only once
 * the turn has returned — and a report that waited on the turn handing it
 * over would wait for the two-hour sweep instead.
 */
export async function chainPending(
  db: SupabaseClient,
  routineRunId: string,
  now: Date = new Date(),
  opts: { except?: string } = {},
): Promise<boolean> {
  let openQuery = db
    .from("continuations")
    .select("id")
    .eq("routine_run_id", routineRunId)
    .in("status", ["waiting", "running"]);
  if (opts.except) openQuery = openQuery.neq("id", opts.except);
  const { data: open, error: openError } = await openQuery.limit(1);
  if (openError) {
    console.error("could not read a run's wake-ups", routineRunId, problem(openError));
    return false;
  }
  if ((open ?? []).length > 0) return true;

  const { data: tasks, error: taskError } = await db
    .from("browser_tasks")
    .select("then_step, continued_at, delivered_at")
    .eq("routine_run_id", routineRunId)
    .eq("status", "finished");
  if (taskError) {
    console.error("could not read a run's finished tasks", routineRunId, problem(taskError));
    return false;
  }
  const since = now.getTime() - UNWATCHED_STEP_WINDOW_MS;
  return (tasks ?? []).some((t) => {
    const row = t as { then_step?: unknown; continued_at?: unknown; delivered_at?: unknown };
    if (typeof row.then_step !== "string" || !row.then_step) return false;
    if (row.continued_at) return false;
    if (typeof row.delivered_at !== "string") return false;
    return new Date(row.delivered_at).getTime() >= since;
  });
}

/** The two-hour sweep's cut: a run sent without its chain has no chain. */
export async function cancelContinuations(
  db: SupabaseClient,
  routineRunId: string,
  now: Date = new Date(),
): Promise<void> {
  const { error } = await db
    .from("continuations")
    .update({ status: "cancelled", finished_at: now.toISOString() })
    .eq("routine_run_id", routineRunId)
    .in("status", ["waiting", "running"]);
  if (error) console.error("could not cancel a run's wake-ups", routineRunId, problem(error));
}

/** How the woken turn ended, on the row the claim handed out. */
export async function settleContinuation(
  db: SupabaseClient,
  id: string,
  outcome: { status: "done" | "failed"; error?: string },
  now: Date = new Date(),
): Promise<void> {
  const { error } = await db
    .from("continuations")
    .update({
      status: outcome.status,
      finished_at: now.toISOString(),
      error: outcome.error ?? null,
    })
    .eq("id", id);
  if (error) console.error("could not settle a wake-up", id, problem(error));
}
