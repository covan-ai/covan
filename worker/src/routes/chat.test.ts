import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec, type QueryContext } from "../test-support/fake-db";
import { searchTerms } from "../lib/search-terms";
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
const SESSION = { id: "sess-1", agent_id: "agent-1", kind: "chat", workspace_id: "ws-1" };
const AGENT = { id: "agent-1", persona: "You are our PM.", model: null, mode: "normal" };

const embedTexts = vi.fn();
const completionCreate = vi.fn();
/**
 * The Anthropic Messages API call, mocked for the same reason `createOpenAI`
 * is below: without this, a test that puts the agent on a Claude model that
 * survives `resolveModel` (Task 9's "the workspace has an Anthropic key too"
 * case) would reach the real `@anthropic-ai/sdk` client and make an actual
 * HTTPS request to api.anthropic.com — slow, dependent on network access this
 * suite has no business needing, and answered with a 401 for the fake key
 * either way. Every other test in this file never resolves to a Claude model,
 * so this mock sits unused for them.
 */
const anthropicCreate = vi.fn();
const serviceInsert = vi.fn();
const stepsWritten = vi.fn();
const pausedWritten = vi.fn();
const serviceUpdate = vi.fn();
const sessionUpdate = vi.fn();
/** The OPENAI_API_KEY every `createOpenAI(env)` call was actually made with. */
const createOpenAIKeys: Array<string | undefined> = [];

vi.mock("../lib/embeddings", () => ({
  embedTexts: (...args: unknown[]) => embedTexts(...args),
}));

vi.mock("../lib/openai", () => ({
  createOpenAI: (env: { OPENAI_API_KEY?: string }) => {
    createOpenAIKeys.push(env.OPENAI_API_KEY);
    return { chat: { completions: { create: completionCreate } } };
  },
}));

vi.mock("../lib/anthropic", () => ({
  createAnthropic: () => ({ messages: { create: anthropicCreate } }),
}));

vi.mock("../lib/entitlements/guard", () => ({
  guardQuota: async () => null,
  recordQuota: async () => {},
}));

vi.mock("../lib/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "messages") {
        const answered = (row: Record<string, unknown>, id: string) => ({
          select: () => ({
            single: async () => ({
              data: {
                id,
                role: "assistant",
                content: row.content,
                created_at: "2026-09-02T10:00:00Z",
                sources: row.sources,
              },
              error: null,
            }),
          }),
        });
        return {
          insert: (row: Record<string, unknown>) => {
            serviceInsert(row);
            return answered(row, "assistant-1");
          },
          // A continuation writes into the reply it finishes rather than
          // beside it, so this is the other half of the same path.
          update: (row: Record<string, unknown>) => ({
            eq: (_column: string, id: string) => {
              serviceUpdate({ id, ...row });
              return answered(row, id);
            },
          }),
        };
      }
      // What a reply did, written once the row it belongs to exists. An
      // upsert, because a resumed turn writes the same step index again with
      // the status it ended up having.
      if (table === "message_steps") {
        return {
          upsert: (rows: Array<Record<string, unknown>>) => {
            stepsWritten(rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      // A turn parked waiting for somebody. Returns the id the confirm event
      // carries.
      if (table === "paused_turns") {
        return {
          insert: (row: Record<string, unknown>) => {
            pausedWritten(row);
            return {
              select: () => ({ single: async () => ({ data: { id: "paused-1" }, error: null }) }),
            };
          },
        };
      }
      // chat_sessions, which the route touches twice: the `updated_at` bump
      // ends at `.eq()`, and the generated title adds `.is("title", null)`
      // after it so it cannot overwrite a name the user chose mid-stream.
      return {
        update: (row: Record<string, unknown>) => {
          sessionUpdate(row);
          const settled = Object.assign(Promise.resolve({ error: null }), {
            is: async () => ({ error: null }),
          });
          return { eq: () => settled };
        },
      };
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

/**
 * An Anthropic Messages stream shaped the way `lib/completion.ts` reads it —
 * only used by the one Task 9 test that resolves to a Claude model with a key
 * present, where the reply itself is incidental to what's being checked.
 */
function anthropicStreamOf(text: string) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "message_start", message: { usage: { input_tokens: 50 } } };
      yield { type: "content_block_delta", delta: { type: "text_delta", text } };
      yield {
        type: "message_delta",
        usage: { output_tokens: 10 },
        delta: { stop_reason: "end_turn" },
      };
    },
  };
}

/** The unstreamed JSON reply the titler asks for. */
function titleOf(title: string) {
  return {
    choices: [{ message: { content: JSON.stringify({ title }) } }],
    usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: {} },
  };
}

/**
 * Answer both completions a turn makes — the streamed reply and, for an
 * untitled session, the titling call — from the one mocked client, dispatching
 * on `stream` the way the two are actually told apart.
 */
function answersWith(reply: ReturnType<typeof streamOf>, title = "Vacation days") {
  completionCreate.mockImplementation(async (body: { stream?: boolean }) =>
    body.stream ? reply : titleOf(title),
  );
}

type Doc = { id: string; name: string; content: string | null };
type Match = { document_id: string; document_name: string; content: string };

function appWith(spec: {
  question: string;
  history?: Array<{ role: string; content: string }>;
  documents?: Doc[];
  matches?: Match[];
  /** The name the session already has. Null — the default — is a new chat. */
  sessionTitle?: string | null;
  /**
   * Stands in for what the real `guardQuota` sets on `c` when a workspace key
   * is carrying the caller past their allowance. `guardQuota` itself is mocked
   * out above (this file is not about quota), so this is how a test reaches
   * the one seam Task 6 actually owns: whether the route reads `providerEnv`
   * off the context and passes it to every provider call.
   *
   * Typed as a partial `Bindings` rather than just the OpenAI key so Task 9's
   * tests can say whether the workspace's overlay also carries an Anthropic
   * key — that presence or absence is the whole of what `resolveModel` reads
   * to decide whether a Claude pick survives.
   */
  providerEnv?: { OPENAI_API_KEY: string; ANTHROPIC_API_KEY?: string; RAG_LEXICAL?: string };
  /** The agent's stored model. Defaults to `AGENT.model` (null → the default). */
  agentModel?: string | null;
  /** The agent's own tuning (0048). Undefined leaves both on Auto. */
  agentTuning?: { temperature?: number | null; reasoning_effort?: string | null };
  /**
   * A reply already sitting at the end of the conversation, stopped at its
   * length cap. What "continue" has to work from.
   */
  cutOffReply?: string;
  /** Rows standing in for `tool_connections` in this workspace. */
  connections?: Array<Record<string, unknown>>;
  /** Rows standing in for this person's `delivery_channels`. */
  channels?: Array<Record<string, unknown>>;
}) {
  const documents = spec.documents ?? [];
  const rows = [
    ...(spec.history ?? []),
    { role: "user", content: spec.question },
    ...(spec.cutOffReply ? [{ role: "assistant", content: spec.cutOffReply }] : []),
  ].map((m, i) => ({
    id: `m${i}`,
    role: m.role,
    content: m.content,
    created_at: `2026-09-0${i + 1}T10:00:00Z`,
    // What the first half of a cut-off reply cost, so a continuation can be
    // checked for adding to it rather than overwriting it.
    ...(m.role === "assistant"
      ? { prompt_tokens: 400, completion_tokens: 1536, cached_tokens: 0 }
      : {}),
  }));

  const agent = {
    ...AGENT,
    ...(spec.agentModel !== undefined ? { model: spec.agentModel } : {}),
    ...(spec.agentTuning ?? {}),
  };

  // `fakeDb`'s own `calls` array only records table operations, not RPCs (see
  // its `rpc()` implementation) — so a signature change to the `match_chunks`
  // call would sail through unnoticed unless something here captures the args
  // itself, inside the handler below.
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

  const dbSpec: FakeDbSpec = {
    tables: {
      chat_sessions: {
        select: () => ({ data: { ...SESSION, title: spec.sessionTitle ?? null }, error: null }),
      },
      agents: { select: () => ({ data: agent, error: null }) },
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
      // What the agent can reach, which the route now reads before it builds
      // the prompt. Empty in every test here but the ones about tools: a
      // workspace with no connected service and no delivery channel is
      // offered neither the tools that would point at one nor the manifest
      // naming them, which is what keeps these assertions about retrieval.
      tool_connections: { select: () => ({ data: spec.connections ?? [], error: null }) },
      delivery_channels: { select: () => ({ data: spec.channels ?? [], error: null }) },
    },
    rpc: {
      match_chunks: (args: Record<string, unknown>) => {
        rpcCalls.push({ name: "match_chunks", args });
        return { data: spec.matches ?? [], error: null };
      },
    },
  };

  const { db, calls } = fakeDb(dbSpec);

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    if (spec.providerEnv) c.set("providerEnv", spec.providerEnv as never);
    await next();
  });
  app.route("/", chat);
  return { app, calls, rpcCalls };
}

/**
 * The bindings a request arrives with.
 *
 * Two of them decide whether a tool is offered at all: `ALLOWED_ORIGIN` is
 * what the SSRF guard checks a connection against, and `ROUTINE_SECRET_KEY`
 * is what opens its credential. A deployment missing either cannot run the
 * tools that reach outside, and `isConfigured` says so rather than offering
 * one that would fail — so these have to be here for the tool tests below to
 * be testing what they say they are.
 */
const ENV = { ALLOWED_ORIGIN: "https://app.covan.test", ROUTINE_SECRET_KEY: "k" };

async function post(app: Hono<AppEnv>, body: Record<string, unknown>) {
  const res = await app.request(
    "/chat/stream",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    ENV as never,
  );
  return { status: res.status, body: await res.text() };
}

const ask = (app: Hono<AppEnv>) => post(app, { sessionId: SESSION.id });
const carryOn = (app: Hono<AppEnv>) => post(app, { sessionId: SESSION.id, continue: true });
const again = (app: Hono<AppEnv>, model?: string) =>
  post(app, { sessionId: SESSION.id, regenerate: true, ...(model ? { model } : {}) });

/**
 * The messages the model was actually sent for the REPLY, by role.
 *
 * A turn makes more than one completion now: an untitled session is also named
 * from its opening message, and that call is not streamed. Selecting on
 * `stream` rather than taking the first call means these assertions keep
 * pointing at the answer whichever of the two the mock happened to record
 * first.
 */
function sentMessages(): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const reply = completionCreate.mock.calls.find((c) => c[0].stream);
  return reply![0].messages;
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
  createOpenAIKeys.length = 0;
  embedTexts.mockResolvedValue({ vectors: [[0.1, 0.2]], tokens: 8 });
  answersWith(streamOf("Twenty days."));
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

  it("reaches a document that has no chunks when the question names it", async () => {
    // Reported from production: a report written by the agent, asked about by
    // name, and answered with "the excerpt did not come".
    //
    // A report is stored with no embeddings on purpose, so no passage of it can
    // ever match — the stored-text fallback was supposed to be how it is read.
    // But the fallback only runs when retrieval found *nothing*, and an agent
    // that has a report also has the documents the report was written from. One
    // of those matches, `ragBlock` is no longer empty, and the document the
    // question actually named is the one thing that cannot get in.
    const REPORT = { id: "d3", name: "Yönetim Özeti.md", content: "Revenue rose 12% in Q3." };
    const { app } = appWith({
      question: "Yönetim Özeti raporunda ne yazıyor?",
      documents: [REPORT, HANDBOOK],
      matches: [
        { document_id: "d1", document_name: "handbook.md", content: "Vacation is 20 days." },
      ],
    });
    await ask(app);
    expect(knowledgeBlock()).toContain("Revenue rose 12% in Q3.");
  });

  it("adds only the named document, not the rest of the library", async () => {
    // The reason this branch has a guard at all. Once a passage has matched, the
    // other documents are not more relevant than it is, and admitting them here
    // would be the dump-the-newest-few-thousand-characters behaviour the guard
    // exists to prevent — paid for, and hung with source chips it did not earn.
    const REPORT = { id: "d3", name: "Yönetim Özeti.md", content: "Revenue rose 12% in Q3." };
    const { app } = appWith({
      question: "Yönetim Özeti raporunda ne yazıyor?",
      documents: [REPORT, HANDBOOK, PAYROLL],
      matches: [
        { document_id: "d1", document_name: "handbook.md", content: "Vacation is 20 days." },
      ],
    });
    await ask(app);
    expect(knowledgeBlock()).toContain("Revenue rose 12% in Q3.");
    expect(knowledgeBlock()).not.toContain("Paid on the 15th.");
  });

  it("caps the named document so the passages behind it still fit", async () => {
    // The budget fills from the front and breaks out when the room runs low, so
    // an uncapped 8000-character document placed first would be the whole block
    // and every matched passage would be dropped behind it.
    const LONG = { id: "d3", name: "Yönetim Özeti.md", content: "R".repeat(8000) };
    const { app } = appWith({
      question: "Yönetim Özeti raporunda ne yazıyor?",
      documents: [LONG, HANDBOOK],
      matches: [
        { document_id: "d1", document_name: "handbook.md", content: "Vacation is 20 days." },
      ],
    });
    await ask(app);
    expect(knowledgeBlock()).toContain("Vacation is 20 days.");
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

describe("the lexical arm (Task 5)", () => {
  it("passes the same query's search terms as p_query_terms", async () => {
    const question = "What does the handbook say about parental leave in Istanbul?";
    const { app, rpcCalls } = appWith({ question, documents: [HANDBOOK] });
    await ask(app);

    const match = rpcCalls.find((c) => c.name === "match_chunks");
    expect(match?.args.p_query_terms).toEqual(searchTerms(question));
  });

  it("turns the lexical arm off when RAG_LEXICAL is off", async () => {
    const question = "What does the handbook say about parental leave in Istanbul?";
    const { app, rpcCalls } = appWith({
      question,
      documents: [HANDBOOK],
      providerEnv: { OPENAI_API_KEY: "ws-openai", RAG_LEXICAL: "off" },
    });
    await ask(app);

    const match = rpcCalls.find((c) => c.name === "match_chunks");
    expect(match?.args.p_query_terms).toEqual([]);
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

  it("still records chunks when a named document rode in beside a match", async () => {
    // `chunks` answers "did a passage actually match this question". One did,
    // whatever else was admitted alongside it, so the mixed case is not a
    // separate value — covan#44 reads the column that way.
    const REPORT = { id: "d3", name: "Yönetim Özeti.md", content: "Revenue rose 12% in Q3." };
    const { app } = appWith({
      question: "Yönetim Özeti raporunda ne yazıyor?",
      documents: [REPORT, HANDBOOK],
      matches: [
        { document_id: "d1", document_name: "handbook.md", content: "Vacation is 20 days." },
      ],
    });
    await ask(app);
    expect(grounding()).toBe("chunks");
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
    answersWith(streamOf("A long list that stops at 3.", "length"));
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

describe("whose key answers (Task 6)", () => {
  it("completes on the workspace key once guardQuota has set one", async () => {
    const { app } = appWith({
      question: "How many vacation days do I get?",
      providerEnv: { OPENAI_API_KEY: "ws-openai" },
    });

    const res = await ask(app);

    expect(res.status).toBe(200);
    expect(createOpenAIKeys.length).toBeGreaterThan(0);
    expect(createOpenAIKeys.every((k) => k === "ws-openai")).toBe(true);
  });

  it("completes on the operator's key when guardQuota set nothing", async () => {
    const { app } = appWith({ question: "How many vacation days do I get?" });

    await ask(app);

    // `every` over an empty array is `true`, so without this the assertion
    // below would go on passing if the route stopped calling the provider at
    // all — which is the failure it is here to catch, not one to shrug at. Its
    // sibling above already guards the same way.
    expect(createOpenAIKeys.length).toBeGreaterThan(0);
    // `c.env` carries no OPENAI_API_KEY in this fixture; the point is only that
    // it is what answered, not the overlay's.
    expect(createOpenAIKeys.every((k) => k === undefined)).toBe(true);
  });
});

describe("saying so when a Claude pick is dropped (Task 9)", () => {
  // `resolveModel` (lib/models.ts) already drops a keyless Claude pick to the
  // default, silently — that fallback is correct and pre-existing, and none
  // of these tests touch it. What they cover is the one line that announces
  // it: a `notice` event, at most once per reply, and only when all three of
  // "running on a workspace key", "the agent asked for Claude" and "the
  // answer came from somewhere else" are true at once.
  it("says so when a Claude agent falls back under a workspace key", async () => {
    const { app } = appWith({
      question: "How many vacation days do I get?",
      agentModel: "claude-sonnet-4-6",
      // The workspace's overlay carries an OpenAI key but no Anthropic one —
      // exactly the gap `resolveModel` falls through on.
      providerEnv: { OPENAI_API_KEY: "ws-openai" },
    });

    const { body } = await ask(app);

    expect(body).toContain('"type":"notice"');
    expect(body).toMatch(/gpt-4\.1/);
  });

  it("says nothing when the workspace has an Anthropic key too", async () => {
    // With both halves of the overlay set, `resolveModel` keeps the Claude
    // pick and the reply is actually served by the (mocked) Anthropic client
    // — the one case in this file that reaches it. `sessionTitle` is set so
    // the titling call, which would otherwise also go through that client,
    // never fires; it has nothing to do with what this test is checking.
    anthropicCreate.mockResolvedValue(anthropicStreamOf("Twenty days."));
    const { app } = appWith({
      question: "How many vacation days do I get?",
      agentModel: "claude-sonnet-4-6",
      sessionTitle: "Already named",
      providerEnv: { OPENAI_API_KEY: "ws-openai", ANTHROPIC_API_KEY: "ws-anthropic" },
    });

    const { body } = await ask(app);

    expect(body).not.toContain('"type":"notice"');
    expect(body).toContain("Twenty days.");
  });

  it("says nothing on the operator's keys", async () => {
    // No `providerEnv` at all — the same shape as every ordinary reply, on
    // whichever keys the operator configured. `c.get("providerEnv")` being
    // unset is on its own enough to keep this silent, whatever the agent's
    // model is or however it would have resolved.
    const { app } = appWith({
      question: "How many vacation days do I get?",
      agentModel: "claude-sonnet-4-6",
    });

    const { body } = await ask(app);

    expect(body).not.toContain('"type":"notice"');
  });

  it("says nothing when the agent was never on Claude", async () => {
    const { app } = appWith({
      question: "How many vacation days do I get?",
      agentModel: "gpt-4o-mini",
      providerEnv: { OPENAI_API_KEY: "ws-openai" },
    });

    const { body } = await ask(app);

    expect(body).not.toContain('"type":"notice"');
  });
});

describe("the agent's own tuning", () => {
  const requestBody = () => completionCreate.mock.calls.find((c) => c[0].stream)![0];

  it("sends the temperature the agent was given", async () => {
    const { app } = appWith({ question: "Hi", agentTuning: { temperature: 0.2 } });

    await ask(app);

    expect(requestBody().temperature).toBe(0.2);
  });

  it("sends 0, which is a setting and not an absence", async () => {
    const { app } = appWith({ question: "Hi", agentTuning: { temperature: 0 } });

    await ask(app);

    expect(requestBody().temperature).toBe(0);
  });

  it("leaves the mode in charge when the agent is on Auto", async () => {
    // Every agent is on Auto until somebody moves the dial, so this is the
    // behaviour of the whole product and it must be the behaviour it had before
    // the column existed: normal chat sends no temperature at all.
    const { app } = appWith({ question: "Hi" });

    await ask(app);

    expect(requestBody()).not.toHaveProperty("temperature");
    expect(requestBody()).not.toHaveProperty("reasoning_effort");
  });

  it("asks a reasoning model for the effort the agent named", async () => {
    const { app } = appWith({
      question: "Hi",
      agentModel: "gpt-5-mini",
      agentTuning: { reasoning_effort: "high" },
    });

    await ask(app);

    expect(requestBody().reasoning_effort).toBe("high");
  });

  it("says nothing about reasoning to a model that does not reason", async () => {
    const { app } = appWith({
      question: "Hi",
      agentModel: "gpt-4o",
      agentTuning: { reasoning_effort: "high" },
    });

    await ask(app);

    expect(requestBody()).not.toHaveProperty("reasoning_effort");
  });
});

describe("naming the conversation", () => {
  /** What the route wrote to chat_sessions.title, if anything. */
  const writtenTitle = () =>
    sessionUpdate.mock.calls.map((c) => c[0]).find((row) => "title" in row)?.title;

  it("names a session that has no name yet", async () => {
    const { app } = appWith({ question: "How many vacation days do I get?" });

    await ask(app);

    expect(writtenTitle()).toBe("Vacation days");
  });

  it("names it from the message that opened the conversation", async () => {
    const { app } = appWith({ question: "How many vacation days do I get?" });

    await ask(app);

    const titling = completionCreate.mock.calls.find((c) => !c[0].stream);
    const sent = titling![0].messages.map((m: { content: string }) => m.content).join("\n");
    expect(sent).toContain("How many vacation days do I get?");
  });

  it("names it on the cheap model, not on the one answering", async () => {
    // Five words of title on a flagship model, once per new chat, forever. The
    // reply keeps the agent's model; only the label moves.
    const { app } = appWith({ question: "How many vacation days do I get?" });

    await ask(app);

    const titling = completionCreate.mock.calls.find((c) => !c[0].stream);
    const answering = completionCreate.mock.calls.find((c) => c[0].stream);
    expect(titling![0].model).toBe("gpt-4o-mini");
    expect(answering![0].model).toBe("gpt-4.1");
  });

  // Renaming on every turn would cost money and move a label out from under
  // somebody reading it.
  it("leaves a session that already has a name alone", async () => {
    const { app } = appWith({
      question: "And what about sick days?",
      sessionTitle: "Q3 pricing review",
    });

    await ask(app);

    expect(writtenTitle()).toBeUndefined();
    // No titling call — follow-up suggestions may still fire.
    const titlingCalls = completionCreate.mock.calls.filter(
      (c) =>
        !c[0].stream &&
        c[0].messages?.some((m: { content: string }) => m.content.includes("name conversations")),
    );
    expect(titlingCalls).toHaveLength(0);
  });

  // A name is a convenience riding along with an answer somebody asked for.
  it("still answers when the naming call fails", async () => {
    const { app } = appWith({ question: "How many vacation days do I get?" });
    completionCreate.mockImplementation(async (body: { stream?: boolean }) => {
      if (!body.stream) throw new Error("the provider is down");
      return streamOf("Twenty days.");
    });

    const res = await ask(app);

    expect(res.status).toBe(200);
    expect(res.body).toContain("Twenty days.");
    expect(writtenTitle()).toBeUndefined();
  });
});

describe("finishing a reply that stopped mid-sentence", () => {
  const CUT_OFF = "Vacation is twenty days, and the carry-over rule is";

  it("asks for the rest in words, and never ends on the model's own turn", async () => {
    // The obvious shape is to end the list with the half-written answer and
    // let the model run on from it. That is a prefill, and it is a 400 on
    // every Claude model from 4.6 onward — so the ask is a short user turn.
    const { app } = appWith({ question: "How many vacation days?", cutOffReply: CUT_OFF });

    await carryOn(app);

    const sent = sentMessages();
    const last = sent[sent.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toMatch(/cut off at its length limit/);
    // And the half it is finishing is there for it to read.
    expect(sent.some((m) => m.role === "assistant" && m.content === CUT_OFF)).toBe(true);
  });

  it("writes the rest into the reply it finishes, not beside it", async () => {
    // Two assistant messages where the model wrote one answer is not a
    // transcript — and the next turn would send the halves as separate turns,
    // which is not what it said.
    const { app } = appWith({ question: "How many vacation days?", cutOffReply: CUT_OFF });

    await carryOn(app);

    expect(serviceInsert).not.toHaveBeenCalled();
    const written = serviceUpdate.mock.calls[0][0];
    expect(written.id).toBe("m1");
    expect(written.content).toBe(`${CUT_OFF}Twenty days.`);
  });

  it("adds what the second half cost to what the first half cost", async () => {
    const { app } = appWith({ question: "How many vacation days?", cutOffReply: CUT_OFF });

    await carryOn(app);

    const written = serviceUpdate.mock.calls[0][0];
    expect(written.prompt_tokens).toBe(400 + 100);
    expect(written.completion_tokens).toBe(1536 + 20);
  });

  it("grounds the second half in the question, not in the half-answer", async () => {
    const { app } = appWith({
      question: "How many vacation days?",
      cutOffReply: CUT_OFF,
      documents: [HANDBOOK],
    });

    await carryOn(app);

    expect(embedTexts).toHaveBeenCalled();
    const embedded = embedTexts.mock.calls[0][1] as string[];
    expect(embedded.join(" ")).toMatch(/vacation days/i);
  });

  it("refuses when the conversation ends on a question", async () => {
    // Nothing to carry on from. The ordinary path answers that.
    const { app } = appWith({ question: "How many vacation days?" });

    const res = await carryOn(app);

    expect(res.status).toBe(400);
    expect(res.body).toMatch(/nothing to continue/);
  });
});

describe("answering the same question again", () => {
  const FIRST_ANSWER = "Twenty days, I think.";

  it("keeps the answer it replaces instead of deleting it", async () => {
    // What regenerate used to be: the reply went, the question was re-asked,
    // and there was no way back — so the button really asked "are you sure the
    // next answer will be better", which nobody can know before seeing it.
    const { app } = appWith({ question: "How many vacation days?", cutOffReply: FIRST_ANSWER });

    await again(app);

    expect(serviceUpdate.mock.calls[0][0]).toMatchObject({ id: "m1" });
    expect(serviceUpdate.mock.calls[0][0].superseded_at).toEqual(expect.any(String));
    // And the new one joins the chain rather than starting its own.
    expect(serviceInsert.mock.calls[0][0]).toMatchObject({ original_message_id: "m1" });
  });

  it("does not show the model the answer it is replacing", async () => {
    // Left in front of it, the model reads its own previous reply and writes a
    // variation on it rather than a second attempt at the question.
    const { app } = appWith({ question: "How many vacation days?", cutOffReply: FIRST_ANSWER });

    await again(app);

    expect(sentMessages().some((m) => m.content === FIRST_ANSWER)).toBe(false);
  });

  it("answers on another model for one reply, without moving the agent to it", async () => {
    const { app } = appWith({
      question: "How many vacation days?",
      cutOffReply: FIRST_ANSWER,
      agentModel: "gpt-4o",
    });

    await again(app, "gpt-4.1-mini");

    const reply = completionCreate.mock.calls.find((call) => call[0].stream);
    expect(reply![0].model).toBe("gpt-4.1-mini");
    // Nothing was written to the agent — the override lives in the request.
    expect(serviceUpdate.mock.calls.every((call) => "superseded_at" in call[0])).toBe(true);
  });

  it("ignores a model this deployment does not serve", async () => {
    // The same answer `resolveModel` already gives an agent whose model had its
    // key rotated out: fall back rather than fail the reply.
    const { app } = appWith({
      question: "How many vacation days?",
      cutOffReply: FIRST_ANSWER,
      agentModel: "gpt-4o",
    });

    await again(app, "some-model-nobody-has");

    const reply = completionCreate.mock.calls.find((call) => call[0].stream);
    expect(reply![0].model).toBe("gpt-4o");
  });

  it("refuses when the conversation ends on a question", async () => {
    const { app } = appWith({ question: "How many vacation days?" });

    const res = await again(app);

    expect(res.status).toBe(400);
    expect(res.body).toMatch(/nothing to regenerate/);
  });
});

/**
 * The harness, from the route's side.
 *
 * What is under test here is the wire: which events come out, in which order,
 * and what gets written down. The loop itself is proved next door in
 * `lib/harness/loop.test.ts`, and the tools in their own files — re-proving
 * either through an HTTP request would be slower and would fail in a less
 * useful place.
 */

/** An OpenAI stream that asks for a tool and then, on the next call, answers. */
function toolThenAnswer(toolName: string, args: string, answer: string) {
  let asked = false;
  return async (body: { stream?: boolean }) => {
    if (!body.stream) return titleOf("A question");
    if (asked) return streamOf(answer);
    asked = true;
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, id: "call_1", function: { name: toolName, arguments: args } },
                ],
              },
            },
          ],
        };
        yield { choices: [{ delta: {}, finish_reason: "tool_calls" }] };
        yield {
          choices: [],
          usage: { prompt_tokens: 40, completion_tokens: 8, prompt_tokens_details: {} },
        };
      },
    };
  };
}

/** The SSE frames, parsed, in the order they were written. */
function frames(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Record<string, unknown>);
}

describe("a reply that used a tool", () => {
  it("sends the steps before the answer, and one `done` at the end", async () => {
    const { app } = appWith({ question: "How many days?", documents: [HANDBOOK] });
    completionCreate.mockImplementation(
      toolThenAnswer("search_documents", '{"query":"vacation"}', "Twenty days."),
    );

    const res = await ask(app);
    expect(res.status).toBe(200);
    const types = frames(res.body).map((f) => f.type);

    expect(types.filter((t) => t === "done")).toHaveLength(1);
    expect(types.indexOf("step")).toBeLessThan(types.indexOf("delta"));
    expect(types.lastIndexOf("step")).toBeLessThan(types.indexOf("done"));
  });

  it("says a step is running before it says how it went", async () => {
    const { app } = appWith({ question: "How many days?", documents: [HANDBOOK] });
    completionCreate.mockImplementation(
      toolThenAnswer("search_documents", '{"query":"vacation"}', "Twenty days."),
    );
    const steps = frames((await ask(app)).body).filter((f) => f.type === "step");
    expect(steps.map((s) => s.status)).toEqual(["running", "ok"]);
    expect(steps[0].tool).toBe("search_documents");
    // The label carries what it was pointed at, so a person reading the trail
    // can tell two searches apart.
    expect(String(steps[0].label)).toContain("vacation");
  });

  it("writes the step against the reply, once the reply has an id", async () => {
    const { app } = appWith({ question: "How many days?", documents: [HANDBOOK] });
    completionCreate.mockImplementation(
      toolThenAnswer("search_documents", '{"query":"vacation"}', "Twenty days."),
    );
    await ask(app);
    expect(stepsWritten).toHaveBeenCalledTimes(1);
    expect(stepsWritten.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        message_id: "assistant-1",
        step_index: 0,
        tool: "search_documents",
        status: "ok",
        request: { query: "vacation" },
      }),
    ]);
  });

  it("writes no steps at all for an ordinary reply", async () => {
    const { app } = appWith({ question: "How many days?" });
    await ask(app);
    expect(stepsWritten).not.toHaveBeenCalled();
  });

  it("does not offer a tool that has nothing in this workspace to point at", async () => {
    const { app } = appWith({ question: "How many days?" });
    await ask(app);
    const offered = (completionCreate.mock.calls.find((c) => c[0].stream)?.[0].tools ?? []).map(
      (t: { function: { name: string } }) => t.function.name,
    );
    // No connected service and no delivery channel, so only the tool that
    // needs neither.
    expect(offered).toEqual(["search_documents"]);
  });

  it("offers the connection tools once the workspace has a connection", async () => {
    const { app } = appWith({
      question: "How many orders?",
      connections: [
        {
          id: "conn-1",
          workspace_id: "ws-1",
          label: "Covan Supabase",
          transport: "sql",
          base_url: "https://proj.supabase.co/rest/v1",
          auth_kind: "static_header",
          allowed_methods: ["GET"],
          config: {},
        },
      ],
    });
    await ask(app);
    const body = completionCreate.mock.calls.find((c) => c[0].stream)?.[0];
    const offered = (body.tools ?? []).map((t: { function: { name: string } }) => t.function.name);
    expect(offered).toContain("query_database");
    expect(offered).toContain("describe_connection");
    // And the agent is told the id, because a tool takes one and the model
    // has no other way to know it.
    const system = body.messages.find(
      (m: { role: string; content: string }) =>
        m.role === "system" && m.content.includes("Connected services"),
    );
    expect(system.content).toContain("conn-1");
  });
});
