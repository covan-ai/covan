// worker/src/lib/routines/summarise.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_MODEL } from "../models";
import type { FeedItem } from "./feed";
import { summariseWithOpenAI } from "./summarise";

const createMock = vi.fn();

// Stub the OpenAI SDK entirely — these tests are about what we send it and
// how we read its response, not about the SDK itself. This is the one file
// on the branch where money is actually spent, so the call shape matters.
// vi.mock calls are hoisted above imports by vitest, so this applies before
// `./summarise` constructs its `new OpenAI(...)` client above.
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

describe("summariseWithOpenAI", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({
      choices: [{ message: { content: "the summary" } }],
      usage: { total_tokens: 42 },
    });
  });

  it("puts the persona in the system message and the instruction plus item titles in the user message", async () => {
    const summarise = summariseWithOpenAI(env);
    await summarise({
      persona: "You are Ada, a rigorous research assistant.",
      model: "gpt-4o",
      instruction: "Summarise the latest posts.",
      items: [item(1), item(2)],
    });

    const call = createMock.mock.calls[0][0];
    const systemMessage = call.messages.find((m: any) => m.role === "system");
    const userMessage = call.messages.find((m: any) => m.role === "user");

    expect(systemMessage.content).toContain("You are Ada, a rigorous research assistant.");
    expect(userMessage.content).toContain("Summarise the latest posts.");
    expect(userMessage.content).toContain("Item 1");
    expect(userMessage.content).toContain("Item 2");
  });

  it("makes exactly one completion call for a batch of items, not one per item", async () => {
    const summarise = summariseWithOpenAI(env);
    await summarise({
      persona: null,
      model: "gpt-4o",
      instruction: "Summarise.",
      items: [item(1), item(2), item(3)],
    });

    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it("truncates pageText at 20,000 characters for a web-watch routine", async () => {
    const summarise = summariseWithOpenAI(env);
    const bigText = "x".repeat(25_000);
    await summarise({
      persona: null,
      model: "gpt-4o",
      instruction: "Summarise the page.",
      items: [],
      pageText: bigText,
    });

    const call = createMock.mock.calls[0][0];
    const userMessage = call.messages.find((m: any) => m.role === "user");
    const xRun = userMessage.content.match(/x+/)?.[0] ?? "";
    expect(xRun.length).toBe(20_000);
  });

  it("resolves an unrecognised model to the default via resolveModel", async () => {
    const summarise = summariseWithOpenAI(env);
    await summarise({
      persona: null,
      model: "not-a-real-model",
      instruction: "Summarise.",
      items: [item(1)],
    });

    const call = createMock.mock.calls[0][0];
    expect(call.model).toBe(DEFAULT_MODEL);
  });

  it("reads tokens from usage.total_tokens, defaulting to 0 when usage is absent", async () => {
    const summarise = summariseWithOpenAI(env);

    const withUsage = await summarise({
      persona: null,
      model: "gpt-4o",
      instruction: "Summarise.",
      items: [item(1)],
    });
    expect(withUsage.tokens).toBe(42);

    createMock.mockResolvedValueOnce({ choices: [{ message: { content: "ok" } }] });
    const withoutUsage = await summarise({
      persona: null,
      model: "gpt-4o",
      instruction: "Summarise.",
      items: [item(1)],
    });
    expect(withoutUsage.tokens).toBe(0);
  });
});
