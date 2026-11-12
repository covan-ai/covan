import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentStep, PausedTurn } from "../harness/loop";
import { savePausedTurn, UNATTENDED_TTL_MS } from "../harness/turn";

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

/** How long after its request expires a run is left alone by the two-hour sweep. */
const HOLD_MARGIN_MS = 30 * 60 * 1000;

export type Parked =
  { kind: "parked"; id: string; expiresAt: Date } | { kind: "not_parked"; why: string };

export async function parkUnattended(
  db: SupabaseClient,
  input: {
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
  },
): Promise<Parked> {
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
      .update({
        waiting_for: "approval",
        held_until: new Date(expiresAt.getTime() + HOLD_MARGIN_MS).toISOString(),
      })
      .eq("id", input.routineRunId);
    if (error)
      console.error("could not mark a run as waiting on a person", input.routineRunId, error.code);
  }
  return { kind: "parked", id, expiresAt };
}
