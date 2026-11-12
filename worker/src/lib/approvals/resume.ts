import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { agentAccessFor } from "../agent-access";
import { nudge } from "../browser/deliver";
import { completionSpend, entitlementsFor, spends, type Entitlements } from "../entitlements";
import { capabilitiesFor } from "../harness/available";
import { routineBudget, SCHEDULED_MAX_STEPS } from "../harness/budget";
import { runAgentTurn, type PassUsage } from "../harness/loop";
import type { RoutineBrowser, ToolContext, ToolEnv } from "../harness/registry";
import { answerPausedCall, approvedOperation } from "../harness/resume";
import { writeSteps, type StoredPause } from "../harness/turn";
import {
  addUsage,
  replyOutcome,
  sumOverPasses,
  usageColumns,
  usageOfRow,
  type TurnUsage,
} from "../harness/usage";
import { resolveModel } from "../models";
import { maxTokensFor, reasoningEffortFor, temperatureFor } from "../prompt";
import { knowledgeScopeOf } from "../routines/executor";
import { completeHeldRun } from "../routines/held";
import { serviceClient } from "../supabase";
import { parkUnattended } from "./park";

/**
 * Carrying on after somebody answered a request nobody was watching (0143).
 *
 * The cron's half of `POST /chat/confirm/:id`. The answer was written by
 * whoever gave it (`answer_approval`), on the app's page or by replying to
 * the email; the claim (`claim_answered_approvals`) handed the row to this
 * tick once and never again. What happens here:
 *
 *  1. **Everything is asked again**, because a day can pass between the
 *     question and the answer: the conversation is still the owner's, the
 *     owner is still a member and may still use the agent, the routine is
 *     still on and its run still waiting, and the workspace still has
 *     credits. Any "no" ends the run with a note, and nothing runs.
 *  2. The approved call runs, and the rest of its batch after it
 *     (`answerPausedCall`, shared with the conversation's route).
 *  3. The rest of the turn runs as a scheduled run does — the same tools, the
 *     same step budget — and its words are written onto the same reply, so
 *     the thread shows both halves as one answer.
 *  4. The report goes out (`completeHeldRun`), or for a woken conversation
 *     the owner is told it came back.
 *
 * **Never twice.** `resumed_at` is stamped when this finishes; a resume that
 * dies first is not retried — `expire_unattended_approvals` reports it after
 * fifteen minutes as interrupted, because a side effect may already have
 * happened and nobody can tell from here whether it did.
 *
 * **Why the service role**, and what bounds it, is `lib/continuations/run.ts`'s
 * answer: a tick has no JWT, every id comes from the one row the claim handed
 * over, and the owner is checked before anything is read on their behalf.
 */

export type ResumeDeps = {
  db: SupabaseClient;
  now: () => Date;
  turn: typeof runAgentTurn;
  capabilities: typeof capabilitiesFor;
  entitlements: Entitlements;
  answer: typeof answerPausedCall;
  completeHeld: typeof completeHeldRun;
  nudge: typeof nudge;
};

function resolve(env: RoutineEnv, overrides: Partial<ResumeDeps>): ResumeDeps {
  return {
    db: overrides.db ?? serviceClient(env),
    now: overrides.now ?? (() => new Date()),
    turn: overrides.turn ?? runAgentTurn,
    capabilities: overrides.capabilities ?? capabilitiesFor,
    entitlements: overrides.entitlements ?? entitlementsFor(env),
    answer: overrides.answer ?? answerPausedCall,
    completeHeld: overrides.completeHeld ?? completeHeldRun,
    nudge: overrides.nudge ?? nudge,
  };
}

/** How a request was settled, for the dispatcher's log. */
export type Settled =
  | { kind: "carried_on" }
  | { kind: "asked_again" }
  | { kind: "noted"; note: string }
  | { kind: "failed"; error: string };

/** What the cron knows about a request it settles without carrying on. */
export type Unanswered = {
  id: string;
  origin: StoredPause["origin"];
  workspaceId: string;
  userId: string;
  sessionId: string;
  messageId: string | null;
  routineRunId: string | null;
  summary: string;
};

/** Why a request is settled with a note and no model call. */
export type NoteReason = "declined" | "expired" | "interrupted" | { refused: string };

/** The line written under the reply, and into the report. */
export function noteFor(reason: NoteReason, summary: string): string {
  const what = summary.trim() ? `"${summary.trim()}"` : "the action it asked about";
  if (reason === "declined") return `_${capital(what)} was declined, so it was not done._`;
  if (reason === "expired") {
    return `_Nobody answered within 24 hours, so ${what} was not done._`;
  }
  if (reason === "interrupted") {
    return (
      `_${capital(what)} was approved, but carrying on was cut off. ` +
      "Check whether it happened before asking for it again._"
    );
  }
  return `_${capital(what)} was approved, but could not be carried on: ${reason.refused}. Nothing was done._`;
}

function capital(text: string): string {
  return text.startsWith('"') ? `"${text.charAt(1).toUpperCase()}${text.slice(2)}` : text;
}

type RunSide = {
  runId: string;
  routine: {
    id: string;
    user_id: string;
    visibility: string | null;
    browser_access: string | null;
    timezone: string | null;
  };
};

export async function resumeApproved(
  env: RoutineEnv,
  pause: StoredPause,
  overrides: Partial<ResumeDeps> = {},
): Promise<Settled> {
  const deps = resolve(env, overrides);
  const { db } = deps;
  const unanswered = asUnanswered(pause);
  if (pause.status === "declined") {
    return settleWithNote(env, unanswered, "declined", overrides);
  }
  const refuse = (why: string) => settleWithNote(env, unanswered, { refused: why }, overrides);

  // 1. Everything again.
  const { data: session, error: sessionError } = await db
    .from("chat_sessions")
    .select("id, user_id, visibility, deleted_at")
    .eq("id", pause.sessionId)
    .maybeSingle();
  if (sessionError) return { kind: "failed", error: `conversation: ${sessionError.code}` };
  if (!session || session.deleted_at || session.user_id !== pause.userId) {
    return refuse("its conversation is gone");
  }
  const { data: membership, error: membershipError } = await db
    .from("workspace_members")
    .select("user_id")
    .eq("workspace_id", pause.workspaceId)
    .eq("user_id", pause.userId)
    .maybeSingle();
  if (membershipError) return { kind: "failed", error: `membership: ${membershipError.code}` };
  if (!membership) return refuse("the person it runs as is no longer in this workspace");
  if (!(await agentAccessFor(db, pause.agentId, pause.userId))) {
    return refuse("the person it runs as can no longer use this agent");
  }

  let run: RunSide | null = null;
  if (pause.routineRunId) {
    const side = await runSide(db, pause.routineRunId);
    if (side.kind === "refused") return refuse(side.why);
    if (side.kind === "failed") return { kind: "failed", error: side.error };
    run = side.value;
  }

  const verdict = await deps.entitlements.check(pause.workspaceId);
  if (!verdict.allowed) return refuse("this workspace has no credits left");

  const { data: agent, error: agentError } = await db
    .from("agents")
    .select("model, temperature, reasoning_effort, web_search")
    .eq("id", pause.agentId)
    .eq("workspace_id", pause.workspaceId)
    .is("deleted_at", null)
    .maybeSingle();
  if (agentError) return { kind: "failed", error: `agent: ${agentError.code}` };
  if (!agent) return refuse("its agent is gone");

  // 2. The approved call, then the rest of its batch.
  const toolEnv = env as ToolEnv;
  const routineBrowser: RoutineBrowser | undefined =
    run?.routine.browser_access === "all"
      ? { conversation: async () => pause.sessionId, started: [] }
      : undefined;
  const ctx: ToolContext = {
    db,
    env: toolEnv,
    workspaceId: pause.workspaceId,
    agentId: pause.agentId,
    userId: pause.userId,
    sessionId: pause.sessionId,
    // The marker every tool reads as "nobody is watching": the run's id for
    // a routine, the wake-up's shape for a conversation.
    ...(run
      ? { routineRunId: run.runId }
      : { continuation: { id: `approval:${pause.id}`, browserApproved: false } }),
    knowledgeScope: run
      ? knowledgeScopeOf(run.routine)
      : session.visibility === "private"
        ? { viewer: pause.userId }
        : { sharedOnly: true },
    ...(routineBrowser ? { routineBrowser } : {}),
    searchMemo: new Map<string, string>(),
    describeMemo: new Map<string, string>(),
    offeredSlugs: new Set<string>(),
    offeredOperations: approvedOperation(pause.proposal),
  };
  const answered = await deps.answer({
    pause,
    approve: true,
    ctx: { ...ctx, confirmed: true },
    loadTools: async () =>
      (
        await deps.capabilities({
          db,
          env: toolEnv,
          workspaceId: pause.workspaceId,
          userId: pause.userId,
          surface: "schedule",
          browser: Boolean(routineBrowser),
          agentId: pause.agentId,
        })
      ).tools,
  });

  const model = pause.model ?? resolveModel((agent.model as string | null) ?? null, env);
  const messageId = pause.messageId;
  if (!messageId) return { kind: "failed", error: "the request has no reply to carry on" };

  // A later call of the batch asked in its own right: parked again on it,
  // before the model runs, as the conversation's route does.
  if (answered.asked) {
    await writeSteps(db, messageId, answered.steps);
    const again = await parkUnattended(db, {
      origin: pause.origin === "wake" ? "wake" : "routine",
      workspaceId: pause.workspaceId,
      agentId: pause.agentId,
      userId: pause.userId,
      sessionId: pause.sessionId,
      messageId,
      routineRunId: pause.routineRunId,
      model,
      paused: {
        reason: "confirmation",
        messages: answered.messages,
        call: answered.asked.call,
        summary: answered.asked.summary,
        proposal: answered.asked.proposal,
      },
      steps: answered.steps,
      now: deps.now(),
    });
    await stampResumed(db, pause.id, deps.now());
    if (again.kind === "parked") return { kind: "asked_again" };
    return settleWithNote(
      env,
      { ...unanswered, summary: answered.asked.summary },
      { refused: `it asked again and ${again.why}` },
      overrides,
    );
  }

  // 3. The rest of the turn, as a scheduled run does it.
  const passesSoFar: PassUsage[] = [];
  const holdId = crypto.randomUUID();
  const kind = run ? "routine" : "reply";
  const spentSoFar = () =>
    spends(
      completionSpend(
        model,
        {
          promptTokens: sumOverPasses(passesSoFar, (p) => p.prompt),
          completionTokens: sumOverPasses(passesSoFar, (p) => p.completion),
          cachedTokens: sumOverPasses(passesSoFar, (p) => p.cached),
          cacheWriteTokens: sumOverPasses(passesSoFar, (p) => p.written),
          reasoningTokens: sumOverPasses(passesSoFar, (p) => p.reasoning),
          webSearches: sumOverPasses(passesSoFar, (p) => p.searches),
        },
        kind,
      ),
    );
  const hold = deps.entitlements.hold?.bind(deps.entitlements);
  const turn = await deps.turn({
    env,
    onPass: (usage) => passesSoFar.push(usage),
    ...(hold ? { mayContinue: () => hold(pause.workspaceId, holdId, spentSoFar()) } : {}),
    request: {
      model,
      messages: answered.messages,
      temperature: temperatureFor("normal", agent.temperature as number | null),
      reasoningEffort: reasoningEffortFor(agent.reasoning_effort as string | null),
      maxTokens: maxTokensFor("normal"),
      webSearch: run ? agent.web_search === true : false,
    },
    tools: answered.tools,
    // One yes is one call: the turn after it asks again for anything else.
    ctx: { ...ctx, confirmed: false },
    stepsSoFar: answered.steps,
    budget: run ? routineBudget(env) : { maxSteps: SCHEDULED_MAX_STEPS },
  });
  await deps.entitlements.release?.(holdId).catch((err: unknown) => {
    console.error("could not release a resumed turn's credit hold", err);
  });

  // The turn asked again, of something else: parked on that, with the words
  // so far on the reply.
  let note: string | null = null;
  let parkedAgain = false;
  if (turn.paused?.reason === "confirmation") {
    const again = await parkUnattended(db, {
      origin: pause.origin === "wake" ? "wake" : "routine",
      workspaceId: pause.workspaceId,
      agentId: pause.agentId,
      userId: pause.userId,
      sessionId: pause.sessionId,
      messageId,
      routineRunId: pause.routineRunId,
      model,
      paused: turn.paused,
      steps: turn.steps,
      now: deps.now(),
    });
    parkedAgain = again.kind === "parked";
    if (!parkedAgain) {
      note = noteFor(
        { refused: `it asked again and ${again.kind === "not_parked" ? again.why : ""}` },
        turn.paused.summary ?? "",
      );
    }
  }

  const said = turn.text.trim();
  const addition = [said, note].filter(Boolean).join("\n\n");
  const reply = await appendToReply(db, messageId, addition, {
    usage: { ...turn.usage, passes: turn.passes },
    model,
    outcome: replyOutcome({
      paused: turn.paused ?? null,
      finishReason: turn.finishReason,
      parked: parkedAgain,
      said: said.length > 0,
    }),
  });
  await writeSteps(db, messageId, turn.steps);
  await db
    .from("chat_sessions")
    .update({ updated_at: deps.now().toISOString() })
    .eq("id", pause.sessionId);

  const charge = spends(completionSpend(model, turn.usage, kind));
  if (charge.length > 0) {
    try {
      await deps.entitlements.record(pause.workspaceId, charge, {
        userId: pause.userId,
        sessionId: pause.sessionId,
        messageId,
        ...(run ? { routineRunId: run.runId } : {}),
      });
    } catch (err) {
      console.error("could not charge for a resumed turn", pause.id, err);
    }
  }

  await stampResumed(db, pause.id, deps.now());
  if (parkedAgain) return { kind: "asked_again" };

  // 4. The report, or the owner told it came back.
  if (pause.routineRunId) {
    await sendReport(env, deps, pause.routineRunId, addition);
  } else {
    await deps.nudge(
      env,
      db,
      pause.userId,
      { subject: "Your agent carried on", body: reply ?? addition },
      pause.id,
    );
  }
  return { kind: "carried_on" };
}

/**
 * Settle a request with a line and no model call: a "no", a day with no
 * answer, a resume that never came back, or a yes that could not be carried
 * on. The line goes under the reply in the thread and into the report, which
 * then goes out with what the run had.
 */
export async function settleWithNote(
  env: RoutineEnv,
  row: Unanswered,
  reason: NoteReason,
  overrides: Partial<ResumeDeps> = {},
): Promise<Settled> {
  const deps = resolve(env, overrides);
  const note = noteFor(reason, row.summary);
  try {
    if (row.messageId) await appendToReply(deps.db, row.messageId, note);
    await stampResumed(deps.db, row.id, deps.now());
    if (row.routineRunId) {
      await sendReport(env, deps, row.routineRunId, note);
    } else if (reason === "expired" || reason === "interrupted") {
      // The person who declined knows; somebody who never answered, or whose
      // yes was cut off, is told in the place their agent tells them things.
      await deps.nudge(
        env,
        deps.db,
        row.userId,
        { subject: "Your agent stopped waiting", body: note },
        row.id,
      );
    }
    return { kind: "noted", note };
  } catch (err) {
    console.error("could not settle a request", row.id, err);
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

export function asUnanswered(pause: StoredPause): Unanswered {
  return {
    id: pause.id,
    origin: pause.origin,
    workspaceId: pause.workspaceId,
    userId: pause.userId,
    sessionId: pause.sessionId,
    messageId: pause.messageId,
    routineRunId: pause.routineRunId,
    summary: pause.summary,
  };
}

/**
 * The run's draft, with what came after the question written onto it, sent.
 * Leaving the person's wait is what the run row says first, so a browser
 * task's settle that arrives meanwhile composes from the new draft.
 */
async function sendReport(
  env: RoutineEnv,
  deps: ResumeDeps,
  runId: string,
  addition: string,
): Promise<void> {
  const { data: runRow } = await deps.db
    .from("routine_runs")
    .select("summary, status")
    .eq("id", runId)
    .maybeSingle();
  if (!runRow || runRow.status !== "waiting") return;
  const report = joinHalves(typeof runRow.summary === "string" ? runRow.summary : "", addition);
  const { error } = await deps.db
    .from("routine_runs")
    .update({ summary: report, waiting_for: null })
    .eq("id", runId)
    .eq("status", "waiting");
  if (error) console.error("could not write a run's draft after its request", runId, error.code);
  await deps.completeHeld(env, runId, { db: deps.db }, { report });
}

async function runSide(
  db: SupabaseClient,
  runId: string,
): Promise<
  | { kind: "ok"; value: RunSide }
  | { kind: "refused"; why: string }
  | { kind: "failed"; error: string }
> {
  const { data: runRow, error: runError } = await db
    .from("routine_runs")
    .select("id, routine_id, status")
    .eq("id", runId)
    .maybeSingle();
  if (runError) return { kind: "failed", error: `run: ${runError.code}` };
  if (!runRow) return { kind: "refused", why: "its run is gone" };
  if (runRow.status !== "waiting") return { kind: "refused", why: "its run has already finished" };
  const { data: routine, error: routineError } = await db
    .from("routines")
    .select("id, user_id, visibility, browser_access, timezone, status, deleted_at")
    .eq("id", String(runRow.routine_id))
    .maybeSingle();
  if (routineError) return { kind: "failed", error: `routine: ${routineError.code}` };
  if (!routine || routine.deleted_at) return { kind: "refused", why: "its routine is gone" };
  if (routine.status !== "active") return { kind: "refused", why: "its routine is no longer on" };
  return {
    kind: "ok",
    value: {
      runId,
      routine: {
        id: String(routine.id),
        user_id: String(routine.user_id),
        visibility: (routine.visibility as string | null) ?? null,
        browser_access: (routine.browser_access as string | null) ?? null,
        timezone: (routine.timezone as string | null) ?? null,
      },
    },
  };
}

/** Once: the claim was `resume_attempted_at`; this is the end of it. */
async function stampResumed(db: SupabaseClient, id: string, now: Date): Promise<void> {
  const { error } = await db
    .from("paused_turns")
    .update({ resumed_at: now.toISOString() })
    .eq("id", id)
    .is("resumed_at", null);
  if (error) console.error("could not mark a request as carried on", id, error.code);
}

/**
 * Write the rest of the answer onto the reply that asked, as the
 * conversation's route does (`persistAssistant`): one reply, two halves, and
 * what each half spent added rather than written over.
 */
async function appendToReply(
  db: SupabaseClient,
  messageId: string,
  text: string,
  spent?: { usage: TurnUsage; model: string; outcome: string },
): Promise<string | null> {
  const { data: prior } = await db
    .from("messages")
    .select(
      "content, prompt_tokens, completion_tokens, cached_tokens, cache_write_tokens, reasoning_tokens, pass_usage",
    )
    .eq("id", messageId)
    .maybeSingle();
  if (!prior) return null;
  const content = joinHalves(typeof prior.content === "string" ? prior.content : "", text);
  const { error } = await db
    .from("messages")
    .update({
      content,
      ...(spent
        ? {
            ...usageColumns(addUsage(usageOfRow(prior as Record<string, unknown>), spent.usage)),
            model: spent.model,
            outcome: spent.outcome,
          }
        : {}),
    })
    .eq("id", messageId);
  if (error) {
    console.error("could not write the rest of a reply", messageId, error.code);
    return null;
  }
  return content;
}

/** The two halves of one reply, joined with nothing between them. */
function joinHalves(before: string, addition: string): string {
  if (!before.trim()) return addition;
  if (!addition.trim()) return before;
  return `${before}\n\n${addition}`;
}
