import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  complete,
  streamCompletion,
  toAnthropicMessages,
  extractJsonObject,
  totalTokens,
  DEFAULT_MAX_TOKENS,
  REASONING_HEADROOM,
  type CompletionEnv,
  type CompletionEvent,
} from "./completion";

const openaiCreate = vi.fn();
const anthropicCreate = vi.fn();

// Both SDKs stubbed: these tests are about the request each provider gets and
// how its answer is read, not about the SDKs. Classes rather than arrow
// functions because the call sites are `new OpenAI(...)` / `new Anthropic(...)`
// and vitest 4 forwards `new` straight to the implementation.
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
  },
}));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: anthropicCreate };
  },
}));

const env: CompletionEnv = { OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant-test" };
const openaiOnly: CompletionEnv = { OPENAI_API_KEY: "sk-test" };

/** An async iterable over a fixed list, which is all a stream is here. */
async function* replay<T>(events: T[]): AsyncGenerator<T> {
  for (const e of events) yield e;
}

async function collect(stream: AsyncGenerator<CompletionEvent>): Promise<CompletionEvent[]> {
  const out: CompletionEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

beforeEach(() => {
  openaiCreate.mockReset();
  anthropicCreate.mockReset();
  openaiCreate.mockResolvedValue({
    choices: [{ message: { content: "an answer" } }],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  });
  anthropicCreate.mockResolvedValue({
    content: [{ type: "text", text: "an answer" }],
    usage: { input_tokens: 100, output_tokens: 20 },
  });
});

describe("toAnthropicMessages", () => {
  it("lifts the leading system messages into the system field", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "You are Ada." },
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hello" },
    ]);

    expect(system).toBe("You are Ada.\n\nBe brief.");
    expect(messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("delivers a mid-conversation system message as a user turn", () => {
    // routes/chat.ts puts the retrieved-knowledge block in one, deliberately
    // after the cacheable prefix. Anthropic has no turn type for that on these
    // models, and dropping it would answer the question ungrounded.
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "You are Ada." },
      { role: "user", content: "What does the handbook say?" },
      { role: "assistant", content: "Let me check." },
      { role: "system", content: "KNOWLEDGE: the handbook says Tuesdays." },
      { role: "user", content: "Well?" },
    ]);

    expect(system).toBe("You are Ada.");
    expect(messages).toEqual([
      { role: "user", content: "What does the handbook say?" },
      { role: "assistant", content: "Let me check." },
      { role: "user", content: "KNOWLEDGE: the handbook says Tuesdays." },
      { role: "user", content: "Well?" },
    ]);
  });

  it("drops a leading assistant turn, which the API refuses outright", () => {
    // History trimming can cut mid-exchange and leave one first. OpenAI accepts
    // it; Anthropic returns a 400, so the whole reply would be lost to a
    // conversation being one message longer than the budget.
    const { messages } = toAnthropicMessages([
      { role: "system", content: "You are Ada." },
      { role: "assistant", content: "…as I was saying." },
      { role: "user", content: "Go on" },
    ]);

    expect(messages).toEqual([{ role: "user", content: "Go on" }]);
  });

  it("drops empty and whitespace-only messages", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "   " },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "" },
    ]);

    expect(system).toBe("");
    expect(messages).toEqual([{ role: "user", content: "Hi" }]);
  });

  it("refuses a request with nothing to answer", async () => {
    await expect(
      complete(env, { model: "claude-haiku-4-5", messages: [{ role: "system", content: "Hi" }] }),
    ).rejects.toThrow(/at least one user message/);
  });
});

describe("extractJsonObject", () => {
  it("leaves a bare object alone", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("unwraps a fenced object, which is how a model asked for JSON in words answers", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("finds the object inside surrounding prose", () => {
    expect(extractJsonObject('Sure! Here it is:\n{"a":1}\nHope that helps.')).toBe('{"a":1}');
  });

  it("returns the text unchanged when there is no object to find", () => {
    expect(extractJsonObject("I cannot help with that.")).toBe("I cannot help with that.");
  });
});

describe("complete, on OpenAI", () => {
  it("sends the messages through unchanged and reads the reply", async () => {
    const { text, usage } = await complete(openaiOnly, {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are Ada." },
        { role: "user", content: "Hello" },
      ],
    });

    expect(text).toBe("an answer");
    expect(usage).toEqual({ promptTokens: 100, completionTokens: 20, cachedTokens: null });
    const call = openaiCreate.mock.calls[0][0];
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0]).toEqual({ role: "system", content: "You are Ada." });
  });

  it("asks for JSON with the parameter, since it has one", () => {
    return complete(openaiOnly, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      json: true,
    }).then(() => {
      expect(openaiCreate.mock.calls[0][0].response_format).toEqual({ type: "json_object" });
    });
  });

  it("omits max_completion_tokens when the caller named no ceiling", async () => {
    await complete(openaiOnly, { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] });
    expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty("max_completion_tokens");
  });

  it("drops the temperature for a GPT-5 model, which would 400 on it", async () => {
    await complete(openaiOnly, {
      model: "gpt-5-mini",
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.9,
    });
    expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty("temperature");
  });

  describe("a reasoning model's budget", () => {
    // The regression this exists to stop. A GPT-5 model bills its thinking
    // against max_completion_tokens, so the persona drafter's 400 was spent
    // deliberating and the reply came back empty with finish_reason "length" —
    // an HTTP 200 that every caller here reads as "the model failed".

    it("adds headroom when the caller wants the thinking", async () => {
      await complete(openaiOnly, {
        model: "gpt-5",
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 1536,
      });
      expect(openaiCreate.mock.calls[0][0].max_completion_tokens).toBe(1536 + REASONING_HEADROOM);
      expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty("reasoning_effort");
    });

    it("honours the caller's own number when the task does not want thinking", async () => {
      await complete(openaiOnly, {
        model: "gpt-5-mini",
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 400,
        reasoningEffort: "minimal",
      });
      const call = openaiCreate.mock.calls[0][0];
      expect(call.max_completion_tokens).toBe(400);
      expect(call.reasoning_effort).toBe("minimal");
    });

    it("leaves a non-reasoning model's ceiling exactly as asked", async () => {
      // gpt-4o has nothing to make room for, and inflating its ceiling would be
      // spending someone's money to fix a problem it does not have.
      await complete(openaiOnly, {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 400,
      });
      const call = openaiCreate.mock.calls[0][0];
      expect(call.max_completion_tokens).toBe(400);
      expect(call).not.toHaveProperty("reasoning_effort");
    });

    it("sends no reasoning_effort to a model that has no such setting", async () => {
      await complete(openaiOnly, {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 400,
        reasoningEffort: "minimal",
      });
      expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty("reasoning_effort");
    });

    it("leaves an uncapped request uncapped rather than inventing a ceiling", async () => {
      await complete(openaiOnly, { model: "gpt-5", messages: [{ role: "user", content: "Hi" }] });
      expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty("max_completion_tokens");
    });
  });

  it("keeps it for a model that accepts one", async () => {
    await complete(openaiOnly, {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      temperature: 0.9,
    });
    expect(openaiCreate.mock.calls[0][0].temperature).toBe(0.9);
  });
});

describe("complete, on Anthropic", () => {
  it("splits the system prompt out and sends a max_tokens, which the API requires", async () => {
    const { text } = await complete(env, {
      model: "claude-sonnet-4-5",
      messages: [
        { role: "system", content: "You are Ada." },
        { role: "user", content: "Hello" },
      ],
    });

    expect(text).toBe("an answer");
    const call = anthropicCreate.mock.calls[0][0];
    expect(call.model).toBe("claude-sonnet-4-5");
    expect(call.system).toBe("You are Ada.");
    expect(call.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(call.max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("honours a ceiling the caller did name", async () => {
    await complete(env, {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "Hi" }],
      maxTokens: 400,
    });
    expect(anthropicCreate.mock.calls[0][0].max_tokens).toBe(400);
  });

  it("asks for JSON in words, because these models have no parameter for it", async () => {
    anthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: '```json\n{"persona":"You are Ada."}\n```' }],
      usage: { input_tokens: 10, output_tokens: 5 },
    });

    const { text } = await complete(env, {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "Draft a persona." },
        { role: "user", content: "Agent title: Support Agent" },
      ],
      json: true,
    });

    const call = anthropicCreate.mock.calls[0][0];
    expect(call.system).toContain("Draft a persona.");
    expect(call.system).toContain("single JSON object");
    expect(call).not.toHaveProperty("response_format");
    // The fence is stripped here rather than downstream: every caller does a
    // bare JSON.parse and reports a throw to the user as "the model failed".
    expect(JSON.parse(text)).toEqual({ persona: "You are Ada." });
  });

  it("joins several text blocks into one reply", async () => {
    anthropicCreate.mockResolvedValueOnce({
      content: [
        { type: "text", text: "one " },
        { type: "text", text: "two" },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    });

    const { text } = await complete(env, {
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "Hi" }],
    });
    expect(text).toBe("one two");
  });

  it("counts cached and cache-written tokens inside promptTokens, the way OpenAI reports them", async () => {
    // Anthropic's input_tokens excludes both; OpenAI's prompt_tokens includes
    // them. Everything downstream — the usage view, the quota counter,
    // lib/pricing — assumes cachedTokens is a subset, and would double-count
    // the moment it was not.
    anthropicCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 40,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 60,
        output_tokens: 20,
      },
    });

    const { usage } = await complete(env, {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(usage).toEqual({ promptTokens: 1000, completionTokens: 20, cachedTokens: 900 });
    expect(totalTokens(usage)).toBe(1020);
  });

  it("says which key is missing rather than letting Anthropic answer with a 401", async () => {
    await expect(
      complete(openaiOnly, {
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "H" }],
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe("streamCompletion", () => {
  it("asks OpenAI for the usage chunk, which is not sent unless requested", async () => {
    openaiCreate.mockResolvedValueOnce(
      replay([
        { choices: [{ delta: { content: "Hel" } }] },
        { choices: [{ delta: { content: "lo" } }] },
        { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } },
      ]),
    );

    const events = await collect(
      streamCompletion(openaiOnly, {
        model: "gpt-4o",
        messages: [{ role: "user", content: "Hi" }],
      }),
    );

    expect(openaiCreate.mock.calls[0][0].stream_options).toEqual({ include_usage: true });
    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      {
        type: "end",
        finishReason: null,
        usage: { promptTokens: 9, completionTokens: 2, cachedTokens: null },
      },
    ]);
  });

  it("reads Anthropic's two-part usage and emits one event at the end", async () => {
    // The input half arrives at message_start and the output half at
    // message_delta, so neither event alone is the answer.
    anthropicCreate.mockResolvedValueOnce(
      replay([
        {
          type: "message_start",
          message: { usage: { input_tokens: 9, cache_read_input_tokens: 1, output_tokens: 0 } },
        },
        { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
        { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
        { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
        { type: "message_delta", usage: { output_tokens: 2 } },
      ]),
    );

    const events = await collect(
      streamCompletion(env, {
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "Hi" }],
      }),
    );

    expect(anthropicCreate.mock.calls[0][0].stream).toBe(true);
    expect(events).toEqual([
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      {
        type: "end",
        finishReason: null,
        usage: { promptTokens: 10, completionTokens: 2, cachedTokens: 1 },
      },
    ]);
  });

  it("still reports usage when a stream carried no text at all", async () => {
    // routes/chat.ts records what a turn cost on every way it can end, so an
    // empty reply must still arrive with numbers attached.
    anthropicCreate.mockResolvedValueOnce(
      replay([
        { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: "message_delta", usage: { output_tokens: 0 } },
      ]),
    );

    const events = await collect(
      streamCompletion(env, {
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "Hi" }],
      }),
    );

    expect(events).toEqual([
      {
        type: "end",
        finishReason: null,
        usage: { promptTokens: 5, completionTokens: 0, cachedTokens: null },
      },
    ]);
  });

  describe("the truncation signal", () => {
    // routes/chat.ts sends a `truncated` event when this reads "length", which
    // is what tells the chat screen the answer was cut off rather than
    // finished. Both providers can truncate; only one of them calls it that.

    it("passes OpenAI's finish_reason straight through", async () => {
      openaiCreate.mockResolvedValueOnce(
        replay([
          { choices: [{ delta: { content: "Hel" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "length" }] },
          { choices: [], usage: { prompt_tokens: 9, completion_tokens: 2 } },
        ]),
      );

      const events = await collect(
        streamCompletion(openaiOnly, {
          model: "gpt-4o",
          messages: [{ role: "user", content: "Hi" }],
        }),
      );

      expect(events.at(-1)).toMatchObject({ type: "end", finishReason: "length" });
    });

    it("translates Anthropic's max_tokens into it", async () => {
      // The same event, spelled the other way. Left untranslated, a Claude
      // agent's answers would be silently cut off with nothing on screen.
      anthropicCreate.mockResolvedValueOnce(
        replay([
          { type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
          {
            type: "message_delta",
            delta: { stop_reason: "max_tokens" },
            usage: { output_tokens: 2 },
          },
        ]),
      );

      const events = await collect(
        streamCompletion(env, {
          model: "claude-haiku-4-5",
          messages: [{ role: "user", content: "Hi" }],
        }),
      );

      expect(events.at(-1)).toMatchObject({ type: "end", finishReason: "length" });
    });

    it("leaves a normal ending under its own name", async () => {
      anthropicCreate.mockResolvedValueOnce(
        replay([
          { type: "message_start", message: { usage: { input_tokens: 9, output_tokens: 0 } } },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 2 },
          },
        ]),
      );

      const events = await collect(
        streamCompletion(env, {
          model: "claude-haiku-4-5",
          messages: [{ role: "user", content: "Hi" }],
        }),
      );

      expect(events.at(-1)).toMatchObject({ type: "end", finishReason: "end_turn" });
    });
  });
});
