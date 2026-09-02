import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec, type QueryContext } from "../test-support/fake-db";
import { chat } from "./chat";

/**
 * What this file is for: the citations under an answer, and what it costs to
 * produce one.
 *
 * The retrieval pieces are unit-tested next door (rag, doc-question, prompt).
 * The bug they were extracted from was not in any of them — it was in how this
 * route wired them together. It cited every candidate rather than every
 * candidate that fitted, and it fell back to reading whole documents on turns
 * that had nothing to do with any document. Both are only visible from here,
 * with a real request going through a real handler.
 */

const USER = { id: "user-1", email: "a@example.com" };
const SESSION = { id: "sess-1", agent_id: "agent-1", kind: "chat" };
const AGENT = { id: "agent-1", persona: "You are our PM.", model: null, mode: "normal" };

const embedTexts = vi.fn();
const completionCreate = vi.fn();
const serviceInsert = vi.fn();

vi.mock("../lib/embeddings", () => ({
  embedTexts: (...args: unknown[]) => embedTexts(...args),
}));

vi.mock("../lib/openai", () => ({
  createOpenAI: () => ({ chat: { completions: { create: completionCreate } } }),
}));

vi.mock("../lib/entitlements/guard", () => ({
  guardQuota: async () => null,
  recordQuota: async () => {},
}));

vi.mock("../lib/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "messages") {
        return {
          insert: (row: Record<string, unknown>) => {
            serviceInsert(row);
            return {
              select: () => ({
                single: async () => ({
                  data: {
                    id: "assistant-1",
                    role: "assistant",
                    content: row.content,
                    created_at: "2026-09-02T10:00:00Z",
                    sources: row.sources,
                  },
                  error: null,
                }),
              }),
            };
          },
        };
      }
      return { update: () => ({ eq: async () => ({ error: null }) }) };
    },
  }),
}));

/** A streamed completion of one delta plus the usage-only final chunk. */
function streamOf(text: string, finishReason = "stop") {
  return {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: text } }] };
      yield { choices: [{ delta: {}, finish_reason: finishReason }] };
      yield {
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: {} },
      };
    },
  };
}

type Doc = { id: string; name: string; content: string | null };
type Match = { document_id: string; document_name: string; content: string };

function appWith(spec: {
  question: string;
  history?: Array<{ role: string; content: string }>;
  documents?: Doc[];
  matches?: Match[];
}) {
  const documents = spec.documents ?? [];
  const rows = [...(spec.history ?? []), { role: "user", content: spec.question }].map((m, i) => ({
    id: `m${i}`,
    role: m.role,
    content: m.content,
    created_at: `2026-09-0${i + 1}T10:00:00Z`,
  }));

  const dbSpec: FakeDbSpec = {
    tables: {
      chat_sessions: { select: () => ({ data: SESSION, error: null }) },
      agents: { select: () => ({ data: AGENT, error: null }) },
      // The route reads newest-first and reverses, so hand it back reversed.
      messages: { select: () => ({ data: [...rows].reverse(), error: null }) },
      agent_bundles: {
        select: () => ({
          data: documents.length > 0 ? [{ bundle_id: "bundle-1" }] : [],
          error: null,
        }),
      },
      documents: {
        select: (ctx: QueryContext) => ({
          data: ctx.columns?.includes("content")
            ? documents
            : documents.map((d) => ({ name: d.name })),
          error: null,
        }),
      },
    },
    rpc: {
      match_chunks: () => ({ data: spec.matches ?? [], error: null }),
    },
  };

  const { db, calls } = fakeDb(dbSpec);

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", chat);
  return { app, calls };
}

async function ask(app: Hono<AppEnv>) {
  const res = await app.request(
    "/chat/stream",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: SESSION.id }),
    },
    {} as never,
  );
  return { status: res.status, body: await res.text() };
}

/** The messages the model was actually sent, by role. */
function sentMessages(): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return completionCreate.mock.calls[0][0].messages;
}

function knowledgeBlock(): string | undefined {
  return sentMessages()
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .find((c) => c.startsWith("The team has shared the following knowledge"));
}

/** The value 0039 stores alongside the reply. */
function grounding(): string | undefined {
  return serviceInsert.mock.calls[0]?.[0]?.grounding as string | undefined;
}

function citedNames(): string[] {
  const sources = serviceInsert.mock.calls[0]?.[0]?.sources as
    Array<{ name: string }> | null | undefined;
  return (sources ?? []).map((s) => s.name);
}

beforeEach(() => {
  vi.clearAllMocks();
  embedTexts.mockResolvedValue({ vectors: [[0.1, 0.2]], tokens: 8 });
  completionCreate.mockResolvedValue(streamOf("Twenty days."));
});

const HANDBOOK: Doc = { id: "d1", name: "handbook.md", content: "Vacation is 20 days." };
const PAYROLL: Doc = { id: "d2", name: "payroll.md", content: "Paid on the 15th." };

describe("citations", () => {
  it("cites the documents a retrieved passage came from", async () => {
    const { app } = appWith({
      question: "How many vacation days do I get?",
      documents: [HANDBOOK, PAYROLL],
      matches: [
        { document_id: "d1", document_name: "handbook.md", content: "Vacation is 20 days." },
      ],
    });
    const res = await ask(app);
    expect(res.status).toBe(200);
    expect(citedNames()).toEqual(["handbook.md"]);
  });

  it("cites one document once, however many of its passages matched", async () => {
    const { app } = appWith({
      question: "How many vacation days do I get?",
      documents: [HANDBOOK],
      matches: [
        { document_id: "d1", document_name: "handbook.md", content: "Vacation is 20 days." },
        { document_id: "d1", document_name: "handbook.md", content: "Accrued monthly." },
      ],
    });
    await ask(app);
    expect(citedNames()).toEqual(["handbook.md"]);
  });

  it("does not cite a passage the char budget dropped", async () => {
    // The narrower half of the same bug as the one below: six chunks come back,
    // the block only has room for the first, and all six were being recorded as
    // having grounded the answer.
    const big = "x".repeat(4000);
    const { app } = appWith({
      question: "How many vacation days do I get?",
      documents: [HANDBOOK, PAYROLL],
      matches: [
        { document_id: "d1", document_name: "handbook.md", content: big },
        { document_id: "d2", document_name: "payroll.md", content: big },
      ],
    });
    await ask(app);
    expect(citedNames()).toEqual(["handbook.md"]);
  });

  it("cites nothing when nothing grounded the answer", async () => {
    const { app } = appWith({
      question: "write me a limerick",
      documents: [HANDBOOK, PAYROLL],
      matches: [],
    });
    await ask(app);
    expect(citedNames()).toEqual([]);
    expect(serviceInsert.mock.calls[0][0].sources).toBeNull();
  });
});

describe("the no-match fallback", () => {
  it("reads the documents when the question is about them", async () => {
    const { app } = appWith({
      question: "Can you summarize the file for me?",
      documents: [HANDBOOK],
      matches: [],
    });
    await ask(app);
    expect(knowledgeBlock()).toContain("Vacation is 20 days.");
    expect(citedNames()).toEqual(["handbook.md"]);
  });

  it("stays out of the way when the question is not", async () => {
    // Every miss used to land in the fallback: "thanks" pulled the agent's
    // whole library into the prompt, paid for it, and hung a row of source
    // chips under a reply that came from the persona alone.
    const { app } = appWith({
      question: "thanks, that's all",
      documents: [HANDBOOK, PAYROLL],
      matches: [],
    });
    await ask(app);
    expect(knowledgeBlock()).toBeUndefined();
    expect(citedNames()).toEqual([]);
  });

  it("puts the document the question names first, not the newest one", async () => {
    // The budget fills from the front. Newest-first is the right default and
    // the wrong answer when someone asks about a file by name.
    const filler = { id: "d9", name: "notes.md", content: "y".repeat(4000) };
    const { app } = appWith({
      question: "what does handbook.md say?",
      documents: [filler, HANDBOOK],
      matches: [],
    });
    await ask(app);
    expect(knowledgeBlock()).toContain("Vacation is 20 days.");
    expect(citedNames()[0]).toBe("handbook.md");
  });

  it("is never reached when the agent has no documents at all", async () => {
    const { app } = appWith({ question: "summarize the file", documents: [], matches: [] });
    await ask(app);
    expect(knowledgeBlock()).toBeUndefined();
    expect(embedTexts).not.toHaveBeenCalled();
  });
});

describe("what gets embedded", () => {
  it("embeds a self-contained question on its own", async () => {
    const question = "What does the handbook say about parental leave in Istanbul?";
    const { app } = appWith({ question, documents: [HANDBOOK] });
    await ask(app);
    expect(embedTexts.mock.calls[0][1]).toEqual([question]);
  });

  it("carries the previous question into a follow-up", async () => {
    const { app } = appWith({
      question: "peki ikinci maddesi?",
      history: [
        { role: "user", content: "Summarize the vacation policy in handbook.md" },
        { role: "assistant", content: "Twenty days, accrued monthly." },
      ],
      documents: [HANDBOOK],
    });
    await ask(app);
    const [embedded] = embedTexts.mock.calls[0][1];
    expect(embedded).toContain("handbook.md");
    expect(embedded).toContain("peki ikinci maddesi?");
  });
});

describe("what grounded the reply (0039)", () => {
  it("records a matched passage as chunks", async () => {
    const { app } = appWith({
      question: "How many vacation days do I get?",
      documents: [HANDBOOK],
      matches: [
        { document_id: "d1", document_name: "handbook.md", content: "Vacation is 20 days." },
      ],
    });
    await ask(app);
    expect(grounding()).toBe("chunks");
  });

  it("records the fallback as documents", async () => {
    const { app } = appWith({
      question: "summarize the file",
      documents: [HANDBOOK],
      matches: [],
    });
    await ask(app);
    expect(grounding()).toBe("documents");
  });

  it("records a question nothing was close to as none", async () => {
    // The value this column exists to count, and the one it was getting wrong:
    // the fallback ran on every miss, so a turn like this was stored as
    // `documents` — grounded, by a path that had fired on a question about
    // nothing.
    const { app } = appWith({
      question: "write me a limerick",
      documents: [HANDBOOK],
      matches: [],
    });
    await ask(app);
    expect(grounding()).toBe("none");
  });

  it("records none when the agent has nothing to be close with", async () => {
    const { app } = appWith({ question: "summarize the file", documents: [] });
    await ask(app);
    expect(grounding()).toBe("none");
  });
});

describe("a reply that ran out of room", () => {
  it("says so, ahead of the terminal event", async () => {
    // A reply cut off at `maxTokensFor` stops mid-thought and otherwise looks
    // finished. Nothing on screen said the end was missing.
    completionCreate.mockResolvedValue(streamOf("A long list that stops at 3.", "length"));
    const { app } = appWith({ question: "list every public holiday" });
    const { body } = await ask(app);
    expect(body).toContain('data: {"type":"truncated"}');
    expect(body.indexOf('"truncated"')).toBeLessThan(body.indexOf('"done"'));
  });

  it("stays quiet when the model simply finished", async () => {
    const { app } = appWith({ question: "hello" });
    const { body } = await ask(app);
    expect(body).not.toContain("truncated");
  });
});

describe("the assembled prompt", () => {
  it("keeps retrieved knowledge out of the cacheable prefix", async () => {
    const { app } = appWith({
      question: "How many vacation days do I get?",
      documents: [HANDBOOK],
      matches: [
        { document_id: "d1", document_name: "handbook.md", content: "Vacation is 20 days." },
      ],
    });
    await ask(app);
    const sent = sentMessages();
    // The persona prefix comes first and must not carry the volatile block;
    // the block rides immediately before the question it grounds.
    expect(sent[0].role).toBe("system");
    expect(sent[0].content).not.toContain("Vacation is 20 days.");
    expect(sent[sent.length - 2].content).toContain("Vacation is 20 days.");
    expect(sent[sent.length - 1].content).toBe("How many vacation days do I get?");
  });

  it("names the agent's documents whether or not anything was retrieved", async () => {
    const { app } = appWith({ question: "hello", documents: [HANDBOOK], matches: [] });
    await ask(app);
    expect(sentMessages()[0].content).toContain("handbook.md");
  });
});
