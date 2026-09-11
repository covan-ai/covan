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
  providerEnv?: { OPENAI_API_KEY: string; ANTHROPIC_API_KEY?: string };
  /** The agent's stored model. Defaults to `AGENT.model` (null → the default). */
  agentModel?: string | null;
}) {
  const documents = spec.documents ?? [];
  const rows = [...(spec.history ?? []), { role: "user", content: spec.question }].map((m, i) => ({
    id: `m${i}`,
    role: m.role,
    content: m.content,
    created_at: `2026-09-0${i + 1}T10:00:00Z`,
  }));

  const agent = spec.agentModel !== undefined ? { ...AGENT, model: spec.agentModel } : AGENT;

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
    if (spec.providerEnv) c.set("providerEnv", spec.providerEnv as never);
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
    expect(body).toMatch(/gpt-4o/);
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
    expect(answering![0].model).toBe("gpt-4o");
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
    expect(completionCreate.mock.calls.filter((c) => !c[0].stream)).toHaveLength(0);
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
