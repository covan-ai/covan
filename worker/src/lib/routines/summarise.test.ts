// worker/src/lib/routines/summarise.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_MODEL } from "../models";
import type { FeedItem } from "./feed";
import { summariseWithModel } from "./summarise";

const createMock = vi.fn();

// Stub the OpenAI SDK entirely — these tests are about what we send it and
// how we read its response, not about the SDK itself. This is the one file
// on the branch where money is actually spent, so the call shape matters.
// vi.mock calls are hoisted above imports by vitest, so this applies before
// `lib/completion` constructs its `new OpenAI(...)` client.
//
// OpenAI's SDK rather than Anthropic's because a routine's env here has no
// ANTHROPIC_API_KEY, so `resolveModel` cannot route one to Anthropic — the
// Claude request shape is covered in `lib/completion.test.ts` instead.
//
// A class, not `vi.fn().mockImplementation(() => ...)`. The call site is `new
// OpenAI(...)`, and vitest 4 forwards `new` straight to the implementation
// instead of calling it plainly — so an arrow function there throws "is not a
// constructor". Nothing asserts how the constructor was called, only what
// `create` received, so the mock does not need to be a spy.
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
  },
}));

const env = { OPENAI_API_KEY: "sk-test" } as any;

const item = (n: number): FeedItem => ({
  key: `k${n}`,
  title: `Item ${n}`,
  link: `https://example.com/${n}`,
  publishedAt: null,
  summary: `summary body ${n}`,
});

describe("summariseWithModel", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({
      choices: [{ message: { content: "the summary" } }],
      usage: { prompt_tokens: 30, completion_tokens: 12 },
    });
  });

  it("puts the persona in the system message and the instruction plus item titles in the user message", async () => {
    const summarise = summariseWithModel(env);
    await summarise({
      persona: "You are Ada, a rigorous research assistant.",
      model: "gpt-4o",
      instruction: "Summarise the latest posts.",
      items: [item(1), item(2)],
      ragBlock: "",
      mayDecline: false,
    });

    const call = createMock.mock.calls[0][0];
    const systemMessage = call.messages.find((m: any) => m.role === "system");
    const userMessage = call.messages.find((m: any) => m.role === "user");

    expect(systemMessage.content).toContain("You are Ada, a rigorous research assistant.");
    expect(userMessage.content).toContain("Summarise the latest posts.");
    expect(userMessage.content).toContain("Item 1");
    expect(userMessage.content).toContain("Item 2");
  });

  // A routine is meant to be the same colleague as the one in the chat window.
  // It was not: chat put the agent's retrieved documents in their own system
  // message and this path had none at all, so the agent that could quote the
  // handbook when asked had forgotten it by the time it wrote the digest.
  it("carries what the agent knows in its own system message, as chat does", async () => {
    const summarise = summariseWithModel(env);
    await summarise({
      persona: "You are Ada.",
      model: "gpt-4o",
      instruction: "Flag competitor pricing moves.",
      items: [item(1)],
      ragBlock: "Excerpt from Pricing.md: our Pro tier is $29.",
      mayDecline: false,
    });

    const messages = createMock.mock.calls[0][0].messages;
    const systemMessages = messages.filter((m: any) => m.role === "system");

    // Two, not one concatenated block: the persona is the agent's standing
    // identity and the excerpts are this run's material, and merging them
    // invites the model to read retrieved text as instructions.
    expect(systemMessages).toHaveLength(2);
    expect(systemMessages[1].content).toContain("our Pro tier is $29");
    // Before the user turn it grounds, same as `routes/chat.ts` assembles it.
    expect(messages[messages.length - 1].role).toBe("user");
  });

  it("sends no grounding message when retrieval found nothing", async () => {
    const summarise = summariseWithModel(env);
    await summarise({
      persona: "You are Ada.",
      model: "gpt-4o",
      instruction: "Summarise.",
      items: [item(1)],
      ragBlock: "",
      mayDecline: false,
    });

    const messages = createMock.mock.calls[0][0].messages;
    expect(messages.filter((m: any) => m.role === "system")).toHaveLength(1);
  });

  // A series like "Somebody's first week" tells the model which morning it is
  // on through this field rather than relying on memory or a second call —
  // see `routine-templates.ts`'s `first-week` instruction, which picks a
  // subject by the number this line gives it.
  it("tells the model which run of how many this is", async () => {
    const summarise = summariseWithModel(env);
    await summarise({
      persona: "You are Ada.",
      model: "gpt-4o",
      instruction: "Write today's note.",
      items: [item(1)],
      ragBlock: "",
      mayDecline: false,
      runPosition: { done: 2, total: 7 },
    });

    const systemMessage = createMock.mock.calls[0][0].messages.find(
      (m: any) => m.role === "system",
    );
    // Third morning: two are done, this is the one being written.
    expect(systemMessage.content).toContain("3 of 7");
  });

  it("says nothing about position for a routine that does not end", async () => {
    const summarise = summariseWithModel(env);
    await summarise({
      persona: "You are Ada.",
      model: "gpt-4o",
      instruction: "Write today's note.",
      items: [item(1)],
      ragBlock: "",
      mayDecline: false,
    });

    const systemMessage = createMock.mock.calls[0][0].messages.find(
      (m: any) => m.role === "system",
    );
    expect(systemMessage.content).not.toMatch(/\d+ of \d+/);
  });

  it("makes exactly one completion call for a batch of items, not one per item", async () => {
    const summarise = summariseWithModel(env);
    await summarise({
      persona: null,
      model: "gpt-4o",
      instruction: "Summarise.",
      items: [item(1), item(2), item(3)],
      ragBlock: "",
      mayDecline: false,
    });

    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("truncates pageText at 20,000 characters for a web-watch routine", async () => {
    const summarise = summariseWithModel(env);
    const bigText = "x".repeat(25_000);
    await summarise({
      persona: null,
      model: "gpt-4o",
      instruction: "Summarise the page.",
      items: [],
      pageText: bigText,
      ragBlock: "",
      mayDecline: false,
    });

    const call = createMock.mock.calls[0][0];
    const userMessage = call.messages.find((m: any) => m.role === "user");
    const xRun = userMessage.content.match(/x+/)?.[0] ?? "";
    expect(xRun.length).toBe(20_000);
  });

  it("resolves an unrecognised model to the default via resolveModel", async () => {
    const summarise = summariseWithModel(env);
    await summarise({
      persona: null,
      model: "not-a-real-model",
      instruction: "Summarise.",
      items: [item(1)],
      ragBlock: "",
      mayDecline: false,
    });

    const call = createMock.mock.calls[0][0];
    expect(call.model).toBe(DEFAULT_MODEL);
  });

  it("sends OPENAI_MODEL instead of the routine's own model, so a routine reaches a self-hosted endpoint's catalogue too", async () => {
    const summarise = summariseWithModel({
      OPENAI_API_KEY: "sk-test",
      OPENAI_BASE_URL: "http://localhost:11434/v1",
      OPENAI_MODEL: "llama3.3:70b",
    } as any);
    await summarise({
      persona: null,
      model: "gpt-4o",
      instruction: "Summarise.",
      items: [item(1)],
      ragBlock: "",
      mayDecline: false,
    });

    expect(createMock.mock.calls[0][0].model).toBe("llama3.3:70b");
  });

  it("bills prompt plus completion tokens, and 0 when the endpoint reports no usage at all", async () => {
    const summarise = summariseWithModel(env);

    const withUsage = await summarise({
      persona: null,
      model: "gpt-4o",
      instruction: "Summarise.",
      items: [item(1)],
      ragBlock: "",
      mayDecline: false,
    });
    expect(withUsage.tokens).toBe(42);

    createMock.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] });
    const withoutUsage = await summarise({
      persona: null,
      model: "gpt-4o",
      instruction: "Summarise.",
      items: [item(1)],
      ragBlock: "",
      mayDecline: false,
    });
    expect(withoutUsage.tokens).toBe(0);
  });

  // ---- deciding not to send ------------------------------------------------
  //
  // A routine used to send whatever the model wrote, every time it had new
  // entries. Ask for "anything about our competitors" against a general news
  // feed and most runs are six unrelated posts and a paragraph explaining that
  // none of them are about competitors — which arrives hourly, in a Slack
  // channel, until somebody mutes it. The routine is then technically working
  // and practically dead.

  const declining = (over: Record<string, unknown> = {}) => ({
    persona: "You are Ada.",
    model: "gpt-4o",
    instruction: "Flag anything about our competitors.",
    items: [item(1), item(2)],
    ragBlock: "",
    mayDecline: true,
    ...over,
  });

  it("reports a declined run when the model says nothing matched", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: '{"relevant": false, "summary": ""}' } }],
      usage: { prompt_tokens: 30, completion_tokens: 12 },
    });

    const result = await summariseWithModel(env)(declining());

    expect(result.declined).toBe(true);
    // Still billed. The call that produced the judgement is the call that costs
    // money — silence is cheaper in noise, not in tokens.
    expect(result.tokens).toBe(42);
  });

  it("returns the summary, not the envelope, when something did match", async () => {
    createMock.mockResolvedValue({
      choices: [
        { message: { content: '{"relevant": true, "summary": "Acme launched a Pro tier."}' } },
      ],
      usage: { prompt_tokens: 30, completion_tokens: 12 },
    });

    const result = await summariseWithModel(env)(declining());

    expect(result.declined).toBe(false);
    expect(result.text).toBe("Acme launched a Pro tier.");
  });

  // The whole safety of this feature. A routine that goes quiet looks exactly
  // like a routine with nothing to report, so a parse bug would be invisible
  // for weeks. Failing open means the worst case is the noise we had before.
  it("sends the raw text rather than going silent when the JSON is unreadable", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: "I could not follow the format. Acme launched a tier." } }],
      usage: { prompt_tokens: 30, completion_tokens: 12 },
    });

    const result = await summariseWithModel(env)(declining());

    expect(result.declined).toBe(false);
    expect(result.text).toBe("I could not follow the format. Acme launched a tier.");
  });

  it("sends rather than going silent when the object omits the decision", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: '{"summary": "Acme launched a Pro tier."}' } }],
      usage: { prompt_tokens: 30, completion_tokens: 12 },
    });

    const result = await summariseWithModel(env)(declining());

    expect(result.declined).toBe(false);
  });

  // A scheduled prompt has no source, so there is nothing for its output to be
  // irrelevant *to* — the instruction is the whole job. Asking anyway would let
  // one `false` silence "remind the team to post standup" forever.
  it("does not ask for a decision at all when the routine may not decline", async () => {
    await summariseWithModel(env)(declining({ mayDecline: false }));

    const call = createMock.mock.calls[0][0];
    expect(call.response_format).toBeUndefined();
  });

  it("asks for a decision when the routine may decline", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: '{"relevant": true, "summary": "x"}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

    await summariseWithModel(env)(declining());

    expect(createMock.mock.calls[0][0].response_format).toEqual({ type: "json_object" });
  });
});

/**
 * What the row could not say about the call underneath it.
 *
 * `routine_runs.status` is a delivery verdict — `ok` means something was sent.
 * It cannot tell a report the model finished from a report that hit its token
 * ceiling, and this is the surface with nobody watching. Both facts were in
 * hand here already: `resolveModel` settles the model at the top of the call,
 * and `complete` has returned a normalised `finishReason` since covan#209.
 * See 0070.
 */
describe("what the run will record about the call", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({
      choices: [{ message: { content: "the summary" } }, { finish_reason: "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 12 },
    });
  });

  it("names the model it actually resolved, not the one it was asked for", async () => {
    // The distinction matters on this path more than on any other: nobody is
    // watching, so an agent whose stored model has had its key rotated out
    // falls back silently. The row has to say which model answered.
    createMock.mockResolvedValue({
      choices: [{ message: { content: "the summary" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 12 },
    });
    const summarise = summariseWithModel(env);

    const out = await summarise({
      persona: "You are Ada.",
      model: "claude-opus-5",
      instruction: "Summarise.",
      items: [item(1)],
      ragBlock: "",
      mayDecline: false,
    });

    // No ANTHROPIC_API_KEY in this env, so the Claude pick cannot be served.
    expect(out.model).toBe(DEFAULT_MODEL);
    expect(out.modelOutcome).toBe("answered");
  });

  it("says truncated when the report hit its ceiling", async () => {
    createMock.mockResolvedValue({
      choices: [{ message: { content: "the summary, cut o" }, finish_reason: "length" }],
      usage: { prompt_tokens: 30, completion_tokens: 12 },
    });
    const summarise = summariseWithModel(env);

    const out = await summarise({
      persona: "You are Ada.",
      model: "gpt-4o",
      instruction: "Summarise.",
      items: [item(1)],
      ragBlock: "",
      mayDecline: false,
    });

    expect(out.modelOutcome).toBe("truncated");
  });

  it("says empty when the model came back with nothing", async () => {
    // The value 0065 put in the vocabulary and nothing could reach. A run that
    // paid for a call and got no words is not an answered run, and on a
    // schedule there is nobody to notice.
    createMock.mockResolvedValue({
      choices: [{ message: { content: "" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 12 },
    });
    const summarise = summariseWithModel(env);

    const out = await summarise({
      persona: "You are Ada.",
      model: "gpt-4o",
      instruction: "Summarise.",
      items: [item(1)],
      ragBlock: "",
      mayDecline: false,
    });

    expect(out.modelOutcome).toBe("empty");
  });
});
