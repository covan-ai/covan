import type { ComposioTool } from "../composio/client";
import type { CompletionMessage, ToolCall } from "../completion";
import { cap, MAX_TOOL_OUTPUT_CHARS, TOOL_TIMEOUT_MS } from "./budget";
import {
  answerUnanswered,
  NOT_RUN_FOR_A_QUESTION,
  oneCard,
  parseArguments,
  runToolCall,
  runWithTimeout,
  type AgentStep,
  type HarnessEvent,
} from "./loop";
import { toolByName, type AgentTool, type RunApproval, type ToolContext } from "./registry";
import type { StoredPause } from "./turn";

/**
 * The answer to a parked call, acted on: the call a person approved run (or
 * declined), the rest of its batch run after it, and the transcript the rest
 * of the turn goes on with.
 *
 * Out of `POST /chat/confirm/:id` because two things carry on from a yes
 * now: that route, for a conversation, in the request that said yes; and the
 * cron, for a routine's run or a woken turn that nobody was watching when it
 * asked (0143, `lib/approvals/resume.ts`). One copy, so a yes means the same
 * thing in both — the same timeout, the same capped result, the same rule for
 * which of the batch's later calls the card covered.
 *
 * What it does not do is run the model. The route streams the rest of the
 * turn to the person who pressed the button; the cron runs it with nobody
 * watching. Each brings its own `runAgentTurn` call to what this returns.
 */

/**
 * What the model is told when a person says no.
 *
 * A refusal is a fact about the world, not an error, and the difference
 * matters to what happens next: told "error", a model retries: told "the
 * person declined", it acknowledges and moves on. It is written as the tool's
 * own result rather than as a new user turn because that is what it is — the
 * answer to the call the model made.
 */
export const DECLINED_RESULT =
  "The person declined this. Do not try it again in this turn. Acknowledge it briefly and " +
  "carry on with whatever else was asked.";

/**
 * The catalogue row carried in an approved `run_tool` proposal, as the map
 * `ToolContext.offeredOperations` is.
 *
 * Read defensively because the column is `jsonb` and because the shape is only
 * ever as good as the turn that wrote it: a row with no slug has no key, and
 * one with no toolkit cannot answer the check it exists for. Either way the
 * answer is an empty map rather than a half-filled entry — an operation
 * assembled out of guesses would have the approved call checked against
 * fiction, which is worse than checking it against nothing.
 */
export function approvedOperation(proposal: unknown): Map<string, ComposioTool> {
  const empty = new Map<string, ComposioTool>();
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return empty;
  const row = proposal as Record<string, unknown>;
  if (row.kind !== "run_tool") return empty;
  const operation = row.operation;
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) return empty;
  const candidate = operation as Record<string, unknown>;
  if (typeof candidate.slug !== "string" || typeof candidate.toolkit !== "string") return empty;
  return new Map([[candidate.slug, candidate as unknown as ComposioTool]]);
}

/** A step event, as the stream sends it. */
type StepEvent = Extract<HarnessEvent, { type: "step" }>;

export type AnsweredCall = {
  /** Every step of the turn so far, the approved one resolved in place. */
  steps: AgentStep[];
  /** The transcript the rest of the turn runs on. */
  messages: CompletionMessage[];
  /** The tools the rest of the turn may use. */
  tools: AgentTool[];
  /**
   * A later call of the batch that asked in its own right. The turn parks
   * again on it, before the model runs, with the calls after it unanswered.
   */
  asked: { call: ToolCall; summary: string; proposal: unknown } | null;
  /** Whether the approved call itself answered without an error. */
  ran: boolean;
};

/** The calls after `id` in its batch: the last assistant turn that asked for any. */
function laterInBatch(messages: CompletionMessage[], id: string): ToolCall[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && message.toolCalls?.length) {
      const at = message.toolCalls.findIndex((call) => call.id === id);
      return at === -1 ? [] : message.toolCalls.slice(at + 1);
    }
  }
  return [];
}

/** What `id` was answered, if anything. */
function answerTo(messages: CompletionMessage[], id: string): string | null {
  const found = messages.find((message) => message.role === "tool" && message.toolCallId === id);
  return found?.role === "tool" ? found.content : null;
}

/** `messages` with the answer to `id` replaced, where it stands. */
function answerInPlace(
  messages: CompletionMessage[],
  id: string,
  content: string,
): CompletionMessage[] {
  return messages.map((message) =>
    message.role === "tool" && message.toolCallId === id ? { ...message, content } : message,
  );
}

export async function answerPausedCall(input: {
  pause: StoredPause;
  approve: boolean;
  /**
   * The context the approved call runs in: `confirmed`, and the proposal the
   * half that asked parked (`approvedProposal` in `buildToolContext`). The
   * rest of the batch is handed the same context with `confirmed` set per
   * call.
   */
  ctx: ToolContext;
  /** The tools the rest of the turn may use, asked for once the approved call has run. */
  loadTools: () => Promise<AgentTool[]>;
  signal?: AbortSignal;
  /** Each step as it settles, for a stream. */
  send?: (event: StepEvent) => void;
  /**
   * The steps the moment the approved call is resolved, before anything else
   * can throw. The route's salvage writes them if the rest of the request
   * dies: the claim already marked the row answered, so nothing else ever
   * would.
   */
  onSettled?: (steps: AgentStep[]) => void;
}): Promise<AnsweredCall> {
  const { pause, approve, ctx, signal } = input;
  const send = input.send ?? (() => {});
  const tool = approve ? toolByName(pause.toolCall.name) : null;
  const started = Date.now();
  const parsedArgs = parseArguments(pause.toolCall.arguments);
  const result = await (async (): Promise<
    { kind: "ok"; content: string; approval?: RunApproval } | { kind: "error"; message: string }
  > => {
    if (!approve) return { kind: "error", message: DECLINED_RESULT };
    if (!tool) return { kind: "error", message: `no tool named ${pause.toolCall.name}` };
    // Through the harness's own runner rather than called directly, which
    // is what this path was doing. Every other tool call in the product
    // is time-boxed; the one a person had just approved was not, so a
    // connected app that hung held the stream open until the client gave
    // up. `runWithTimeout` also delivers the ceiling as a signal, so the
    // tool's own `fetch` is cancelled rather than left running with
    // nobody to receive it — and it answers with an error rather than
    // throwing, which is why the try that used to wrap this is gone.
    const ran = await runWithTimeout(
      tool,
      parsedArgs.ok ? parsedArgs.args : {},
      ctx,
      TOOL_TIMEOUT_MS,
      signal,
    );
    // A tool that asks again having been told yes is a tool that has not
    // read `ctx.confirmed`, which is a bug in the tool rather than a
    // second question for the person. Reported as an error so it is
    // visible instead of parking the turn a second time.
    if (ran.kind === "needs_confirmation") {
      return { kind: "error", message: "this tool asked for confirmation twice" };
    }
    return ran;
  })();

  /**
   * What the model is handed for the call it just approved.
   *
   * Capped, which this path did not do — `loop.ts` puts every other tool
   * result through `MAX_TOOL_OUTPUT_CHARS` and this one went through
   * whole. That was survivable while confirmation was rare; `run_tool`
   * asks on every call, so the tool carrying most of today's traffic was
   * the one tool with no output budget at all. An uncapped result is not
   * paid for once either: it joins the transcript and is re-sent on every
   * later pass of the turn, which at a hard ceiling of thirty-two is the
   * expensive end of a square. (This said "sixteen" — a number that was
   * reverted the day after it shipped and never ran. See `MAX_STEPS`.)
   *
   * One string for all three uses below — what the model reads, what the
   * transcript keeps, and the length that is measured — because they were
   * three expressions of the same thing and only two of them agreed.
   */
  const resolved =
    result.kind === "ok" ? cap(result.content, MAX_TOOL_OUTPUT_CHARS) : `error: ${result.message}`;

  // The pending step, resolved. Its index is kept so the numbering the
  // person already saw does not move under them. Found by its status
  // rather than taken as the last: the later calls of its batch are
  // recorded after it, as refused (`NOT_RUN_FOR_A_QUESTION`).
  const at = pause.steps.findLastIndex((step) => step.status === "pending");
  const steps = pause.steps.map((step, i) =>
    i === at
      ? {
          ...step,
          status:
            result.kind === "ok"
              ? ("ok" as const)
              : approve
                ? ("failed" as const)
                : ("refused" as const),
          resultExcerpt: resolved,
          // The person's yes, which is what lets the rest of the turn
          // treat this operation as approved (`approvedSlugsFrom`).
          ...(result.kind === "ok" && result.approval ? { approval: result.approval } : {}),
          // The pause wrote this row with no `result_chars`, because at
          // that point nothing had been put in front of the model. Now
          // something has. Leaving it null made every confirmed call
          // invisible to the only measurement that can size the tool
          // budget — and confirmed calls are most of them.
          resultChars: resolved.length,
          durationMs: Date.now() - started,
        }
      : step,
  );
  input.onSettled?.(steps);
  const settled = at === -1 ? steps[steps.length - 1] : steps[at];
  send({
    type: "step",
    index: settled?.index ?? 0,
    tool: pause.toolCall.name,
    status: settled?.status ?? "ok",
    label: pause.toolCall.name,
  });

  // `answerUnanswered` for a turn parked before the loop answered the
  // rest of its batch itself; for one parked after, it adds nothing.
  // The approved call's answer goes in front of its batch's later ones,
  // where the model asked for it.
  const later = laterInBatch(pause.messages, pause.toolCall.id);
  const laterIds = new Set(later.map((call) => call.id));
  const unanswered = answerUnanswered(pause.messages, pause.toolCall.id);
  const first = unanswered.findIndex(
    (message) => message.role === "tool" && laterIds.has(message.toolCallId),
  );
  const answer: CompletionMessage = {
    role: "tool",
    toolCallId: pause.toolCall.id,
    content: resolved,
  };
  let messages: CompletionMessage[] =
    first === -1
      ? [...unanswered, answer]
      : [...unanswered.slice(0, first), answer, ...unanswered.slice(first)];

  const tools = await input.loadTools();

  /**
   * The rest of the batch, run here rather than left to the model.
   *
   * The loop answered them "not run, call it again once that one is
   * answered", and on 2026-10-11 21:32 the model was asked to look at
   * three sites, had the first approved, and never called the other
   * two: one browser ran and three were reported. So they run now, in
   * order, each recorded over its own `refused` step so the numbering
   * the person saw holds.
   *
   * Confirmed only when the person's card listed it
   * (`AgentTool.approvedTogether`) and it reads the same; anything else
   * runs unconfirmed and may ask for itself, which parks the turn again
   * on it, with the calls after it still unanswered. A "no" declines the
   * listed ones too, and leaves the rest as they were: a refused card
   * must not set off what came after it.
   */
  const together = toolByName(pause.toolCall.name)?.approvedTogether;
  const listed = together ? together.listed(pause.proposal) : [];
  let asked: AnsweredCall["asked"] = null;
  for (const [k, call] of later.entries()) {
    // The loop records a batch's later calls right after the one that
    // asked, in order. A pause that does not look like that (one parked
    // before it did) is left to the model, as before.
    const position = at === -1 ? -1 : at + 1 + k;
    const step = steps[position];
    if (
      !step ||
      step.tool !== call.name ||
      step.status !== "refused" ||
      answerTo(messages, call.id) !== NOT_RUN_FOR_A_QUESTION
    ) {
      continue;
    }
    const parsedCall = parseArguments(call.arguments);
    const line =
      together && call.name === pause.toolCall.name && parsedCall.ok
        ? together.line(parsedCall.args)
        : null;
    const covered = line !== null && listed.includes(line);
    if (!approve) {
      if (!covered) continue;
      const declined = `error: ${DECLINED_RESULT}`;
      messages = answerInPlace(messages, call.id, declined);
      steps[position] = { ...step, resultExcerpt: declined, resultChars: declined.length };
      send({
        type: "step",
        index: step.index,
        tool: call.name,
        status: "refused",
        label: call.name,
      });
      continue;
    }
    const run = await runToolCall(call, {
      tools,
      ctx: { ...ctx, confirmed: covered, confirmedAsListed: covered },
      steps,
      index: step.index,
      pass: step.pass ?? 0,
      toolTimeoutMs: TOOL_TIMEOUT_MS,
      maxOutputChars: MAX_TOOL_OUTPUT_CHARS,
      signal,
      onEvent: (event) => {
        if (event.type === "step") send(event);
      },
      record: (ran) => {
        steps[position] = ran;
      },
    });
    if (run.kind === "asks") {
      // Unanswered, as the loop leaves a call that asks.
      messages = messages.filter(
        (message) => !(message.role === "tool" && message.toolCallId === call.id),
      );
      asked = {
        call,
        ...oneCard(
          tools.find((tool) => tool.name === call.name),
          { summary: run.summary, proposal: run.proposal },
          later.slice(k + 1),
        ),
      };
      break;
    }
    messages = answerInPlace(messages, call.id, run.message.content);
  }

  return { steps, messages, tools, asked, ran: result.kind === "ok" };
}
