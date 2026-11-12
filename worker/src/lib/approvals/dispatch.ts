import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { pauseFromRow } from "../harness/turn";
import { serviceClient } from "../supabase";
import { resumeApproved, settleWithNote, type ResumeDeps } from "./resume";

/**
 * One tick's answered requests (0143): settle the ones nobody will carry on
 * with, then carry on with one that somebody answered.
 *
 * The single place a yes given anywhere turns into the action. The app's
 * button and a reply to the email only write the answer (`answer_approval`);
 * this is what acts on it, on the next tick — so all three ways of answering
 * share one path, and the person is told "approved, carrying on" rather than
 * shown the result. The cost is up to one tick, five minutes, between the yes
 * and the action.
 *
 * Shaped like `lib/continuations/dispatch.ts`, and for its arithmetic: a
 * resumed turn is a scheduled run's size, so one a tick. The settled-with-a-
 * note half is a few writes and a delivery each with no model call, so a
 * couple ride along.
 */

/** How many resumed turns one tick may run. One, for the continuation's arithmetic. */
export const BATCH_SIZE = 1;

/** How many requests a tick may settle with a note. Each is a delivery. */
export const NOTES_PER_TICK = 2;

export type SettleDeps = {
  db: SupabaseClient;
  resume: typeof resumeApproved;
  note: typeof settleWithNote;
};

function resolve(env: RoutineEnv, overrides: Partial<SettleDeps>): SettleDeps {
  return {
    db: overrides.db ?? serviceClient(env),
    resume: overrides.resume ?? resumeApproved,
    note: overrides.note ?? settleWithNote,
  };
}

type ExpiredRow = {
  id: string;
  reason: "expired" | "interrupted";
  workspace_id: string;
  user_id: string;
  session_id: string;
  message_id: string | null;
  routine_run_id: string | null;
  origin: "routine" | "wake";
  summary: string | null;
};

export async function settleApprovals(
  env: RoutineEnv,
  overrides: Partial<SettleDeps> = {},
): Promise<{ settled: number }> {
  const { db, resume, note } = resolve(env, overrides);
  const passOn: Partial<ResumeDeps> = { db };
  let settled = 0;

  // A day with no answer, or a resume that never came back. Settled with a
  // note — never run again: a side effect may already have happened.
  const { data: ended, error: endedError } = await db.rpc("expire_unattended_approvals", {
    p_limit: NOTES_PER_TICK,
  });
  if (endedError) {
    console.error("could not expire unanswered requests", { code: endedError.code ?? null });
  }
  for (const row of (Array.isArray(ended) ? ended : []) as ExpiredRow[]) {
    try {
      await note(
        env,
        {
          id: row.id,
          origin: row.origin,
          workspaceId: row.workspace_id,
          userId: row.user_id,
          sessionId: row.session_id,
          messageId: row.message_id,
          routineRunId: row.routine_run_id,
          summary: row.summary ?? "",
        },
        row.reason,
        passOn,
      );
    } catch (err) {
      console.error("could not settle an unanswered request", row.id, err);
    }
    settled += 1;
  }

  // The answered ones, each handed out once (`resume_attempted_at`).
  const { data: claimed, error: claimError } = await db.rpc("claim_answered_approvals", {
    p_limit: BATCH_SIZE,
  });
  if (claimError) {
    console.error("could not claim answered requests", { code: claimError.code ?? null });
  }
  for (const row of (Array.isArray(claimed) ? claimed : []) as Array<Record<string, unknown>>) {
    const pause = pauseFromRow(row);
    try {
      const outcome = await resume(env, pause, passOn);
      if (outcome.kind === "failed") {
        // Left unsettled on purpose: the interrupted report says so, once,
        // after its fifteen minutes.
        console.error("a request could not be carried on", pause.id, outcome.error);
      }
    } catch (err) {
      console.error("carrying on with a request threw", pause.id, err);
    }
    settled += 1;
  }

  return { settled };
}
