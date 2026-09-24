import {
  streamCompletion,
  EMPTY_USAGE,
  type CompletionEnv,
  type CompletionMessage,
  type CompletionRequest,
  type CompletionUsage,
  type ToolCall,
} from "../completion";
import { supportsTools } from "../models";
import {
  MAX_STEPS,
  MAX_STEP_EXCERPT_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  TOOL_TIMEOUT_MS,
  cap,
} from "./budget";
import { toolSpecs, type AgentTool, type ToolContext, type ToolResult } from "./registry";

/**
 * The loop that turns one question into however many model calls it takes.
 *
 * `streamCompletion` answers once. This asks again: stream, see whether the
 * model wanted a tool, run it, put the result in front of the model, stream
 * again — until it stops asking, or until the budget says so. Everything
 * provider-shaped is already handled a layer down, so there is nothing about
 * Anthropic or OpenAI in this file.
 *
 * It is the only caller of `streamCompletion` that `routes/chat.ts` now goes
 * through, and it is also what a scheduled run uses (see
 * `lib/routines/executor.ts`). That is a dependency taken on purpose: two
 * execution paths would mean a job set up in chat behaving differently when
 * nobody is watching it, which is the one difference nobody could debug.
 */

export type StepStatus = "ok" | "failed" | "refused" | "pending";

/** One tool execution, in the shape `message_steps` stores it. */
export type AgentStep = {
  index: number;
  tool: string;
  /** The arguments the model sent, parsed. Never anything a person typed. */
  request: unknown;
  resultExcerpt: string;
  status: StepStatus;
  durationMs: number;
  /**
   * Which model call asked for this tool, counted from zero within the turn.
   *
   * The loop bills per pass, not per tool: a pass that asks for three tools is
   * one request and one prompt charge, and the three results are then re-sent
   * on every pass after it. Without this, a row in `message_steps` cannot be
   * lined up with the request that paid for it.
   *
   * Optional because a turn parked before this existed round-trips its steps
   * through `paused_turns.steps` as JSON, and those carry no pass.
   */
  pass?: number;
  /**
   * How many characters of this tool's answer the model was actually shown,
   * after `MAX_TOOL_OUTPUT_CHARS`.
   *
   * Not the length of `resultExcerpt`, which is trimmed four times harder for
   * the transcript view — that is the whole reason this exists. A step whose
   * excerpt stops at 2,000 characters might have put 2,001 in front of the
   * model or might have put 8,000, and the difference is what the rest of the
   * turn re-sends on every pass. The number is recorded; the text is not.
   */
  resultChars?: number;
};

/**
 * What one model call in the turn cost.
 *
 * A turn's totals hide the shape that matters here. Eight passes summing to
 * 117,000 prompt tokens can be eight even passes or one enormous last one, and
 * only the second is a caching problem — so the per-pass numbers are kept
 * alongside the sum rather than derived from it, which cannot be done.
 *
 * `prompt` counts the same way `CompletionUsage.promptTokens` does: cached and
 * cache-written tokens are inside it, not beside it.
 */
export type PassUsage = {
  index: number;
  prompt: number | null;
  cached: number | null;
  written: number | null;
  completion: number | null;
};

/**
 * What the caller may show while the turn is running.
 *
 * `delta` and `thinking` pass straight through from the completion seam.
 * `step` is this file's own: it fires twice per tool, once when it starts and
 * once when it lands, so a person watching sees a row appear and then settle
 * rather than a pause followed by everything at once.
 */
export type HarnessEvent =
  | { type: "delta"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "step";
      index: number;
      tool: string;
      status: "running" | StepStatus;
      label: string;
    };

/**
 * Why a turn stopped before the model was finished with it.
 *
 * `confirmation` carries everything needed to pick the turn back up: the
 * messages so far — which already include the assistant turn that asked — and
 * the one call waiting on a person. `budget` carries the same messages for the
 * record and nothing to resume, because there is nothing to wait for.
 */
export type PausedTurn = {
  reason: "confirmation" | "budget";
  messages: CompletionMessage[];
  call?: ToolCall;
  summary?: string;
  proposal?: unknown;
};

export type AgentTurn = {
  text: string;
  usage: CompletionUsage;
  steps: AgentStep[];
  /** One entry per model call this turn made, in order. `usage` is their sum. */
  passes: PassUsage[];
  finishReason: string | null;
  paused?: PausedTurn;
};

export type AgentTurnOptions = {
  env: CompletionEnv;
  /** Model, messages and every completion knob. `tools` is set here, not by the caller. */
  request: Omit<CompletionRequest, "tools">;
  tools: AgentTool[];
  ctx: ToolContext;
  onEvent?: (event: HarnessEvent) => void;
  signal?: AbortSignal;
  budget?: { maxSteps?: number; toolTimeoutMs?: number; maxOutputChars?: number };
  /**
   * Steps already spent before this call — a resumed turn continues the
   * budget rather than starting a fresh one, or a person could buy an
   * unbounded loop by approving the same tool over and over.
   */
  stepsSoFar?: AgentStep[];
};

/**
 * What the model is told when it has run out of steps.
 *
 * A system turn and a final pass with no tools, rather than simply returning
 * what it has. Returning would leave the person with whatever half-sentence
 * preceded the last tool call and no explanation — and the explanation is the
 * whole point of a budget that stops rather than one that hangs.
 */
const BUDGET_INSTRUCTION =
  "You have used every tool call allowed for this turn. Answer now with what you " +
  "already have. Say plainly, in one sentence, what you were not able to finish and " +
  "what you would need to do next — do not pretend the work is complete.";

/** What the model is told when its own model cannot be given tools at all. */
export const NO_TOOLS_NOTICE =
  "No tools are available on this model, so you cannot look anything up or take any " +
  "action this turn. Answer from what you already know and from the material in front " +
  "of you, and say so plainly if the question needs something you cannot reach.";

function addUsage(a: CompletionUsage, b: CompletionUsage): CompletionUsage {
  const add = (x: number | null, y: number | null) =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return {
    promptTokens: add(a.promptTokens, b.promptTokens),
    completionTokens: add(a.completionTokens, b.completionTokens),
    cachedTokens: add(a.cachedTokens, b.cachedTokens),
    cacheWriteTokens: add(a.cacheWriteTokens, b.cacheWriteTokens),
  };
}

/**
 * The arguments, or the reason they could not be read.
 *
 * Strict where `lib/completion.ts` is forgiving, and the two are answering
 * different questions. That one turns half a JSON object into an empty one so
 * the *request* can still be built; this one has to decide whether to run
 * something, and running a tool with arguments nobody could parse is how a
 * `query_database` call with a truncated `sql` becomes a query nobody wrote.
 * The model is told, in words, and usually fixes it on the next pass.
 */
export function parseArguments(
  raw: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; message: string } {
  const trimmed = raw?.trim() ?? "";
  // A tool with no required arguments is legitimately called with nothing.
  if (!trimmed) return { ok: true, args: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, message: "the arguments were not valid JSON — send them again" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, message: "the arguments must be a JSON object" };
  }
  return { ok: true, args: parsed as Record<string, unknown> };
}

/**
 * Run one tool with a ceiling on how long it may take.
 *
 * The timeout is delivered as a signal rather than a race the tool cannot see,
 * because every tool that reaches outside passes the signal to `fetch` — a
 * race alone would leave the request running with nothing to receive it. The
 * race is still there as the backstop for a tool that ignores the signal.
 */
async function runWithTimeout(
  tool: AgentTool,
  args: unknown,
  ctx: ToolContext,
  timeoutMs: number,
  outer: AbortSignal | undefined,
): Promise<ToolResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
  try {
    return await Promise.race([
      tool.run(args, { ...ctx, signal }),
      new Promise<ToolResult>((_, reject) => {
        timeout.addEventListener(
          "abort",
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          {
            once: true,
          },
        );
      }),
    ]);
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** The one line a step shows on screen. Short, and never the whole result. */
function labelFor(tool: string, args: unknown): string {
  const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const first = ["query", "sql", "path", "instruction", "summary", "connectionId"]
    .map((key) => record[key])
    .find((v) => typeof v === "string" && v.trim().length > 0) as string | undefined;
  if (!first) return tool;
  const oneLine = first.replace(/\s+/g, " ").trim();
  return `${tool} · ${oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine}`;
}

export async function runAgentTurn(opts: AgentTurnOptions): Promise<AgentTurn> {
  const maxSteps = opts.budget?.maxSteps ?? MAX_STEPS;
  const toolTimeoutMs = opts.budget?.toolTimeoutMs ?? TOOL_TIMEOUT_MS;
  const maxOutputChars = opts.budget?.maxOutputChars ?? MAX_TOOL_OUTPUT_CHARS;

  // A model this build cannot hand tools to runs the turn without them and
  // says so, which is the one honest option: the alternatives are a 400 on
  // every turn or an agent that silently never looks anything up. See
  // `supportsTools` for why an unknown id lands here.
  const toolsUsable = supportsTools(opts.request.model) && opts.tools.length > 0;
  const messages: CompletionMessage[] = toolsUsable
    ? [...opts.request.messages]
    : opts.tools.length > 0
      ? [...opts.request.messages, { role: "system", content: NO_TOOLS_NOTICE }]
      : [...opts.request.messages];

  const specs = toolsUsable ? toolSpecs(opts.tools) : undefined;
  const steps: AgentStep[] = [...(opts.stepsSoFar ?? [])];
  let usage = EMPTY_USAGE;
  let text = "";
  let finishReason: string | null = null;
  let budgetSpent = false;
  /**
   * Whether to withhold the tool definitions from the next request.
   *
   * Only ever set by the fallback at the foot of the loop, and that is the
   * whole of the reasoning here. Withholding them is the one change that
   * invalidates a prompt cache from its very first block: the provider renders
   * `tools` before `system` before `messages`, so a request whose tool list
   * differs shares no prefix with the one before it at all. The pass that used
   * to do that unconditionally was the budgeted final pass — the pass carrying
   * the largest transcript of the turn, which is the worst possible one to pay
   * full price for.
   *
   * So the final pass now sees the tools and is told in words not to use them,
   * and `mayAsk` below ignores anything it asks for regardless.
   */
  let toolsWithheld = false;
  const passes: PassUsage[] = [];
  /**
   * Where this run's pass numbering starts.
   *
   * A resumed turn is a fresh sequence of model calls against a transcript
   * that already has steps in it, and numbering its first pass zero would put
   * two different requests under the same index on one message. Continuing
   * from the highest pass already spent keeps `message_steps.pass_index`
   * meaning one thing across the whole reply. Steps parked before this field
   * existed report no pass, and the -1 floor is what makes those fall through
   * to zero.
   */
  let pass = steps.reduce((max, step) => Math.max(max, step.pass ?? -1), -1) + 1;

  for (;;) {
    const events = streamCompletion(
      opts.env,
      {
        ...opts.request,
        messages,
        ...(specs && !toolsWithheld ? { tools: specs } : {}),
      },
      { signal: opts.signal },
    );

    let passText = "";
    let calls: ToolCall[] = [];
    /**
     * Whether this pass could legitimately ask for anything.
     *
     * The final pass of an exhausted turn sends no tools, so a `tools` event
     * coming back from it is the provider answering a question nobody asked.
     * Honouring it would run the loop again with the budget already spent,
     * and the budget would never stop it — an infinite turn, which is the one
     * failure mode a budget exists to make impossible.
     */
    const mayAsk = Boolean(specs) && !budgetSpent;
    let opened = false;
    for await (const event of events) {
      if (event.type === "delta") {
        // The blank line between one pass's words and the next's, emitted as
        // a delta so what is persisted is byte-for-byte what was on screen.
        if (!opened && text.length > 0) {
          passText += "\n\n";
          opts.onEvent?.({ type: "delta", text: "\n\n" });
        }
        opened = true;
        passText += event.text;
        opts.onEvent?.({ type: "delta", text: event.text });
      } else if (event.type === "thinking") {
        opts.onEvent?.({ type: "thinking", text: event.text });
      } else if (event.type === "tools") {
        if (mayAsk) calls = event.calls;
      } else {
        usage = addUsage(usage, event.usage);
        // Recorded per pass as well as summed, so a turn that spent everything
        // on its last request can be told apart from one that spread it. See
        // `PassUsage`.
        passes.push({
          index: pass,
          prompt: event.usage.promptTokens,
          cached: event.usage.cachedTokens,
          written: event.usage.cacheWriteTokens,
          completion: event.usage.completionTokens,
        });
        finishReason = event.finishReason;
      }
    }
    text += passText;

    if (calls.length === 0) {
      /**
       * The budgeted final pass answered with a tool call and no words.
       *
       * It can, now that it is shown the tools — `mayAsk` throws the call away
       * but cannot conjure the sentence that should have been there instead,
       * and the person would be left with a turn that stops dead. Asking once
       * more with the tools withheld is exactly what this pass used to be, so
       * the fallback is the old behaviour rather than a new one: full price on
       * one request, in the case where the alternative is no answer.
       *
       * Nothing has reached the screen — `passText` is empty, so no delta was
       * emitted — which is what makes a second attempt invisible rather than a
       * repetition. Once only, and the flag is what guarantees that: a second
       * empty pass with no tools on the request is a model with nothing to say,
       * not a model reaching for a tool.
       */
      if (budgetSpent && !toolsWithheld && specs && passText.trim().length === 0) {
        toolsWithheld = true;
        pass += 1;
        continue;
      }
      return {
        text,
        usage,
        steps,
        passes,
        finishReason,
        ...(budgetSpent ? { paused: { reason: "budget" as const, messages } } : {}),
      };
    }

    // The turn the tools were asked for, recorded before any of them runs —
    // the provider needs it in front of every result, and a tool that throws
    // must not leave the transcript with results answering nothing.
    messages.push({ role: "assistant", content: passText, toolCalls: calls });

    for (const call of calls) {
      if (steps.length >= maxSteps) {
        // Budget gone mid-batch. Every remaining call still needs an answer or
        // the next request is a 400, so they are answered with the refusal
        // rather than dropped.
        const refusal = "refused: this turn has used every tool call it is allowed";
        messages.push({ role: "tool", toolCallId: call.id, content: refusal });
        const refused = parseArguments(call.arguments);
        steps.push({
          index: steps.length,
          pass,
          tool: call.name,
          request: refused.ok ? refused.args : {},
          resultExcerpt: "refused: tool budget exhausted",
          // What the model was shown, which is the refusal and not the
          // excerpt above — the two differ here, and the point of recording
          // this at all is that they can.
          resultChars: refusal.length,
          status: "refused",
          durationMs: 0,
        });
        budgetSpent = true;
        continue;
      }

      const index = steps.length;
      const parsed = parseArguments(call.arguments);
      const args = parsed.ok ? parsed.args : {};
      opts.onEvent?.({
        type: "step",
        index,
        tool: call.name,
        status: "running",
        label: labelFor(call.name, args),
      });

      const tool = opts.tools.find((t) => t.name === call.name);
      const startedAt = Date.now();
      const result: ToolResult = !parsed.ok
        ? { kind: "error", message: parsed.message }
        : !tool
          ? {
              kind: "error",
              message: `no tool named ${call.name} — the tools you may call are: ${opts.tools
                .map((t) => t.name)
                .join(", ")}`,
            }
          : await runWithTimeout(tool, args, opts.ctx, toolTimeoutMs, opts.signal);
      const durationMs = Date.now() - startedAt;

      if (result.kind === "needs_confirmation") {
        // The turn stops here, with the call unanswered on purpose: resuming
        // is what answers it, and a `tool` turn written now would be a lie
        // about something that has not happened.
        steps.push({
          index,
          pass,
          tool: call.name,
          request: args,
          resultExcerpt: cap(result.summary, MAX_STEP_EXCERPT_CHARS),
          // No `resultChars`, and not zero either: the call is deliberately
          // left unanswered until somebody approves it, so nothing has been
          // put in front of the model to measure. The resume writes the real
          // figure over this row.
          status: "pending",
          durationMs,
        });
        opts.onEvent?.({
          type: "step",
          index,
          tool: call.name,
          status: "pending",
          label: labelFor(call.name, args),
        });
        return {
          text,
          usage,
          steps,
          passes,
          finishReason,
          paused: {
            reason: "confirmation",
            messages,
            call,
            summary: result.summary,
            proposal: result.proposal,
          },
        };
      }

      const content =
        result.kind === "ok" ? cap(result.content, maxOutputChars) : `error: ${result.message}`;
      messages.push({ role: "tool", toolCallId: call.id, content });
      const status: StepStatus = result.kind === "ok" ? "ok" : "failed";
      steps.push({
        index,
        pass,
        tool: call.name,
        request: args,
        resultExcerpt: cap(content, MAX_STEP_EXCERPT_CHARS),
        // After `maxOutputChars`, which is what the model sees, and before
        // `MAX_STEP_EXCERPT_CHARS`, which is only what the transcript keeps.
        // This is the number every remaining pass of the turn pays to re-send.
        resultChars: content.length,
        status,
        durationMs,
      });
      opts.onEvent?.({
        type: "step",
        index,
        tool: call.name,
        status,
        label: labelFor(call.name, args),
      });
    }

    if (steps.length >= maxSteps && !budgetSpent) budgetSpent = true;
    if (budgetSpent) {
      messages.push({ role: "system", content: BUDGET_INSTRUCTION });
    }
    pass += 1;
  }
}
