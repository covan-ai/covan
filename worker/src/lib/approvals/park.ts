import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import type { AgentStep, PausedTurn } from "../harness/loop";
import { savePausedTurn, UNATTENDED_TTL_MS } from "../harness/turn";
import type { Mailer } from "../reports/mailer";
import { notifyApprovalRequest } from "./notify";

/**
 * Park a turn nobody is watching on the question it asked (0143).
 *
 * The same row a conversation's question is (`paused_turns`), with three
 * differences: it says where it came from, which run's report waits on it,
 * and it waits a day rather than an hour. The turn's own reply row is where
 * the person reads what the agent did so far and what it is asking — the
 * routine's conversation, or the woken conversation — so `messageId` is
 * required here where a conversation's park may have none.
 *
 * Through the service role, for `paused_turns`' reason (0060): no client role
 * may write the prompt the model is about to be shown. Every id comes from the
 * row the run or the wake-up was claimed from, never from the model.
 */

/** How many times one run may stop to ask. A sixth question is the report saying so. */
export const MAX_APPROVALS_PER_RUN = 5;

/**
 * The line a report gets when its run asked and could not be parked — a test
 * run, a sixth question, a conversation that could not be opened — which is
 * what every run said before 0143.
 */
export function stoppedShortNote(summary: string | undefined): string {
  return (
    `\n\n---\n\n_This run stopped short of "${summary || "an action"}" ` +
    "because it needs somebody to approve it, and it could not ask._"
  );
}

/** How long after its request expires a run is left alone by the two-hour sweep. */
export const HOLD_MARGIN_MS = 30 * 60 * 1000;

/** When a run that asks now is left to its request's expiry rather than the sweep. */
export function heldUntil(now: Date): Date {
  return new Date(now.getTime() + UNATTENDED_TTL_MS + HOLD_MARGIN_MS);
}

export type Parked =
  { kind: "parked"; id: string; expiresAt: Date } | { kind: "not_parked"; why: string };

export type ParkInput = {
  origin: "routine" | "wake";
  workspaceId: string;
  agentId: string;
  userId: string;
  sessionId: string;
  /** The reply the question hangs off. */
  messageId: string;
  routineRunId: string | null;
  model: string;
  paused: PausedTurn;
  steps: AgentStep[];
  now: Date;
};

/**
 * Park, then tell the person the turn runs as (`notify.ts`). The one call
 * every unattended surface makes, so a request is never parked without its
 * email — and an email that could not go is the Inbox's to show, not a reason
 * to undo the park.
 */
export async function parkAndAsk(
  env: RoutineEnv,
  db: SupabaseClient,
  mail: Mailer | null,
  input: ParkInput & { routineName: string | null },
): Promise<Parked> {
  const parked = await parkUnattended(db, input);
  if (parked.kind === "parked") {
    await notifyApprovalRequest(env, db, mail, {
      id: parked.id,
      userId: input.userId,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      routineName: input.routineName,
      summary: input.paused.summary ?? "",
      proposal: input.paused.proposal ?? null,
      expiresAt: parked.expiresAt,
    });
  }
  return parked;
}

export async function parkUnattended(db: SupabaseClient, input: ParkInput): Promise<Parked> {
  if (input.paused.reason !== "confirmation" || !input.paused.call) {
    return { kind: "not_parked", why: "nothing to ask" };
  }

  // The bound: a run that keeps asking is asking the wrong person. Counted per
  // run, or per conversation over the request's own day for a wake-up.
  let asked = db.from("paused_turns").select("id").limit(MAX_APPROVALS_PER_RUN);
  asked = input.routineRunId
    ? asked.eq("routine_run_id", input.routineRunId)
    : asked
        .eq("session_id", input.sessionId)
        .eq("origin", input.origin)
        .gte("created_at", new Date(input.now.getTime() - UNATTENDED_TTL_MS).toISOString());
  const { data: before, error: countError } = await asked;
  if (countError) return { kind: "not_parked", why: "could not count its earlier requests" };
  if ((before ?? []).length >= MAX_APPROVALS_PER_RUN) {
    return {
      kind: "not_parked",
      why: `it had already asked ${MAX_APPROVALS_PER_RUN} times on this run`,
    };
  }

  const expiresAt = new Date(input.now.getTime() + UNATTENDED_TTL_MS);
  const id = await savePausedTurn(db, {
    sessionId: input.sessionId,
    messageId: input.messageId,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    userId: input.userId,
    model: input.model,
    paused: input.paused,
    steps: input.steps,
    origin: input.origin,
    routineRunId: input.routineRunId,
    expiresAt,
  });
  if (!id) return { kind: "not_parked", why: "the request could not be saved" };

  if (input.routineRunId) {
    // What the run waits for, and until when the sweep leaves it to the
    // request's own expiry (`held.ts`).
    const { error } = await db
      .from("routine_runs")
      .update({ waiting_for: "approval", held_until: heldUntil(input.now).toISOString() })
      .eq("id", input.routineRunId);
    if (error) {
      console.error("could not mark a run as waiting on a person", input.routineRunId, error.code);
    }
  }
  return { kind: "parked", id, expiresAt };
}
