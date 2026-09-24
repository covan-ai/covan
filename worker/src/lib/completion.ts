import type OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import { createOpenAI } from "./openai";
import { createAnthropic } from "./anthropic";
import {
  providerFor,
  acceptsTemperature,
  reasonsBeforeAnswering,
  thinksByDefault,
  type ReasoningEffort,
} from "./models";

/**
 * The one seam every completion goes through, whichever provider answers it.
 *
 * Until Claude models were offered, "the completion seam" was `createOpenAI` —
 * five call sites, one SDK, and the model id passed straight through. That
 * stops working the moment two SDKs are in play: the two speak different
 * request shapes (`system` is a field, not a message; `max_tokens` is required,
 * not optional; JSON mode is a parameter on one and an instruction on the
 * other), and pushing those differences out to five call sites would mean five
 * places to get them wrong.
 *
 * So the call sites keep describing what they want in the shape they always
 * used — a flat list of role/content messages — and everything provider-shaped
 * lives here. `lib/models.ts` decides *which* provider; this decides how to
 * ask it.
 */

/**
 * One call the model asked for, in the shape both providers can be given back.
 *
 * `arguments` is the raw JSON string rather than a parsed object, and stays
 * that way until a tool is about to run. Both providers stream it a fragment
 * at a time and neither promises it parses — a turn that ran out of output
 * tokens mid-argument produces a truncated string, and the honest thing to do
 * with that is fail the one tool call rather than fail the turn while parsing
 * a list of them.
 */
export type ToolCall = { id: string; name: string; arguments: string };

/**
 * A tool as the model is told about it: provider-independent, because the two
 * providers disagree about where the schema goes (`input_schema` on one,
 * `function.parameters` on the other) and about nothing else that matters.
 *
 * `input` is a JSON Schema object. Typed loosely on purpose — the schemas are
 * written by hand in `lib/harness/tools/`, checked by the provider, and a
 * structural type for JSON Schema in TypeScript is a large amount of type to
 * describe something neither SDK validates locally either.
 */
export type ToolSpec = {
  name: string;
  description: string;
  input: Record<string, unknown>;
};

/**
 * A turn in the conversation, which stopped being one shape the moment the
 * model could ask for something.
 *
 * A discriminated union rather than a widened record, and every existing
 * caller is untouched by it: `{role:"assistant", content}` is still exactly a
 * `CompletionMessage`, and the eight call sites that build one keep compiling.
 * What the union buys is that the two new shapes cannot be written wrong —
 * a `tool` turn without the id of the call it answers is a type error here
 * rather than a 400 from the provider.
 */
export type CompletionMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; content: string; toolCallId: string };

export type CompletionUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  /**
   * How much of `promptTokens` the provider served from its prompt cache — a
   * subset of that count, not an addition. Both providers report it, by
   * different names (`prompt_tokens_details.cached_tokens`;
   * `usage.cache_read_input_tokens`), and it is the only evidence that the
   * cacheable-prefix assembly in `routes/chat.ts` is working at all.
   */
  cachedTokens: number | null;
  /**
   * How much of `promptTokens` the provider charged a *premium* to store — a
   * subset of that count too, and disjoint from `cachedTokens`: a token is
   * either read from the cache or written into it, never both in one request.
   *
   * Always null on OpenAI, and that is a fact about the provider rather than a
   * gap here: its prefix cache populates itself and costs nothing to fill, so
   * there is no count to report. Anthropic charges 1.25x input for the write
   * (`usage.cache_creation_input_tokens`), which is why this is separated out
   * at all — it was previously folded into `promptTokens` and priced as
   * ordinary fresh input, so the one number that says whether a caching change
   * paid for itself was the one number nothing recorded.
   */
  cacheWriteTokens: number | null;
};

export type CompletionEnv = {
  OPENAI_API_KEY: string;
  OPENAI_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
};

export type CompletionRequest = {
  /** Already through `resolveModel` — this does not decide what to run. */
  model: string;
  messages: CompletionMessage[];
  /**
   * Upper bound on generated tokens. Optional for OpenAI, where omitting it has
   * always meant the model's own default and several call sites rely on that.
   * Anthropic requires the field, so `DEFAULT_MAX_TOKENS` stands in there.
   */
  maxTokens?: number;
  /** Ignored for models that reject one — see `acceptsTemperature`. */
  temperature?: number;
  /** Ask for a single JSON object back. */
  json?: boolean;
  /**
   * Stream the model's reasoning as well as its answer.
   *
   * Off by default, and off is not the same as "do not think": thinking is
   * decided by `reasoningEffort` and happens either way. This decides whether
   * the model also writes a readable account of it, which costs output tokens
   * of its own and is worth nothing to a caller that throws it away — which is
   * every caller but the chat stream. See `anthropicThinking`.
   *
   * Anthropic only. OpenAI's chat completions endpoint does not return
   * reasoning summaries at all, so a GPT-5 turn sets this and gets nothing,
   * which is the honest outcome rather than a silent one.
   */
  showThinking?: boolean;
  /**
   * How long the model may deliberate before it starts writing.
   *
   * Two kinds of caller set this, and they arrive from opposite directions.
   *
   * The first is a caller whose task is shaping, not thinking, and it says
   * `"minimal"`. Drafting a persona from a title or pulling ideas out of a
   * transcript are writing tasks with a known shape; a reasoning model
   * deliberating over them buys nothing and costs a multiple. Measured on the
   * persona drafter: default effort spends 512-1408 tokens thinking before
   * writing ~120 tokens of answer, and `"minimal"` spends none and writes the
   * same answer.
   *
   * The second is a chat turn carrying an agent's own setting (0048), which can
   * be any of the four and is usually none of them — an agent that names no
   * effort is left on the model's default, which is what every agent had before
   * the setting existed. `"medium"` is a request, not a synonym for silence.
   *
   * Nothing on a non-reasoning model, which has no such setting.
   */
  reasoningEffort?: ReasoningEffort;
  /**
   * Enable web search tool.
   *
   * Anthropic: web_search_20260209 on models that support it (Opus 5/4.8/4.7/4.6,
   * Sonnet 5/4.6). Older models get web_search_20250305.
   * OpenAI: no effect on any model offered here — see `openaiParams` below for
   * why this isn't a gap that closes by passing a parameter.
   *
   * Off by default. Web search is an escape hatch from "your knowledge" rather
   * than the default behavior, and an agent opts into it explicitly (0051).
   */
  webSearch?: boolean;
  /**
   * The tools this turn may ask for, translated per provider by the adaptors
   * below.
   *
   * Absent — which is every caller but `lib/harness/loop.ts` — sends no tools
   * field at all, so a request that did not opt in is byte-identical to the
   * one this file built before tools existed. That matters more than it
   * sounds: the cacheable prefix in `routes/chat.ts` is only worth anything
   * while the bytes in front of the question do not move.
   *
   * Sending these to a model that cannot take them is the caller's mistake to
   * avoid, not this file's to paper over — `supportsTools` in `lib/models.ts`
   * is the question, and the loop asks it before it gets here.
   */
  tools?: ToolSpec[];
};

/**
 * What Anthropic gets when a caller named no ceiling. `max_tokens` is required
 * by that API, so "unbounded" is not a thing that can be sent; this is large
 * enough for the two callers that omit it (a routine's summary, a routine
 * draft) and still a real stop.
 */
export const DEFAULT_MAX_TOKENS = 4096;

/**
 * Extra room given to a reasoning model, on top of what the caller asked for.
 *
 * `maxTokens` means "how long an answer" everywhere it is set in this codebase
 * — `maxTokensFor` in `lib/prompt.ts` sizes it for a chat reply. On a reasoning
 * model the API's ceiling covers thinking too, so passing that number through
 * unchanged spends the answer's budget on deliberation and truncates, or empties,
 * the reply.
 *
 * 4096 is sized from measurement rather than picked: a chat-shaped request with
 * retrieved context spent 896 reasoning tokens on gpt-5 and 384 on gpt-5-mini,
 * and the trivial persona draft — where there is least to think about and it
 * therefore ran longest relative to the answer — spent 1408. This leaves room
 * for a harder question than either without turning the ceiling into no ceiling.
 *
 * It applies only when the caller wants the thinking. A caller that sets
 * `reasoningEffort: "minimal"` gets its own number honoured, because there is
 * then nothing to make room for.
 */
export const REASONING_HEADROOM = 4096;

/**
 * The same headroom, sized to how much thinking was actually asked for.
 *
 * `REASONING_HEADROOM` was one number because there was one behaviour: either a
 * caller wanted no deliberation (`"minimal"`) or it took whatever the model
 * chose. Now that an agent can ask for `"high"`, one number is the wrong shape
 * in both directions — 4096 is more than a `"low"` turn will ever use, and a
 * ceiling a `"high"` turn can exhaust before it writes a word, which is not a
 * shorter answer but an empty one with `finish_reason: "length"`.
 *
 * Anchored on the measured value rather than invented around it: the unset case
 * keeps 4096 exactly, so nothing that runs today changes. The others scale from
 * it in the direction their name promises.
 */
export function reasoningHeadroom(effort: ReasoningEffort | undefined): number {
  switch (effort) {
    case "minimal":
      return 0;
    case "low":
      return 2048;
    case "high":
      return 8192;
    default:
      return REASONING_HEADROOM;
  }
}

const JSON_ONLY_INSTRUCTION =
  "Respond with a single JSON object and nothing else: no prose before or after it, " +
  "and no markdown code fences.";

export const EMPTY_USAGE: CompletionUsage = {
  promptTokens: null,
  completionTokens: null,
  cachedTokens: null,
  cacheWriteTokens: null,
};

/** What a turn cost, for the quota counter. Cached prompt tokens are inside `promptTokens`. */
export function totalTokens(usage: CompletionUsage): number {
  return (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0);
}

/**
 * A JSON object out of a reply that may be wrapped in prose or fences.
 *
 * OpenAI's `response_format: {type:"json_object"}` guarantees the body is
 * already exactly this, so for that path the function returns its input
 * untouched. Anthropic has no equivalent parameter on the Claude models offered
 * here — JSON is asked for in words, and words are sometimes answered with a
 * ```json fence around them. Every caller downstream does a bare `JSON.parse`
 * and treats a throw as "the model failed", so an otherwise perfect reply
 * inside a fence would be reported to the user as a failure.
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return trimmed;
  return trimmed.slice(start, end + 1);
}

/**
 * A tool call's arguments as an object, for the provider that wants one.
 *
 * Never throws. A model that ran out of output tokens halfway through writing
 * its arguments produces a string that does not parse, and the two things that
 * could be done about it are fail the whole turn or send an empty object. The
 * empty object is better: the tool sees a missing required argument, says so
 * in words the model can read, and the turn carries on. Failing the request
 * would lose the other calls in the same turn, which are usually fine.
 */
function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

// ---- OpenAI ----------------------------------------------------------------

/**
 * The same flat list, in the shape Chat Completions wants.
 *
 * Until tools existed this was a cast: the two shapes were identical and the
 * cast said so. They stopped being identical in two places, both of which the
 * cast would have carried through to a 400 —
 *
 * - **A tool result is `{role:"tool", tool_call_id}`**, not a field named
 *   `toolCallId` beside the content.
 * - **An assistant turn that only asked for tools has no text**, and OpenAI
 *   wants `content: null` there rather than an empty string.
 *
 * Exported for the test that pins both, which is the only reason it is not a
 * file-local helper.
 */
export function toOpenAIMessages(
  messages: CompletionMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    }
    if (message.role === "assistant") {
      const calls = message.toolCalls ?? [];
      return {
        role: "assistant",
        content: message.content || null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: "function" as const,
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    }
    return { role: message.role, content: message.content };
  });
}

/** Covan's provider-independent tool description, as OpenAI's function shape. */
function toOpenAITools(tools: ToolSpec[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.input },
  }));
}

function openaiParams(req: CompletionRequest): OpenAI.Chat.Completions.ChatCompletionCreateParams {
  const reasons = reasonsBeforeAnswering(req.model);
  // Two ways to keep thinking from eating the answer, and which one applies is
  // the caller's call, not the model's: minimal effort when the task does not
  // want deliberation, headroom when it does — sized to how much was asked for.
  // See `reasoningHeadroom`.
  const headroom = reasons ? reasoningHeadroom(req.reasoningEffort) : 0;
  const cap = req.maxTokens !== undefined ? req.maxTokens + headroom : req.maxTokens;

  const base: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
    model: req.model,
    messages: toOpenAIMessages(req.messages),
    ...(cap !== undefined ? { max_completion_tokens: cap } : {}),
    // `tool_choice: "auto"` is the endpoint's own default and is sent anyway,
    // because "auto" is not what every OpenAI-compatible server in front of
    // this variable defaults to — several require the field before they will
    // consider the tools at all. Omitted entirely when there are no tools, so
    // a request that did not opt in is unchanged.
    ...(req.tools && req.tools.length > 0
      ? { tools: toOpenAITools(req.tools), tool_choice: "auto" as const }
      : {}),
    // Only where it means something. A model that answers without a separate
    // thinking step has no such parameter, and sending one is a 400.
    ...(reasons && req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    ...(req.temperature !== undefined && acceptsTemperature(req.model)
      ? { temperature: req.temperature }
      : {}),
    ...(req.json ? { response_format: { type: "json_object" as const } } : {}),
  };

  // Not a missing parameter — the SDK has had `web_search_options` since
  // before this was written. It is that OpenAI's Chat Completions API only
  // accepts it on specialized search-only models (`gpt-5-search-api`;
  // `gpt-4o-search-preview` and `gpt-4o-mini-search-preview` were retired
  // 2026-07-23), none of which are in `MODEL_IDS`. Every general-purpose
  // model this app offers would 400 on the field, so `req.webSearch` stays
  // silently ignored here rather than wired to something that only works on
  // a model nobody picks for chat. See covan#142 for the planned fix: an
  // app-owned search tool over function-calling, which isn't restricted this
  // way.

  return base;
}

// ---- Anthropic -------------------------------------------------------------

/**
 * A flat message list in the shape the Messages API wants.
 *
 * Three differences, none of them cosmetic:
 *
 * - **System prompts are a field, not a turn.** The leading system messages
 *   become `system`, which is also where they belong for caching: that block is
 *   byte-identical turn over turn.
 * - **A later system message has nowhere to go.** `routes/chat.ts` puts the
 *   retrieved-knowledge block in one, just before the newest question, so the
 *   stable prefix in front of it stays cacheable. Mid-conversation system turns
 *   exist on Anthropic's newest models and on none of the ones offered here, so
 *   it is delivered as a user turn instead — same position, same effect on the
 *   answer, and consecutive user turns are merged by the API.
 * - **The first turn must be a user turn.** History trimming can leave an
 *   assistant message first; OpenAI accepts that and Anthropic returns a 400.
 *   Leading assistant turns are dropped rather than sent.
 *
 * `cacheIndex` is the third return value and the reason this function reports
 * more than it used to — see `CACHE_CONTROL` below for what it is for.
 */
export function toAnthropicMessages(messages: CompletionMessage[]): {
  system: string;
  messages: Anthropic.MessageParam[];
  cacheIndex: number | null;
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];
  // Where the stable half of the conversation ends: the last turn pushed before
  // the first mid-conversation system message, which is the volatile retrieved
  // block. Null until one is seen, and resolved below for the callers that send
  // no block at all.
  let stableThrough: number | null = null;
  /**
   * The `tool_use` ids actually sent, so a `tool_result` that answers a call
   * this function dropped is dropped with it.
   *
   * It can happen in one way and it is a 400 when it does: history trimming
   * leaves an assistant turn first, the rule below drops it, and the results
   * of the calls it made are still in the list behind it. Anthropic refuses a
   * `tool_result` whose `tool_use_id` is not in the conversation, which would
   * turn a trimmed history into a failed reply.
   */
  const liveCallIds = new Set<string>();
  /** The index in `out` of the user turn currently collecting tool results. */
  let openResultTurn: number | null = null;

  for (const message of messages) {
    const content = message.content?.trim() ?? "";

    if (message.role === "tool") {
      if (!liveCallIds.has(message.toolCallId)) continue;
      const block: Anthropic.ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        // Empty is a real answer — a tool that found nothing said so — and the
        // block still has to be there, because the call it answers is. A word
        // rather than an empty string: Anthropic rejects an empty content
        // array and an empty string reads, to the model, like a tool that
        // broke rather than one that found nothing.
        content: content || "(no output)",
      };
      // Consecutive results belong in one user turn. Several turns in a row
      // would be several user messages, which is the shape the API merges
      // anyway — doing it here means the count in `cacheIndex` matches what is
      // actually sent.
      if (openResultTurn !== null) {
        const turn = out[openResultTurn];
        (turn.content as Anthropic.ContentBlockParam[]).push(block);
      } else {
        openResultTurn = out.length;
        out.push({ role: "user", content: [block] });
      }
      continue;
    }
    openResultTurn = null;

    if (message.role === "system") {
      if (!content) continue;
      if (out.length === 0) systemParts.push(content);
      else {
        if (stableThrough === null) stableThrough = out.length - 1;
        out.push({ role: "user", content });
      }
      continue;
    }

    if (message.role === "assistant") {
      const calls = message.toolCalls ?? [];
      // An assistant turn that asked for a tool and said nothing is not empty
      // — the request *is* the turn — so the blank check only applies when
      // there are no calls either.
      if (!content && calls.length === 0) continue;
      // Nothing to answer yet, so an assistant turn here is history that lost
      // its question. Sending it is a 400; keeping it is a reply to nobody.
      if (out.length === 0) continue;
      if (calls.length === 0) {
        out.push({ role: "assistant", content });
        continue;
      }
      const blocks: Anthropic.ContentBlockParam[] = content
        ? [{ type: "text", text: content }]
        : [];
      for (const call of calls) {
        liveCallIds.add(call.id);
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          // Parsed here and nowhere else on this path. Anthropic wants an
          // object where OpenAI wants the string, and a string that does not
          // parse is a turn the model truncated — sent as an empty object, so
          // the tool reports a missing argument rather than the request
          // failing whole.
          input: parseToolArguments(call.arguments),
        });
      }
      out.push({ role: "assistant", content: blocks });
      continue;
    }

    if (!content) continue;
    out.push({ role: "user", content });
  }

  // No retrieved block on this turn, so the volatile tail is the question alone
  // and everything before it is the history that repeats.
  if (stableThrough === null) stableThrough = out.length - 2;

  return {
    system: systemParts.join("\n\n"),
    messages: out,
    cacheIndex: stableThrough >= 0 ? stableThrough : null,
  };
}

/**
 * The marker that makes Anthropic bill a repeated prefix at a tenth of its
 * price, and the thing this file did not send for as long as Claude has been
 * offered here.
 *
 * Two breakpoints, because the prompt has two stable regions and one volatile
 * one between them:
 *
 * 1. **The system block.** `buildSystemPrefix` exists to be byte-identical turn
 *    over turn — that is why the retrieved knowledge is a separate message and
 *    not part of the persona. The whole persona, concision block and document
 *    manifest therefore repeat exactly, every turn, for the life of a chat.
 * 2. **The last turn before the retrieved block.** History repeats too: turn
 *    twelve re-sends the eleven turns before it verbatim. Marking the end of
 *    that run caches the system block *and* the conversation, leaving only the
 *    excerpts and the new question to pay full price.
 *
 * Both were already true before this marker existed, which is the point:
 * `lib/pricing.ts` has priced a 10x cache discount since Claude was added,
 * `anthropicUsage` has read `cache_read_input_tokens` since then too, and the
 * number it read was always zero. Nothing about the prompt had to change to
 * earn it — only saying so on the wire.
 *
 * A prefix shorter than the model's minimum is not cached and the request is
 * not refused; a short chat simply pays what it pays today. The minimum is per
 * model and the spread is wider than it looks: 512 tokens on Opus 5, 1024 on
 * the Sonnets, and 4096 on Haiku 4.5 — so on the cheapest model, which is
 * exactly where a short prompt is most likely to run, a marker on anything
 * under four thousand tokens buys nothing at all.
 *
 * **Both markers are set together or not at all**, which is `cacheIndex`'s
 * second job. A cache write is not free on this provider — Anthropic charges
 * 1.25x input for the tokens it stores, as `lib/pricing.ts` says — so a marker
 * on a prefix that will never be read back is a bill, not a saving. That is
 * exactly what the first turn of a conversation is: with no prior turns,
 * `toAnthropicMessages` folds the retrieved block into `system` (nothing
 * precedes it, so by this function's own rule it is a leading system message),
 * and the next turn's `system` is the persona alone. The two do not match, the
 * entry is never read, and the write was paid for.
 *
 * `cacheIndex` is null in precisely that case and in the one-shot callers
 * (titling, persona drafting, a routine's summary) which send one system
 * message and one question and never ask twice. So it is the right condition
 * for both: mark nothing until there is repeated history to mark.
 */
const CACHE_CONTROL = { type: "ephemeral" as const };

function withCacheBreakpoint(message: Anthropic.MessageParam): Anthropic.MessageParam {
  if (typeof message.content !== "string") return message;
  return {
    role: message.role,
    content: [{ type: "text", text: message.content, cache_control: CACHE_CONTROL }],
  };
}

/**
 * What this turn asks a Claude model to do before it writes, and the room that
 * needs.
 *
 * `openaiParams` above reads the same decision off the model id alone, because
 * a GPT-5 model deliberates on every call whatever anyone asks. No Claude model
 * here does: thinking happens when this build sends the parameter, and — on one
 * model — when it does not. So the question is about the request, not the id,
 * and it is worth its own function rather than four conditions inside the
 * params builder.
 *
 * Two things here are easy to get wrong, and the obvious reading of each is
 * the wrong one.
 *
 * **`"minimal"` is not an Anthropic effort.** Its scale is low/medium/high and
 * has no floor below `"low"`. The translation that looks obvious — call it
 * `"low"` — is exactly backwards: `"minimal"` is what the persona drafter and
 * the idea extractor say to mean *do not deliberate at all*, and rendering that
 * as "deliberate a little" would make the one caller that opted out pay for
 * thinking it opted out of. So `"minimal"` turns thinking off rather than down.
 *
 * **The headroom follows the thinking, not the model.** `reasoningHeadroom`
 * widens the output ceiling to leave room for deliberation. Widening it on
 * every Claude turn because the model *could* think would change how long a
 * runaway answer is allowed to get — for every agent, to make room for
 * something that is not happening. So it is zero unless this turn thinks.
 */
function anthropicThinking(req: CompletionRequest): {
  thinking?: Anthropic.ThinkingConfigParam;
  outputConfig?: Anthropic.OutputConfig;
  headroom: number;
} {
  // The 4.5 models take no effort at all — sending one is a 400 — so they are
  // `reasoning: false` in `lib/models.ts` and leave here untouched, on whatever
  // the model does by itself.
  if (!reasonsBeforeAnswering(req.model)) return { headroom: 0 };

  // Narrowed in one expression rather than through a flag, so the type carries
  // what the prose says: an effort that reaches Anthropic is one of its own
  // three, never Covan's fourth.
  const effort =
    req.reasoningEffort && req.reasoningEffort !== "minimal" ? req.reasoningEffort : undefined;

  // No thinking this turn: the caller either said `"minimal"`, or said nothing
  // to a model that does nothing by itself.
  if (effort === undefined && (req.reasoningEffort === "minimal" || !thinksByDefault(req.model))) {
    // Silence means "do not think" on every model here but one, where it means
    // the opposite and so has to be said out loud.
    return thinksByDefault(req.model)
      ? { thinking: { type: "disabled" }, headroom: 0 }
      : { headroom: 0 };
  }

  return {
    // Summarised only for a caller that says it will show it. Left summarised
    // for everyone, the model writes a readable account of its reasoning and
    // streams it, and every caller but the chat route drops those deltas on
    // the floor. The thinking is billed either way; the *summary* is not, and
    // this is about not paying for a paragraph nobody will see.
    thinking: {
      type: "adaptive",
      display: req.showThinking ? "summarized" : "omitted",
    },
    // Absent on a model that thinks unasked and was given no effort: that is
    // the caller saying "whatever you do by default", and a default effort is
    // what the API already applies.
    ...(effort ? { outputConfig: { effort } } : {}),
    headroom: reasoningHeadroom(effort),
  };
}

// Without `stream`, so the two call sites below can each add their own and get
// back the overload they want rather than a union of both.
function anthropicParams(
  req: CompletionRequest,
): Omit<Anthropic.MessageCreateParamsNonStreaming, "stream"> {
  const { system, messages, cacheIndex } = toAnthropicMessages(req.messages);
  if (messages.length === 0) {
    throw new Error("a completion needs at least one user message");
  }
  const systemText = [system, req.json ? JSON_ONLY_INSTRUCTION : ""].filter(Boolean).join("\n\n");
  const { thinking, outputConfig, headroom } = anthropicThinking(req);

  // Web search tool. Newer models (Opus 5/4.8/4.7/4.6, Sonnet 5/4.6) get
  // web_search_20260209; older models get web_search_20250305.
  const tools: Array<
    | Anthropic.Messages.WebSearchTool20260209
    | Anthropic.Messages.WebSearchTool20250305
    | Anthropic.Tool
  > = [];
  if (req.webSearch) {
    const newerModels = [
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
    ];
    if (newerModels.includes(req.model)) {
      tools.push({ type: "web_search_20260209", name: "web_search" });
    } else {
      tools.push({ type: "web_search_20250305", name: "web_search" });
    }
  }

  // The app's own tools, alongside whatever server-side tool was asked for
  // above. Anthropic's custom-tool shape is the schema under `input_schema`
  // and nothing else, which is why `ToolSpec` needed no provider field.
  for (const tool of req.tools ?? []) {
    tools.push({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input as Anthropic.Tool.InputSchema,
    });
  }

  return {
    model: req.model,
    messages:
      cacheIndex === null
        ? messages
        : messages.map((m, i) => (i === cacheIndex ? withCacheBreakpoint(m) : m)),
    // Anthropic requires the field, so a caller that omits one gets
    // `DEFAULT_MAX_TOKENS`. The headroom is added to whichever it is — see
    // `anthropicThinking`; it is zero on every turn that does not deliberate.
    max_tokens: (req.maxTokens ?? DEFAULT_MAX_TOKENS) + headroom,
    ...(thinking ? { thinking } : {}),
    ...(outputConfig ? { output_config: outputConfig } : {}),
    ...(systemText
      ? {
          system: [
            {
              type: "text" as const,
              text: systemText,
              ...(cacheIndex === null ? {} : { cache_control: CACHE_CONTROL }),
            },
          ],
        }
      : {}),
    ...(req.temperature !== undefined && acceptsTemperature(req.model)
      ? { temperature: req.temperature }
      : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
}

/**
 * Anthropic's usage numbers in the shape the rest of the app counts in.
 *
 * `input_tokens` there excludes anything served from or written to the cache,
 * where OpenAI's `prompt_tokens` includes it. Adding the three back together is
 * what makes one number mean the same thing on both providers — the usage view,
 * the quota counter and `lib/pricing.ts` all assume `cachedTokens` is a subset
 * of `promptTokens`, and it would be double-counted the moment it was not.
 */
function anthropicUsage(usage: Anthropic.Usage | null | undefined): CompletionUsage {
  if (!usage) return EMPTY_USAGE;
  const cached = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  return {
    promptTokens: (usage.input_tokens ?? 0) + cached + written,
    completionTokens: usage.output_tokens ?? null,
    cachedTokens: usage.cache_read_input_tokens ?? null,
    // Reported separately as well as folded in, because the two facts answer
    // different questions: the fold keeps one prompt count meaning the same
    // thing on both providers, and this says how much of it was bought at the
    // write premium. Summing the two would double-count.
    cacheWriteTokens: usage.cache_creation_input_tokens ?? null,
  };
}

// ---- the seam --------------------------------------------------------------

/**
 * One completion, waited for in full.
 *
 * `toolCalls` is absent on every turn that asked for no tools, which is every
 * caller of this function today — the harness streams. It is returned rather
 * than dropped because dropping it is what this code did before, and silently:
 * a `tool_use` block reaching the `block.type === "text" ? ... : ""` below
 * became an empty string, so a model that asked for something looked like a
 * model that answered with nothing.
 */
export async function complete(
  env: CompletionEnv,
  req: CompletionRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<{ text: string; usage: CompletionUsage; toolCalls?: ToolCall[] }> {
  if (providerFor(req.model) === "anthropic") {
    const client = createAnthropic(env);
    const message = await client.messages.create(
      { ...anthropicParams(req), stream: false },
      { signal: opts.signal },
    );
    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("")
      .trim();
    const toolCalls = message.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      }));
    return {
      text: req.json ? extractJsonObject(text) : text,
      usage: anthropicUsage(message.usage),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  const client = createOpenAI(env);
  const completion = await client.chat.completions.create(
    { ...openaiParams(req), stream: false },
    { signal: opts.signal },
  );
  const choice = completion.choices[0]?.message;
  const text = choice?.content ?? "";
  const toolCalls = (choice?.tool_calls ?? [])
    .filter(
      (call): call is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall =>
        "function" in call,
    )
    .map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    }));
  return {
    text: req.json ? extractJsonObject(text) : text,
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? null,
      completionTokens: completion.usage?.completion_tokens ?? null,
      cachedTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? null,
      // Null rather than zero: OpenAI's prefix cache is populated for free and
      // reports no write count, so there is nothing to record. Zero would be a
      // claim that nothing was written, which is not what the API said.
      cacheWriteTokens: null,
    },
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

export type CompletionEvent =
  | { type: "delta"; text: string }
  /**
   * A piece of the model's reasoning, when a caller asked to see it.
   *
   * Separate from `delta` rather than folded into it, because these are two
   * different things going to two different places: one is the answer and one
   * is an account of how it was arrived at. A consumer that cannot tell them
   * apart writes the reasoning into the transcript.
   */
  | { type: "thinking"; text: string }
  /**
   * The model asked for one or more tools, and there is nothing more of this
   * turn to stream.
   *
   * **A tool call is not streamed.** Both providers send the arguments a
   * fragment at a time and neither fragment means anything on its own — half
   * a JSON object cannot be run, shown, or confirmed — so the accumulation
   * protocol is confined to this file and consumers get one event with whole
   * calls in it. It arrives after the last `delta` (a model may write a
   * sentence before it asks) and immediately before `end`.
   */
  | { type: "tools"; calls: ToolCall[] }
  /**
   * The last event of every stream: what the turn cost, and why it stopped.
   *
   * `finishReason` is normalised to OpenAI's vocabulary, so a caller asking
   * "was this cut off?" writes one check rather than one per provider. The only
   * value anything reads today is `"length"` — Anthropic spells that
   * `"max_tokens"` — and `routes/chat.ts` turns it into the `truncated` event
   * the chat screen shows.
   */
  | { type: "end"; usage: CompletionUsage; finishReason: string | null };

/**
 * The same completion, streamed.
 *
 * Both providers report usage at the end and neither reports it the same way —
 * OpenAI in a final usage-only chunk that has to be asked for
 * (`stream_options`), Anthropic across two events (the input half at
 * `message_start`, the output half at `message_delta`). Callers get one `end`
 * event either way, after the last delta.
 */
export async function* streamCompletion(
  env: CompletionEnv,
  req: CompletionRequest,
  opts: { signal?: AbortSignal } = {},
): AsyncGenerator<CompletionEvent> {
  if (providerFor(req.model) === "anthropic") {
    const client = createAnthropic(env);
    const stream = await client.messages.create(
      { ...anthropicParams(req), stream: true },
      { signal: opts.signal },
    );

    let usage = EMPTY_USAGE;
    let finishReason: string | null = null;
    /**
     * Tool calls under construction, by the index of the content block each
     * one is arriving in.
     *
     * Anthropic names the tool once, in `content_block_start`, and then sends
     * its arguments as `input_json_delta` fragments carrying nothing but the
     * block index. So the index is the only thing joining a fragment to the
     * call it belongs to, and the map is keyed by it rather than by the call
     * id the fragments do not repeat.
     */
    const building = new Map<number, ToolCall>();
    for await (const event of stream) {
      if (event.type === "message_start") {
        usage = anthropicUsage(event.message.usage);
      } else if (event.type === "content_block_start" && event.content_block.type === "tool_use") {
        building.set(event.index, {
          id: event.content_block.id,
          name: event.content_block.name,
          arguments: "",
        });
      } else if (event.type === "content_block_delta" && event.delta.type === "input_json_delta") {
        const call = building.get(event.index);
        if (call) call.arguments += event.delta.partial_json;
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (event.delta.text) yield { type: "delta", text: event.delta.text };
      } else if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
        // Only ever non-empty when `showThinking` asked for a summary — with
        // `display: "omitted"` the blocks still arrive and their text does not.
        if (event.delta.thinking) yield { type: "thinking", text: event.delta.thinking };
      } else if (event.type === "message_delta") {
        // The final, cumulative output count. `message_start` carried an early
        // value for the same field; this one replaces it.
        usage = { ...usage, completionTokens: event.usage.output_tokens ?? usage.completionTokens };
        // `max_tokens` is Anthropic's spelling of OpenAI's `length`. Translated
        // here so the truncation check downstream stays provider-agnostic;
        // every other stop reason passes through under its own name.
        // Optional-chained: the field is required on the wire, and a stream
        // that omits it must still yield its usage rather than throw away a
        // finished reply on the last event.
        const stop = event.delta?.stop_reason;
        // `tool_use` is Anthropic's spelling of OpenAI's `tool_calls`,
        // normalised for the same reason `max_tokens` is: a consumer asking
        // "did this turn ask for something?" writes one check, not one per
        // provider.
        if (stop) {
          finishReason =
            stop === "max_tokens" ? "length" : stop === "tool_use" ? "tool_calls" : stop;
        }
      }
    }
    if (building.size > 0) {
      // Block order, which is the order the model wrote them in. `Map`
      // preserves insertion order and the blocks arrive in index order, so
      // this is already right — sorted anyway, because relying on that is
      // relying on a property of the wire nobody promised.
      yield {
        type: "tools",
        calls: [...building.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call),
      };
    }
    yield { type: "end", usage, finishReason };
    return;
  }

  const client = createOpenAI(env);
  const completion = await client.chat.completions.create(
    {
      ...openaiParams(req),
      stream: true,
      // Without this the usage-only final chunk is never sent, and every reply
      // is recorded as having cost nothing.
      stream_options: { include_usage: true },
    },
    { signal: opts.signal },
  );

  let usage = EMPTY_USAGE;
  let finishReason: string | null = null;
  /**
   * The same accumulation, by OpenAI's rules rather than Anthropic's.
   *
   * The joining key here is `index` on the delta, and the id and name arrive
   * only on the first fragment of each call — every fragment after it carries
   * `function.arguments` alone. So both are written once and the arguments
   * are appended, which is the opposite of the obvious reading of the shape:
   * each delta *looks* like a whole tool call with most of its fields empty.
   */
  const building = new Map<number, ToolCall>();
  for await (const chunk of completion) {
    const choice = chunk.choices[0];
    const delta = choice?.delta?.content;
    if (delta) yield { type: "delta", text: delta };
    for (const part of choice?.delta?.tool_calls ?? []) {
      const existing = building.get(part.index);
      const call = existing ?? { id: "", name: "", arguments: "" };
      if (!existing) building.set(part.index, call);
      if (part.id) call.id = part.id;
      if (part.function?.name) call.name = part.function.name;
      if (part.function?.arguments) call.arguments += part.function.arguments;
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? null,
        completionTokens: chunk.usage.completion_tokens ?? null,
        cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? null,
        cacheWriteTokens: null,
      };
    }
  }
  if (building.size > 0) {
    // Dropping a call with no id is not tidiness. An id is what the result is
    // sent back under, so a call without one cannot be answered — and an
    // unanswered `tool_calls` turn is a 400 on the next request, which would
    // end the conversation rather than one tool call.
    const calls = [...building.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, call]) => call)
      .filter((call) => call.id && call.name);
    if (calls.length > 0) yield { type: "tools", calls };
  }
  yield { type: "end", usage, finishReason };
}
