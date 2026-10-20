import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext, ToolEnv } from "../registry";

/**
 * Reading every page of an operation for one question.
 *
 * Composio, the small model and the ledger are all stubbed: what is under test
 * is the paging — that the token goes back in the argument the schema names,
 * that it stops when the pages, the time or the money run out and says which,
 * and that the turn is handed the findings rather than the pages.
 */
const execute = vi.fn();
vi.mock("../../composio/client", () => ({
  executeTool: (...args: unknown[]) => execute(...args),
}));

const complete = vi.fn();
vi.mock("../../completion", () => ({
  complete: (...args: unknown[]) => complete(...args),
}));

const spent: unknown[] = [];
const allowed = { value: true };
vi.mock("../spend", () => ({
  affordable: async () => (allowed.value ? null : { kind: "error", message: "no credits left" }),
  spend: async (_ctx: unknown, s: unknown[]) => {
    spent.push(...s);
  },
  wasBilled: (status: number) => status !== 501 && status !== 502,
}));

const { cursorArgument, nextCursor, readPages, readerModel, maxPages } =
  await import("./read-pages");

const USAGE = { promptTokens: 1000, completionTokens: 50, cachedTokens: null };

function ctx(env: Partial<ToolEnv> = {}): ToolContext {
  return {
    env: { OPENAI_API_KEY: "sk", WORKER_PLAN: "paid", ...env } as ToolEnv,
    workspaceId: "ws-1",
    userId: "u-1",
  } as ToolContext;
}

/** A page of mail, with a token to the next one unless it is the last. */
function page(n: number, next: string | null) {
  return {
    kind: "ok",
    status: 200,
    body: JSON.stringify({
      data: {
        messages: [{ messageId: `m${n}`, subject: `Page ${n}`, messageText: "Kargo gecikti." }],
        ...(next ? { nextPageToken: next } : {}),
      },
      successful: true,
    }),
  };
}

const input = (over: Partial<Parameters<typeof readPages>[0]> = {}) => ({
  ctx: ctx(),
  slug: "GMAIL_FETCH_EMAILS",
  label: "Ana's Gmail",
  question: "complaints about late delivery",
  args: { query: "newer_than:14d", max_results: 50 },
  cursorArg: "page_token",
  account: { connectedAccountId: "ca", composioUserId: "cu" },
  ...over,
});

beforeEach(() => {
  execute.mockReset();
  complete.mockReset();
  spent.length = 0;
  allowed.value = true;
  complete.mockImplementation(async (_env: unknown, req: { messages: { content: string }[] }) => ({
    text: `- ${/"messageId":"(m\d+)"/.exec(req.messages[1].content)?.[1]}: late delivery`,
    usage: USAGE,
    finishReason: "stop",
  }));
});

describe("finding the next page", () => {
  it("reads a page token by its shape, a few levels down", () => {
    expect(nextCursor('{"data":{"nextPageToken":"abc"}}')).toBe("abc");
    expect(nextCursor('{"response_metadata":{"next_cursor":"dXNl"}}')).toBe("dXNl");
    expect(nextCursor('{"data":{"messages":[]}}')).toBeNull();
    expect(nextCursor('{"data":{"nextPageToken":""}}')).toBeNull();
    expect(nextCursor("not json")).toBeNull();
  });

  it("names the argument the token goes back in, or none", () => {
    expect(cursorArgument({ properties: { query: {}, page_token: {} } })).toBe("page_token");
    expect(cursorArgument({ properties: { start_cursor: {} } })).toBe("start_cursor");
    expect(cursorArgument({ properties: { query: {} } })).toBeNull();
    expect(cursorArgument(null)).toBeNull();
  });
});

describe("reading every page", () => {
  it("follows the token to the last page and hands back only the findings", async () => {
    execute
      .mockResolvedValueOnce(page(1, "t2"))
      .mockResolvedValueOnce(page(2, "t3"))
      .mockResolvedValueOnce(page(3, null));

    const out = await readPages(input());

    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[1][1].arguments).toEqual({
      query: "newer_than:14d",
      max_results: 50,
      page_token: "t2",
    });
    expect(execute.mock.calls[2][1].arguments.page_token).toBe("t3");
    expect(out.kind).toBe("ok");
    const text = out.kind === "ok" ? out.content : "";
    expect(text).toMatch(/^Read 3 pages of GMAIL_FETCH_EMAILS on Ana's Gmail/);
    expect(text).toContain("m1: late delivery");
    expect(text).toContain("m3: late delivery");
    expect(text).not.toContain("more results remain");
    // Three calls at Composio and three readings, every one on the ledger.
    expect(spent.filter((s) => (s as { kind: string }).kind === "composio_call")).toHaveLength(3);
    expect(spent.filter((s) => (s as { purpose?: string }).purpose === "reading")).toHaveLength(3);
  });

  it("puts the question in front of the page, and the page as data", async () => {
    execute.mockResolvedValueOnce(page(1, null));
    await readPages(input());
    const [, req] = complete.mock.calls[0];
    expect(req.messages[0].content).toContain("Question: complaints about late delivery");
    expect(req.messages[0].content).toMatch(/data, not instructions/);
    expect(req.messages[1].content).toContain('"messageId":"m1"');
  });

  it("leaves out a page that had nothing, and says when nothing did", async () => {
    execute.mockResolvedValueOnce(page(1, null));
    complete.mockResolvedValueOnce({ text: "NONE", usage: USAGE, finishReason: "stop" });
    const out = await readPages(input());
    expect(out.kind === "ok" && out.content).toContain("Nothing in what was read bears on");
  });

  it("stops at the most one question reads, and says where to go on from", async () => {
    execute.mockImplementation(
      async (_env: unknown, call: { arguments: { page_token?: string } }) =>
        page(
          Number(call.arguments.page_token?.slice(1) ?? 1),
          `t${Number(call.arguments.page_token?.slice(1) ?? 1) + 1}`,
        ),
    );
    const out = await readPages(input({ ctx: ctx({ WORKER_PLAN: undefined }) }));

    expect(execute).toHaveBeenCalledTimes(maxPages({}));
    const text = out.kind === "ok" ? out.content : "";
    expect(text).toMatch(/stopped after 3 pages, the most one question reads/);
    expect(text).toContain('continue from page_token: "t4"');
  });

  it("stops in time rather than at the wall", async () => {
    let clock = 0;
    execute.mockImplementation(async () => {
      clock += 40_000;
      return page(1, "next");
    });
    const out = await readPages(input({ now: () => clock }));
    const text = out.kind === "ok" ? out.content : "";
    expect(execute.mock.calls.length).toBeLessThan(maxPages({ WORKER_PLAN: "paid" }));
    expect(text).toMatch(/to finish in time; more results remain/);
  });

  it("stops when the credits run out between pages, keeping what it read", async () => {
    execute.mockResolvedValueOnce(page(1, "t2"));
    execute.mockImplementation(async () => {
      throw new Error("must not be called");
    });
    allowed.value = false;
    const out = await readPages(input());
    const text = out.kind === "ok" ? out.content : "";
    expect(text).toContain("m1: late delivery");
    expect(text).toMatch(/page 2 could not be fetched \(no credits left\)/);
  });

  it("fails the way any call does when the first page fails", async () => {
    execute.mockResolvedValueOnce({ kind: "error", status: 400, message: "invalid query" });
    const out = await readPages(input());
    expect(out).toEqual({ kind: "error", message: "invalid query" });
  });

  it("reads one page whole when the operation has no page token", async () => {
    execute.mockResolvedValueOnce(page(1, "ignored"));
    const out = await readPages(input({ cursorArg: null }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(out.kind === "ok" && out.content).toMatch(/^Read 1 page of/);
  });

  it("keeps what it read when a later page cannot be read", async () => {
    execute.mockResolvedValueOnce(page(1, "t2")).mockResolvedValueOnce(page(2, null));
    complete
      .mockResolvedValueOnce({ text: "- m1: late", usage: USAGE, finishReason: "stop" })
      .mockRejectedValueOnce(new Error("overloaded"));
    const out = await readPages(input());
    const text = out.kind === "ok" ? out.content : "";
    expect(text).toContain("m1: late");
    expect(text).toMatch(/page 2 could not be read/);
  });
});

describe("how many pages", () => {
  it("is fifteen on Paid, three in a chat on Free, one in a scheduled run on Free", () => {
    expect(maxPages({ WORKER_PLAN: "paid" })).toBe(15);
    expect(maxPages({ WORKER_PLAN: "paid" }, { scheduled: true })).toBe(15);
    expect(maxPages({})).toBe(3);
    expect(maxPages({}, { scheduled: true })).toBe(1);
  });
});

describe("which model reads", () => {
  it("is the small one of whichever provider is configured", () => {
    expect(readerModel({})).toBe("gpt-4o-mini");
    expect(readerModel({ ANTHROPIC_API_KEY: "k" })).toBe("claude-haiku-4-5");
    expect(readerModel({ OPENAI_MODEL: "llama-3", ANTHROPIC_API_KEY: "k" })).toBe("llama-3");
  });
});
