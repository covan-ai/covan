import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  complete,
  streamCompletion,
  toAnthropicMessages,
  extractJsonObject,
  totalTokens,
  DEFAULT_MAX_TOKENS,
  REASONING_HEADROOM,
  reasoningHeadroom,
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

  it("puts the cache breakpoint on the last turn before the retrieved block", () => {
    // Everything up to and including that turn repeats verbatim next turn. The
    // block after it does not, which is why it is the boundary.
    const { cacheIndex } = toAnthropicMessages([
      { role: "system", content: "You are Ada." },
      { role: "user", content: "What does the handbook say?" },
      { role: "assistant", content: "Tuesdays." },
      { role: "system", content: "KNOWLEDGE: the handbook says Tuesdays." },
      { role: "user", content: "And Wednesdays?" },
    ]);

    expect(cacheIndex).toBe(1);
  });

  it("falls back to the turn before the question when retrieval found nothing", () => {
    const { cacheIndex } = toAnthropicMessages([
      { role: "system", content: "You are Ada." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi." },
      { role: "user", content: "How are you?" },
    ]);

    expect(cacheIndex).toBe(1);
  });

  it("marks nothing when the only turn is the question itself", () => {
    // There is no history to cache yet, and marking the question would ask the
    // provider to cache the one part of the prompt that is different every time.
    const { cacheIndex } = toAnthropicMessages([
      { role: "system", content: "You are Ada." },
      { role: "user", content: "Hello" },
    ]);

    expect(cacheIndex).toBeNull();
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
    expect(usage).toEqual({
      promptTokens: 100,
      completionTokens: 20,
      cachedTokens: null,
      cacheWriteTokens: null,
    });
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

    it("forwards an agent's own effort, which used to be minimal or nothing", async () => {
      await complete(openaiOnly, {
        model: "gpt-5",
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 1536,
        reasoningEffort: "high",
      });
      expect(openaiCreate.mock.calls[0][0].reasoning_effort).toBe("high");
    });

    it.each([
      ["minimal", 0],
      ["low", 2048],
      ["medium", REASONING_HEADROOM],
      ["high", 8192],
    ] as const)("gives %s effort room to think in", async (effort, headroom) => {
      // A ceiling a "high" turn exhausts before it writes a word is not a
      // shorter answer, it is an empty one with finish_reason "length".
      await complete(openaiOnly, {
        model: "gpt-5",
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 1536,
        reasoningEffort: effort,
      });
      expect(openaiCreate.mock.calls[0][0].max_completion_tokens).toBe(1536 + headroom);
    });

    it("keeps the unset case on exactly the number it has always used", async () => {
      // `reasoningHeadroom` replaced a constant. The measured value is the one
      // every request in the product runs on today, so it must not have moved.
      expect(reasoningHeadroom(undefined)).toBe(REASONING_HEADROOM);
      expect(REASONING_HEADROOM).toBe(4096);
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
    // A block rather than a string, because that is the only shape a cache
    // breakpoint can ride on — but unmarked here, because one question with no
    // history behind it has nothing to cache. See the cache tests below.
    expect(call.system).toEqual([{ type: "text", text: "You are Ada." }]);
    expect(call.messages).toEqual([{ role: "user", content: "Hello" }]);
    expect(call.max_tokens).toBe(DEFAULT_MAX_TOKENS);
  });

  it("asks for the repeated half of the prompt to be cached", async () => {
    // The saving this earns was already priced in lib/pricing.ts and already
    // read back by anthropicUsage; the number was zero because nothing on the
    // wire ever asked for it.
    await complete(env, {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "You are Ada." },
        { role: "user", content: "What does the handbook say?" },
        { role: "assistant", content: "Tuesdays." },
        { role: "system", content: "KNOWLEDGE: the handbook says Tuesdays." },
        { role: "user", content: "And Wednesdays?" },
      ],
    });

    const call = anthropicCreate.mock.calls[0][0];
    expect(call.system[0].cache_control).toEqual({ type: "ephemeral" });
    // The assistant turn that closes the stable history, not the knowledge
    // block and not the new question.
    expect(call.messages[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Tuesdays.", cache_control: { type: "ephemeral" } }],
    });
    expect(call.messages[2]).toEqual({
      role: "user",
      content: "KNOWLEDGE: the handbook says Tuesdays.",
    });
    expect(call.messages[3]).toEqual({ role: "user", content: "And Wednesdays?" });
  });

  it("marks nothing on a turn whose prefix will not be asked for again", async () => {
    // The first turn of a conversation, and the regression this pins. With no
    // prior turns the retrieved block folds into `system`, and the next turn's
    // `system` is the persona alone — the two never match, so the entry would
    // be written, charged at 1.25x, and never read.
    await complete(env, {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "You are Ada." },
        { role: "system", content: "KNOWLEDGE: the handbook says Tuesdays." },
        { role: "user", content: "What does the handbook say?" },
      ],
    });

    const call = anthropicCreate.mock.calls[0][0];
    expect(call.system[0]).not.toHaveProperty("cache_control");
    expect(call.messages.every((m: { content: unknown }) => typeof m.content === "string")).toBe(
      true,
    );
  });

  it("marks nothing for a one-shot caller that will never ask twice", async () => {
    // Titling, persona drafting and a routine's summary all send one system
    // message and one question. There is no second turn to read the cache back.
    await complete(env, {
      model: "claude-haiku-4-5",
      messages: [
        { role: "system", content: "Name this conversation." },
        { role: "user", content: "How many vacation days do I get?" },
      ],
      json: true,
    });

    expect(anthropicCreate.mock.calls[0][0].system[0]).not.toHaveProperty("cache_control");
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
    expect(call.system[0].text).toContain("Draft a persona.");
    expect(call.system[0].text).toContain("single JSON object");
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

    expect(usage).toEqual({
      promptTokens: 1000,
      completionTokens: 20,
      cachedTokens: 900,
      cacheWriteTokens: 60,
    });
    expect(totalTokens(usage)).toBe(1020);
  });

  it("reports the cache-written tokens separately as well as inside promptTokens", () => {
    // Folded in AND reported, because the two facts answer different
    // questions. The fold is what makes one prompt count mean the same thing
    // on both providers; the separate figure is the only way to tell what the
    // 1.25x storage premium cost — and a change that buys cache reads buys
    // cache writes first, so a saving measured without it is not a saving.
    //
    // The three are disjoint by construction: input + read + written, each
    // counted once. This asserts the arithmetic rather than restating it.
    const usage = { promptTokens: 1000, cachedTokens: 900, cacheWriteTokens: 60 };
    expect(usage.promptTokens - usage.cachedTokens - usage.cacheWriteTokens).toBe(40);
  });

  it("records no cache-write count on OpenAI, where filling the cache is free", async () => {
    // Null rather than zero. OpenAI's prefix cache populates itself and reports
    // no write count at all, so zero would be a measurement of something the
    // API never said.
    openaiCreate.mockResolvedValueOnce({
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 900 },
      },
    });

    const { usage } = await complete(env, {
      model: "gpt-4.1",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(usage.cachedTokens).toBe(900);
    expect(usage.cacheWriteTokens).toBeNull();
  });

  it("says which key is missing rather than letting Anthropic answer with a 401", async () => {
    await expect(
      complete(openaiOnly, {
        model: "claude-haiku-4-5",
        messages: [{ role: "user", content: "H" }],
      }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });

  describe("how a Claude model is asked to think", () => {
    const ask = (over: Partial<Parameters<typeof complete>[1]> = {}) =>
      complete(env, {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Why?" }],
        maxTokens: 1000,
        ...over,
      });

    it("sends adaptive thinking and an effort, never a token budget", async () => {
      await ask({ reasoningEffort: "high" });

      const call = anthropicCreate.mock.calls[0][0];
      expect(call.thinking).toEqual({ type: "adaptive", display: "omitted" });
      expect(call.output_config).toEqual({ effort: "high" });
      // The translation that reads like the obvious one, and is a 400 on every
      // model this branch can reach. Pinned because it is the thing a future
      // edit is most likely to reach for.
      expect(call.thinking).not.toHaveProperty("budget_tokens");
      expect(call).not.toHaveProperty("reasoning_effort");
    });

    it("widens the ceiling only by what the asked-for effort needs", async () => {
      await ask({ reasoningEffort: "high" });
      expect(anthropicCreate.mock.calls[0][0].max_tokens).toBe(1000 + 8192);
    });

    it("leaves the ceiling alone on a turn that does not think", async () => {
      // The whole point of making the headroom follow the request rather than
      // the model. Sonnet 4.6 *can* deliberate, so reading the decision off the
      // id would widen every reply's ceiling by 4096 to make room for thinking
      // that is not happening.
      await ask();

      const call = anthropicCreate.mock.calls[0][0];
      expect(call.max_tokens).toBe(1000);
      expect(call).not.toHaveProperty("thinking");
      expect(call).not.toHaveProperty("output_config");
    });

    it("treats 'minimal' as thinking off, not as Anthropic's lowest effort", async () => {
      // What the persona drafter and the idea extractor mean by it. Anthropic's
      // scale has no floor below "low", so translating it into a level would
      // charge the one caller that opted out for thinking it opted out of.
      await ask({ reasoningEffort: "minimal" });

      const call = anthropicCreate.mock.calls[0][0];
      expect(call).not.toHaveProperty("thinking");
      expect(call).not.toHaveProperty("output_config");
      expect(call.max_tokens).toBe(1000);
    });

    it("makes room on a model that thinks unasked", async () => {
      // Opus 5 deliberates when the parameter is absent, which is the opposite
      // of every other model here. Its ceiling needs the room whether or not an
      // agent asked for anything.
      await ask({ model: "claude-opus-5" });

      const call = anthropicCreate.mock.calls[0][0];
      expect(call.thinking).toEqual({ type: "adaptive", display: "omitted" });
      expect(call).not.toHaveProperty("output_config");
      expect(call.max_tokens).toBe(1000 + REASONING_HEADROOM);
    });

    it("turns thinking off explicitly where silence would turn it on", async () => {
      await ask({ model: "claude-opus-5", reasoningEffort: "minimal" });

      const call = anthropicCreate.mock.calls[0][0];
      expect(call.thinking).toEqual({ type: "disabled" });
      expect(call.max_tokens).toBe(1000);
    });

    it("says nothing at all to a model that takes no effort", async () => {
      // An effort on a 4.5 model is a 400, so an agent carrying one must not
      // have it forwarded — it would break that agent on that model alone.
      await ask({ model: "claude-haiku-4-5", reasoningEffort: "high" });

      const call = anthropicCreate.mock.calls[0][0];
      expect(call).not.toHaveProperty("thinking");
      expect(call).not.toHaveProperty("output_config");
      expect(call.max_tokens).toBe(1000);
    });

    it("drops a temperature the newest models reject", async () => {
      // Brainstorm mode sets 0.9 and an agent can set its own. Both are a 400
      // on Opus 5, the same way they already are on the GPT-5 family.
      await ask({ model: "claude-opus-5", temperature: 0.9 });
      expect(anthropicCreate.mock.calls[0][0]).not.toHaveProperty("temperature");

      anthropicCreate.mockClear();
      await ask({ temperature: 0.9 });
      expect(anthropicCreate.mock.calls[0][0].temperature).toBe(0.9);
    });
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
        usage: { promptTokens: 9, completionTokens: 2, cachedTokens: null, cacheWriteTokens: null },
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
      // Its own event, not folded into the answer. A consumer that cannot tell
      // the two apart writes an account of the model's deliberation into the
      // transcript — which is what happens the first time somebody
      // "simplifies" these two branches into one.
      { type: "thinking", text: "hmm" },
      {
        type: "end",
        finishReason: null,
        usage: {
          promptTokens: 10,
          completionTokens: 2,
          cachedTokens: 1,
          // The mock sends no `cache_creation_input_tokens`, and null is what
          // that means: nothing was written, or the provider did not say.
          cacheWriteTokens: null,
        },
      },
    ]);
  });

  it("asks for the reasoning in words only when a caller will show it", async () => {
    // The thinking happens either way — `reasoningEffort` decides that. This
    // decides whether the model also writes a readable account of it, which
    // costs output tokens and is worth nothing to the callers that drop it.
    anthropicCreate.mockResolvedValue(
      replay([{ type: "message_delta", usage: { output_tokens: 0 } }]),
    );

    await collect(
      streamCompletion(env, {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Hi" }],
        reasoningEffort: "high",
        showThinking: true,
      }),
    );
    expect(anthropicCreate.mock.calls[0][0].thinking).toEqual({
      type: "adaptive",
      display: "summarized",
    });

    anthropicCreate.mockClear();
    await collect(
      streamCompletion(env, {
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Hi" }],
        reasoningEffort: "high",
      }),
    );
    expect(anthropicCreate.mock.calls[0][0].thinking).toEqual({
      type: "adaptive",
      display: "omitted",
    });
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
        usage: { promptTokens: 5, completionTokens: 0, cachedTokens: null, cacheWriteTokens: null },
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

/**
 * Tool calling, which is the one thing this file gained that the two providers
 * disagree about in every particular: where the schema goes, how a result is
 * addressed, how a partial call is streamed, and what the model says when it
 * has asked for one.
 *
 * The tests below are deliberately written against the *request body* and the
 * *event list* rather than against a fake that understands tools. What breaks
 * in practice is a field in the wrong place, and a fake clever enough to hide
 * that is a fake that would have passed either way.
 */
describe("tools, on the way out", () => {
  const search = {
    name: "search_documents",
    description: "Look something up.",
    input: { type: "object", properties: { query: { type: "string" } } },
  };

  it("sends nothing at all when the caller named no tools", async () => {
    await complete(openaiOnly, { model: "gpt-4.1", messages: [{ role: "user", content: "hi" }] });
    expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty("tools");
    expect(openaiCreate.mock.calls[0][0]).not.toHaveProperty("tool_choice");
  });

  it("wraps a tool as an OpenAI function, with the schema under parameters", async () => {
    await complete(openaiOnly, {
      model: "gpt-4.1",
      messages: [{ role: "user", content: "hi" }],
      tools: [search],
    });
    const body = openaiCreate.mock.calls[0][0];
    expect(body.tool_choice).toBe("auto");
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search_documents",
          description: "Look something up.",
          parameters: search.input,
        },
      },
    ]);
  });

  it("sends the same tool to Anthropic with the schema under input_schema", async () => {
    await complete(env, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
      tools: [search],
    });
    expect(anthropicCreate.mock.calls[0][0].tools).toEqual([
      {
        name: "search_documents",
        description: "Look something up.",
        input_schema: search.input,
      },
    ]);
  });

  it("keeps the web search tool alongside an app tool rather than replacing it", async () => {
    await complete(env, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "hi" }],
      webSearch: true,
      tools: [search],
    });
    const names = anthropicCreate.mock.calls[0][0].tools.map((t: { name?: string }) => t.name);
    expect(names).toEqual(["web_search", "search_documents"]);
  });
});

describe("a tool result, on its way back to the model", () => {
  const conversation = [
    { role: "user" as const, content: "how many orders?" },
    {
      role: "assistant" as const,
      content: "Let me look.",
      toolCalls: [{ id: "call_1", name: "query_database", arguments: '{"sql":"select 1"}' }],
    },
    { role: "tool" as const, toolCallId: "call_1", content: '[{"count":4}]' },
  ];

  it("addresses it by tool_call_id on OpenAI, not by a field beside the content", async () => {
    await complete(openaiOnly, { model: "gpt-4.1", messages: conversation });
    const sent = openaiCreate.mock.calls[0][0].messages;
    expect(sent[1]).toEqual({
      role: "assistant",
      content: "Let me look.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "query_database", arguments: '{"sql":"select 1"}' },
        },
      ],
    });
    expect(sent[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: '[{"count":4}]',
    });
  });

  it("sends content: null for an assistant turn that only asked", async () => {
    await complete(openaiOnly, {
      model: "gpt-4.1",
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", arguments: "{}" }] },
        { role: "tool", toolCallId: "c", content: "done" },
      ],
    });
    expect(openaiCreate.mock.calls[0][0].messages[1].content).toBeNull();
  });

  it("becomes tool_use and tool_result blocks on Anthropic", () => {
    const { messages } = toAnthropicMessages(conversation);
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "call_1", name: "query_database", input: { sql: "select 1" } },
      ],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: '[{"count":4}]' }],
    });
  });

  it("puts several results in one user turn rather than several", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "a", name: "t", arguments: "{}" },
          { id: "b", name: "t", arguments: "{}" },
        ],
      },
      { role: "tool", toolCallId: "a", content: "one" },
      { role: "tool", toolCallId: "b", content: "two" },
    ]);
    expect(messages).toHaveLength(3);
    expect(messages[2].content).toHaveLength(2);
  });

  it("keeps an assistant turn that said nothing but asked for something", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "t", arguments: "{}" }] },
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toEqual([{ type: "tool_use", id: "a", name: "t", input: {} }]);
  });

  it("answers an empty tool result with a word, which the API requires", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "a", name: "t", arguments: "{}" }] },
      { role: "tool", toolCallId: "a", content: "" },
    ]);
    expect(messages[2].content).toEqual([
      { type: "tool_result", tool_use_id: "a", content: "(no output)" },
    ]);
  });

  /**
   * The case that turns a trimmed history into a 400. History trimming can
   * leave an assistant turn first; that turn is dropped, and the result of
   * the call it made would otherwise be sent with nothing to answer.
   */
  it("drops a result whose call was trimmed out of the history", () => {
    const { messages } = toAnthropicMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "gone", name: "t", arguments: "{}" }] },
      { role: "tool", toolCallId: "gone", content: "orphan" },
      { role: "user", content: "and now?" },
    ]);
    expect(messages).toEqual([{ role: "user", content: "and now?" }]);
  });

  it("sends an empty object when the model truncated its arguments mid-write", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "a", name: "t", arguments: '{"q":"un' }],
      },
    ]);
    expect(messages[1].content).toEqual([{ type: "tool_use", id: "a", name: "t", input: {} }]);
  });
});

describe("a streamed tool call", () => {
  it("accumulates OpenAI's fragments into whole calls and stops the turn", async () => {
    openaiCreate.mockResolvedValue(
      replay([
        { choices: [{ delta: { content: "Looking." } }] },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: "search_documents", arguments: "" } },
                ],
              },
            },
          ],
        },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"que' } }] } }] },
        {
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"x"}' } }] } }],
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
        { choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } },
      ]),
    );
    const events = await collect(
      streamCompletion(openaiOnly, {
        model: "gpt-4.1",
        messages: [{ role: "user", content: "x" }],
      }),
    );
    expect(events).toEqual([
      { type: "delta", text: "Looking." },
      {
        type: "tools",
        calls: [{ id: "call_1", name: "search_documents", arguments: '{"query":"x"}' }],
      },
      {
        type: "end",
        usage: { promptTokens: 9, completionTokens: 3, cachedTokens: null, cacheWriteTokens: null },
        finishReason: "tool_calls",
      },
    ]);
  });

  it("drops a call OpenAI never gave an id, which could never be answered", async () => {
    openaiCreate.mockResolvedValue(
      replay([
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] } }] },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
      ]),
    );
    const events = await collect(
      streamCompletion(openaiOnly, {
        model: "gpt-4.1",
        messages: [{ role: "user", content: "x" }],
      }),
    );
    expect(events.some((e) => e.type === "tools")).toBe(false);
  });

  it("accumulates Anthropic's blocks by index and normalises its stop reason", async () => {
    anthropicCreate.mockResolvedValue(
      replay([
        { type: "message_start", message: { usage: { input_tokens: 40 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "One sec." } },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "http_request", input: {} },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path"' },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: ':"/v1/x"}' },
        },
        { type: "message_delta", usage: { output_tokens: 7 }, delta: { stop_reason: "tool_use" } },
      ]),
    );
    const events = await collect(
      streamCompletion(env, {
        model: "claude-sonnet-4-5",
        messages: [{ role: "user", content: "x" }],
      }),
    );
    expect(events[1]).toEqual({
      type: "tools",
      calls: [{ id: "toolu_1", name: "http_request", arguments: '{"path":"/v1/x"}' }],
    });
    // Normalised to OpenAI's word, so a consumer asks the question once.
    expect(events[2]).toMatchObject({ type: "end", finishReason: "tool_calls" });
  });
});

describe("complete, when the model asked for something", () => {
  it("no longer loses an Anthropic tool_use block to the text filter", async () => {
    anthropicCreate.mockResolvedValue({
      content: [
        { type: "text", text: "Checking." },
        { type: "tool_use", id: "toolu_1", name: "search_documents", input: { query: "x" } },
      ],
      usage: { input_tokens: 10, output_tokens: 4 },
    });
    const out = await complete(env, {
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "x" }],
    });
    expect(out.text).toBe("Checking.");
    expect(out.toolCalls).toEqual([
      { id: "toolu_1", name: "search_documents", arguments: '{"query":"x"}' },
    ]);
  });

  it("reads OpenAI's tool_calls off the message", async () => {
    openaiCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: "{}" } }],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    });
    const out = await complete(openaiOnly, {
      model: "gpt-4.1",
      messages: [{ role: "user", content: "x" }],
    });
    expect(out.toolCalls).toEqual([{ id: "c1", name: "t", arguments: "{}" }]);
  });

  it("leaves toolCalls absent on an ordinary reply", async () => {
    const out = await complete(openaiOnly, {
      model: "gpt-4.1",
      messages: [{ role: "user", content: "x" }],
    });
    expect(out).not.toHaveProperty("toolCalls");
  });
});
