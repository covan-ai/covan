import { runAgentTurn, type AgentTurn } from "../src/lib/harness/loop";
import type { CompletionEnv, CompletionMessage } from "../src/lib/completion";
import {
  buildSystemPrefix,
  maxTokensFor,
  temperatureFor,
  reasoningEffortFor,
} from "../src/lib/prompt";
import { stubbedTools, NO_CONTEXT, type ToolCallLog } from "./stubs";
import type { EvalCase } from "./cases";

/**
 * One eval case, run through the same code a chat turn runs through.
 *
 * The prompt is assembled here rather than imported because `routes/chat.ts`
 * builds it inline inside a Hono handler, mid-request, from a session and a
 * database read — there is no function to call. So the assembly below is a
 * transcription of chat.ts's, and the order is the part that matters: persona
 * first, then the prior turns, then the retrieved block, then the question.
 * That order is what makes the prefix cacheable, which is the thing every
 * change this eval exists to guard is about. If chat.ts's order changes and
 * this does not, the eval stops measuring the product.
 *
 * What is deliberately NOT reproduced: session titling, follow-up generation
 * and the quota counter. All three are separate model calls that happen
 * alongside a turn rather than inside it, none of them reaches the answer, and
 * including them would put their cost in this eval's numbers.
 */
export type CaseRun = {
  turn: AgentTurn;
  /** Everything the model was shown, in the order it was shown. */
  messages: CompletionMessage[];
  toolCalls: ToolCallLog;
  latencyS: number;
};

export function buildMessages(kase: EvalCase): CompletionMessage[] {
  // `webSearchEnabled: false` and `mode: "normal"` are the settings the eval
  // holds fixed. Web search would reach the live internet, which is neither
  // reproducible nor free; the other modes are separate flows with their own
  // prompts and belong in their own eval.
  const systemPrefix = buildSystemPrefix({
    persona: kase.persona,
    mode: "normal",
    docNames: kase.docNames,
    webSearchEnabled: false,
  });

  return [
    { role: "system", content: systemPrefix },
    ...kase.history,
    ...(kase.ragBlock ? [{ role: "system" as const, content: kase.ragBlock }] : []),
    { role: "user", content: kase.question },
  ];
}

export async function runCase(
  env: CompletionEnv,
  kase: EvalCase,
  model: string,
  opts: { timeoutMs: number },
): Promise<CaseRun> {
  const toolCalls: ToolCallLog = [];
  const messages = buildMessages(kase);
  const startedAt = Date.now();

  // A ceiling on the whole case, not on stream liveness. A hung connection can
  // emit keepalives indefinitely and defeat any inactivity timer; only a total
  // wall-clock bound reliably reclaims the slot. It does not abort the request
  // underneath — that call may keep running and keep billing — it stops this
  // runner waiting on it.
  const ceiling = AbortSignal.timeout(opts.timeoutMs);

  const turn = await runAgentTurn({
    env,
    request: {
      model,
      messages,
      maxTokens: maxTokensFor("normal"),
      temperature: temperatureFor("normal", null),
      reasoningEffort: reasoningEffortFor(null),
      // `showThinking` is off: chat turns it on so a person watching sees the
      // model deliberate, and it costs output tokens for a paragraph no eval
      // reads. The thinking still happens; only the summary is not asked for.
      webSearch: false,
    },
    tools: stubbedTools(kase, toolCalls),
    ctx: NO_CONTEXT,
    signal: ceiling,
  });

  return { turn, messages, toolCalls, latencyS: (Date.now() - startedAt) / 1000 };
}

/**
 * The transcript in the shape the report reads.
 *
 * Tool calls and their results are separate turns rather than folded into the
 * assistant message, because a reader checking a case needs to see what the
 * model asked for next to what came back — that pairing is most of what a tool
 * turn goes wrong in.
 */
export function toTrace(run: CaseRun): Array<{ role: string; content: string; name?: string }> {
  const out: Array<{ role: string; content: string; name?: string }> = run.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  for (const call of run.toolCalls) {
    out.push({ role: "tool_call", name: call.tool, content: JSON.stringify(call.args, null, 2) });
    out.push({ role: "tool_result", name: call.tool, content: call.content });
  }
  out.push({ role: "assistant", content: run.turn.text });
  return out;
}
