import type OpenAI from "openai";
import type Anthropic from "@anthropic-ai/sdk";
import { createOpenAI } from "./openai";
import { createAnthropic } from "./anthropic";
import { providerFor, acceptsTemperature } from "./models";

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
};

/**
 * What Anthropic gets when a caller named no ceiling. `max_tokens` is required
 * by that API, so "unbounded" is not a thing that can be sent; this is large
 * enough for the two callers that omit it (a routine's summary, a routine
 * draft) and still a real stop.
 */
export const DEFAULT_MAX_TOKENS = 4096;

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
  return {
    model: req.model,
    messages: req.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    ...(req.maxTokens !== undefined ? { max_completion_tokens: req.maxTokens } : {}),
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
 */
export function toAnthropicMessages(messages: CompletionMessage[]): {
  system: string;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const out: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    const content = message.content?.trim();
    if (!content) continue;
    if (message.role === "system") {
      if (out.length === 0) systemParts.push(content);
      else out.push({ role: "user", content });
      continue;
    }
    // Nothing to answer yet, so an assistant turn here is history that lost its
    // question. Sending it is a 400; keeping it is a reply to nobody.
    if (message.role === "assistant" && out.length === 0) continue;
    out.push({ role: message.role, content });
  }

  return { system: systemParts.join("\n\n"), messages: out };
}

// Without `stream`, so the two call sites below can each add their own and get
// back the overload they want rather than a union of both.
function anthropicParams(
  req: CompletionRequest,
): Omit<Anthropic.MessageCreateParamsNonStreaming, "stream"> {
  const { system, messages } = toAnthropicMessages(req.messages);
  if (messages.length === 0) {
    throw new Error("a completion needs at least one user message");
  }
  const systemText = [system, req.json ? JSON_ONLY_INSTRUCTION : ""].filter(Boolean).join("\n\n");
  return {
    model: req.model,
    messages,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(systemText ? { system: systemText } : {}),
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
