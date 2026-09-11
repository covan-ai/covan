import type OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import { createOpenAI } from "./openai";
import { createAnthropic } from "./anthropic";
import {
  providerFor,
  acceptsTemperature,
  reasonsBeforeAnswering,
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

export type CompletionMessage = { role: "system" | "user" | "assistant"; content: string };

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

// ---- OpenAI ----------------------------------------------------------------

function openaiParams(req: CompletionRequest): OpenAI.Chat.Completions.ChatCompletionCreateParams {
  const reasons = reasonsBeforeAnswering(req.model);
  // Two ways to keep thinking from eating the answer, and which one applies is
  // the caller's call, not the model's: minimal effort when the task does not
  // want deliberation, headroom when it does — sized to how much was asked for.
  // See `reasoningHeadroom`.
  const headroom = reasons ? reasoningHeadroom(req.reasoningEffort) : 0;
  const cap = req.maxTokens !== undefined ? req.maxTokens + headroom : req.maxTokens;
  return {
    model: req.model,
    messages: req.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    ...(cap !== undefined ? { max_completion_tokens: cap } : {}),
    // Only where it means something. A model that answers without a separate
    // thinking step has no such parameter, and sending one is a 400.
    ...(reasons && req.reasoningEffort ? { reasoning_effort: req.reasoningEffort } : {}),
    ...(req.temperature !== undefined && acceptsTemperature(req.model)
      ? { temperature: req.temperature }
      : {}),
    ...(req.json ? { response_format: { type: "json_object" as const } } : {}),
  };
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

  for (const message of messages) {
    const content = message.content?.trim();
    if (!content) continue;
    if (message.role === "system") {
      if (out.length === 0) systemParts.push(content);
      else {
        if (stableThrough === null) stableThrough = out.length - 1;
        out.push({ role: "user", content });
      }
      continue;
    }
    // Nothing to answer yet, so an assistant turn here is history that lost its
    // question. Sending it is a 400; keeping it is a reply to nobody.
    if (message.role === "assistant" && out.length === 0) continue;
    out.push({ role: message.role, content });
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
 * A prefix shorter than the model's minimum (1024 tokens, 2048 on Haiku) is not
 * cached and the request is not refused; a short chat simply pays what it pays
 * today.
 */
const CACHE_CONTROL = { type: "ephemeral" as const };

function withCacheBreakpoint(message: Anthropic.MessageParam): Anthropic.MessageParam {
  if (typeof message.content !== "string") return message;
  return {
    role: message.role,
    content: [{ type: "text", text: message.content, cache_control: CACHE_CONTROL }],
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
  return {
    model: req.model,
    messages:
      cacheIndex === null
        ? messages
        : messages.map((m, i) => (i === cacheIndex ? withCacheBreakpoint(m) : m)),
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(systemText
      ? { system: [{ type: "text" as const, text: systemText, cache_control: CACHE_CONTROL }] }
      : {}),
    ...(req.temperature !== undefined && acceptsTemperature(req.model)
      ? { temperature: req.temperature }
      : {}),
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
  };
}

// ---- the seam --------------------------------------------------------------

/** One completion, waited for in full. */
export async function complete(
  env: CompletionEnv,
  req: CompletionRequest,
  opts: { signal?: AbortSignal } = {},
): Promise<{ text: string; usage: CompletionUsage }> {
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
    return {
      text: req.json ? extractJsonObject(text) : text,
      usage: anthropicUsage(message.usage),
    };
  }

  const client = createOpenAI(env);
  const completion = await client.chat.completions.create(
    { ...openaiParams(req), stream: false },
    { signal: opts.signal },
  );
  const text = completion.choices[0]?.message?.content ?? "";
  return {
    text: req.json ? extractJsonObject(text) : text,
    usage: {
      promptTokens: completion.usage?.prompt_tokens ?? null,
      completionTokens: completion.usage?.completion_tokens ?? null,
      cachedTokens: completion.usage?.prompt_tokens_details?.cached_tokens ?? null,
    },
  };
}

export type CompletionEvent =
  | { type: "delta"; text: string }
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
    for await (const event of stream) {
      if (event.type === "message_start") {
        usage = anthropicUsage(event.message.usage);
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        if (event.delta.text) yield { type: "delta", text: event.delta.text };
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
        if (stop) finishReason = stop === "max_tokens" ? "length" : stop;
      }
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
  for await (const chunk of completion) {
    const choice = chunk.choices[0];
    const delta = choice?.delta?.content;
    if (delta) yield { type: "delta", text: delta };
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? null,
        completionTokens: chunk.usage.completion_tokens ?? null,
        cachedTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? null,
      };
    }
  }
  yield { type: "end", usage, finishReason };
}
