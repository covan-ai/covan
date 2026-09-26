import type { SupabaseClient } from "@supabase/supabase-js";
import type { CompletionRequest, CompletionUsage } from "../lib/completion";
import {
  runAgentTurn,
  type AgentStep,
  type AgentTurn,
  type AgentTurnOptions,
  type PassUsage,
} from "../lib/harness/loop";
import { chatBudget } from "../lib/harness/budget";
import { writeSteps } from "../lib/harness/turn";
import type { AgentTool, ToolContext, ToolEnv } from "../lib/harness/registry";
import { isRuntimeLimit, type RuntimeLimitFlag } from "../lib/runtime-limit";

/**
 * The half of a chat turn that both chat routes do the same way.
 *
 * There are two of them — `POST /chat/stream` starts a turn and `POST
 * /chat/confirm/:id` finishes one that stopped to ask — and they are the same
 * machinery: the same loop, the same tools, the same salvage when it fails.
 * They were written months apart, and the second one is not a second
 * implementation on purpose so much as by accident: it drifted. It omits the
 * runtime-limit flag, so every platform ceiling reads to the person as *"The
 * assistant hit an error."*; it has no abort branch, so a closed tab is
 * reported as a failure; and its salvage writes an assistant row with every
 * token column null. Those are not three bugs, they are one missing seam.
 *
 * WHY IT LIVES HERE AND NOT IN `lib/harness/`. The harness is deliberately
 * runtime-agnostic — `lib/routines/agent-run.ts` imports it from the cron
 * Worker, and `registry.ts` takes `RoutineEnv` rather than `Bindings` for
 * exactly that reason. What is in this file needs a request: an SSE `send`, and
 * (at its callers) `recordQuota` and `deferred`. `lib/harness/turn.ts` is the
 * counter-example and stays where it is — it takes a bare `SupabaseClient` and
 * is already shared correctly.
 */

/**
 * The stand-in reply for a turn that died after doing work but before saying
 * anything.
 *
 * A tool turn writes its answer last, so the usual shape of a mid-turn failure
 * is several completed steps and no words at all. `message_steps.message_id`
 * has nowhere to point without a row, so this is the row — deliberately one
 * flat sentence that claims nothing about what the steps found.
 */
export const CUT_SHORT =
  "This turn stopped before it could answer. What it had already done is below.";

/**
 * What a tool is told about who is asking, built once so neither route can
 * leave a field out.
 *
 * `runtimeLimit` is the field this exists for. It is what lets the catch say
 * *"ask for something narrower"* instead of *"please try again"*, it is
 * optional on `ToolContext` because a scheduled run has no stream to explain
 * itself on — and the confirm route simply never passed one. Required here, so
 * that stops being a thing a caller can forget.
 *
 * Every id is resolved by the route from the session or the parked turn, never
 * read out of anything the model wrote. See `ToolContext` for why that rule is
 * the whole security posture of the harness.
 */
export function buildToolContext(input: {
  db: SupabaseClient;
  env: ToolEnv;
  workspaceId: string;
  agentId: string;
  userId: string;
  sessionId: string;
  runtimeLimit: RuntimeLimitFlag;
  /**
   * Whether a person has already said yes to the one call about to run.
   *
   * Only ever true for the single approved call on the resume path, and only
   * from the stored paused turn. The loop that runs afterwards is given
   * `confirmed: false` again by its caller — one yes is one call, not a
   * standing permission.
   */
  confirmed?: boolean;
}): ToolContext {
  return {
    db: input.db,
    env: input.env,
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    userId: input.userId,
    sessionId: input.sessionId,
    runtimeLimit: input.runtimeLimit,
    ...(input.confirmed ? { confirmed: true } : {}),
    // One per turn, so the same catalogue search asked twice is answered from
    // the first one. See `searchMemo` in `registry.ts`.
    searchMemo: new Map<string, string>(),
    // And what those searches offered, which is what `run_tool` is allowed to
    // run. Fresh and empty on both routes: on the resume, the approved call is
    // not consulted against it at all — the slug was checked when the call was
    // proposed, and asking again after a person said yes would be a second
    // opinion nobody wanted — and the loop that follows repopulates it from
    // its own `find_tool` results. See `offeredSlugs` in `registry.ts`.
    offeredSlugs: new Set<string>(),
    // And the schemas behind those slugs, so `run_tool` can refuse a call whose
    // arguments contradict one instead of paying Composio to say so. Same
    // lifetime and same provenance as the set above.
    offeredSchemas: new Map<string, Record<string, unknown>>(),
  };
}

/**
 * What a turn has produced so far — readable after it throws.
 *
 * Every field here is also on the `AgentTurn` the loop returns, and that is
 * exactly the problem this solves: a turn that throws returns nothing, so the
 * route's own variables are still empty at the `catch` and the work that
 * really happened — tool calls made, money really spent at Composio, model
 * passes really billed — goes unrecorded. Filled as the turn runs, through
 * `onStep` and `onPass`.
 */
export type TurnSpend = {
  /** What reached the screen, in the order it reached it. */
  text: string;
  steps: AgentStep[];
  passes: PassUsage[];
};

/** A fresh record for one turn. */
export function turnSpend(): TurnSpend {
  return { text: "", steps: [], passes: [] };
}

/**
 * What the passes cost, summed the way the loop sums them.
 *
 * Null rather than zero when nothing was reported, and that distinction is
 * load-bearing in both directions: `recordQuota` refuses a zero and would bill
 * nothing, and a row written with zeros claims a turn was free when the truth
 * is that nobody counted. A turn that made no model call at all is the only
 * one that should read null.
 */
export function spentUsage(spend: TurnSpend): CompletionUsage {
  const sum = (pick: (p: PassUsage) => number | null | undefined): number | null => {
    const seen = spend.passes.map(pick).filter((n) => n !== null && n !== undefined);
    return seen.length === 0 ? null : seen.reduce((a, b) => a + b, 0);
  };
  return {
    promptTokens: sum((p) => p.prompt),
    completionTokens: sum((p) => p.completion),
    cachedTokens: sum((p) => p.cached),
    cacheWriteTokens: sum((p) => p.written),
    reasoningTokens: sum((p) => p.reasoning),
  };
}

/**
 * Run the turn, streaming it to the browser and keeping the record.
 *
 * The only place either route reaches `runAgentTurn`, which is what the
 * `budget` default below is for: **neither route passes a budget today**, so
 * both fall through to the harness default and agree with each other by
 * accident. The moment one of them passes one they diverge in silence, and the
 * one that would diverge is the resume — a turn that paused at step seven and
 * came back with a fresh, bare ceiling. Defaulted here rather than at each call
 * site so a third caller cannot forget.
 */
export async function runChatTurn(opts: {
  env: ToolEnv;
  /** Model, messages and every completion knob. `tools` is set by the loop. */
  request: Omit<CompletionRequest, "tools">;
  tools: AgentTool[];
  ctx: ToolContext;
  /** Steps spent before this call, so a resume continues its budget. */
  stepsSoFar?: AgentStep[];
  signal?: AbortSignal;
  /** Taken from `AgentTurnOptions` rather than restated, so a knob added to the
   * harness's budget cannot become one this seam silently refuses to pass. */
  budget?: AgentTurnOptions["budget"];
  send: (event: Record<string, unknown>) => void;
  /** Filled as the turn runs. The caller's `catch` reads it. */
  spend: TurnSpend;
}): Promise<AgentTurn> {
  const { send, spend } = opts;
  return runAgentTurn({
    env: opts.env,
    request: opts.request,
    tools: opts.tools,
    ctx: opts.ctx,
    ...(opts.stepsSoFar ? { stepsSoFar: opts.stepsSoFar } : {}),
    signal: opts.signal,
    budget: opts.budget ?? chatBudget(opts.env),
    onEvent: (event) => {
      if (event.type === "delta") {
        spend.text += event.text;
        send({ type: "delta", text: event.text });
      } else if (event.type === "thinking") {
        // Forwarded and not kept. The reasoning is context for the answer while
        // somebody is watching it appear, not part of the answer: it is not
        // written to the row, so it is not in the transcript and not re-sent as
        // history on the next turn. Adding it to `spend.text` would put an
        // account of the model's deliberation into the reply itself.
        send({ type: "thinking", text: event.text });
      } else {
        // An event type the client may not know. The dispatch chain in the chat
        // screen ignores what it cannot name, so an older build keeps working
        // and simply shows no steps.
        send({
          type: "step",
          index: event.index,
          tool: event.tool,
          status: event.status,
          label: event.label,
        });
      }
    },
    // Kept as well as shown: the only copies that survive this throwing.
    onStep: (step) => spend.steps.push(step),
    onPass: (usage) => spend.passes.push(usage),
  });
}

/** Whether this is the person closing the tab rather than the turn failing. */
export function isAbort(err: unknown, signal: AbortSignal): boolean {
  return (err as { name?: string } | null)?.name === "AbortError" || signal.aborted;
}

/**
 * Two sentences, because they ask for different things.
 *
 * "Please try again" is right for a far end that failed and will probably work
 * next time. It is wrong for a turn that ran out of the requests one invocation
 * may make: trying the same question again runs into the same ceiling, and the
 * thing that helps is asking for less. Saying so is the difference between a
 * person retrying four times and a person narrowing the question.
 *
 * The flag rather than only `err`, because by the time an error reaches a catch
 * it has been through an SDK and says `Connection error.` — see
 * `lib/runtime-limit.ts` for why that disguise costs an evening.
 */
export function explainTurnFailure(err: unknown, runtimeLimit: RuntimeLimitFlag): string {
  return runtimeLimit.hit || isRuntimeLimit(err)
    ? "This turn ran out of the requests it is allowed to make. Ask for something " +
        "narrower, or break the question into two."
    : "The assistant hit an error. Please try again.";
}

/**
 * Keep what the turn managed to do, rather than only saying it failed.
 *
 * A turn is up to `MAX_STEPS` tool calls, and one dropped connection on the
 * last of them used to throw away every one that had really run: mail really
 * sent, issues really filed, money really spent at Composio — with no record
 * anywhere that it happened. Measured on the first of these in production: an
 * OpenAI `Connection error.` 114 seconds into a turn, and the transcript kept
 * nothing at all.
 *
 * So: whatever the model said, plus every step that settled, plus what the
 * passes cost. When the model had not said anything yet — the common case,
 * because the answer is written last — the steps still need a row to hang off,
 * so `CUT_SHORT` stands in for one.
 *
 * **The token columns are the half that was missing**, and they were missing on
 * both routes for the same reason: the totals only exist once `runAgentTurn`
 * returns. `spentUsage` reads them off the passes instead, so a salvaged row
 * says what it cost and `recordQuota` has a number to bill rather than a zero
 * it refuses.
 */
export async function salvagePartial(input: {
  service: SupabaseClient;
  spend: TurnSpend;
  /**
   * Steps from before this request that it is nonetheless answerable for.
   *
   * The resume's case: `resolvePausedTurn` has already claimed the row, so a
   * second attempt would find nothing to resume. If this request drops the
   * steps it carried in, nothing else will ever write them.
   */
  carried?: AgentStep[];
  /** True when the route already wrote its row. Nothing left to salvage into. */
  persisted: boolean;
  /** Write the row and answer with it, or with null if there was nowhere to write. */
  persist: (
    text: string,
    usage: CompletionUsage & { passUsage: PassUsage[] },
  ) => Promise<{ id: string } | null>;
}): Promise<void> {
  if (input.persisted) return;
  const steps = [...(input.carried ?? []), ...input.spend.steps];
  const said = input.spend.text.trim().length > 0;
  const partial = said ? input.spend.text : steps.length > 0 ? CUT_SHORT : "";
  // Nothing ran and nothing was said, so there is nothing to keep. A
  // placeholder here would be a message about an event rather than a reply.
  if (!partial) return;

  // Wrapped, because a failure while salvaging must still leave the caller free
  // to terminate its stream: an unsent `error` is a client spinning until its
  // connection times out.
  try {
    const row = await input.persist(partial, {
      ...spentUsage(input.spend),
      passUsage: input.spend.passes,
    });
    if (row) await writeSteps(input.service, row.id, steps);
  } catch (err) {
    console.error("could not save the partial", err);
  }
}
