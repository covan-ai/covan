import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { REPORT_INSTRUCTIONS } from "../lib/prompt";
import { chunkText } from "../lib/embeddings";
import { reports, REPORT_CHUNK_SIZE, REPORT_CHUNK_OVERLAP } from "./reports";

/**
 * What this file is for: what the route spends, and what it leaves behind when
 * a step fails.
 *
 * Title parsing and the prompt live next door and are unit-tested there. The
 * things only visible from here are the order of the steps — quota before
 * generation, bundle before generation, object before row — and the cleanup
 * when the row is refused after the object has already landed.
 */

const USER = { id: "user-1", email: "a@example.com" };
const SESSION = { id: "sess-1", agent_id: "agent-1", kind: "chat" };
const AGENT = {
  id: "agent-1",
  persona: "You are our PM.",
  model: null,
  mode: "normal",
  temperature: null,
  reasoning_effort: null,
};
const BUNDLE = { id: "bundle-1", workspace_id: "ws-1" };
const MESSAGES = [
  { role: "user", content: "How did Q3 go?", created_at: "2026-09-01T00:00:00.000Z" },
  { role: "assistant", content: "Revenue was up.", created_at: "2026-09-01T00:00:01.000Z" },
];

const completionCreate = vi.fn();
const embedTexts = vi.fn();
const retrieveForAgent = vi.fn();
const guardQuota = vi.fn();
const recordQuota = vi.fn();
const storePut = vi.fn();
const storeDelete = vi.fn();

vi.mock("../lib/openai", () => ({
  createOpenAI: () => ({ chat: { completions: { create: completionCreate } } }),
}));

vi.mock("../lib/anthropic", () => ({
  createAnthropic: () => ({ messages: { create: vi.fn() } }),
}));

vi.mock("../lib/entitlements/guard", () => ({
  guardQuota: (...args: unknown[]) => guardQuota(...args),
  recordQuota: (...args: unknown[]) => recordQuota(...args),
}));

vi.mock("../lib/retrieval", () => ({
  retrieveForAgent: (...args: unknown[]) => retrieveForAgent(...args),
}));

vi.mock("../lib/embeddings", async (importOriginal) => ({
  // `chunkText` is real: how a report is cut is the thing under test, not a
  // detail to stub. Only the network call is replaced.
  ...(await importOriginal<typeof import("../lib/embeddings")>()),
  embedTexts: (...args: unknown[]) => embedTexts(...args),
}));

vi.mock("../lib/docstore", () => ({
  getDocStore: () => ({ put: storePut, delete: storeDelete }),
}));

const DOC_ROW = {
  id: "doc-1",
  name: "Q3 Review.md",
  size: 1234,
  created_at: "2026-09-15T00:00:00.000Z",
};

function appWith(spec?: Partial<FakeDbSpec["tables"]>) {
  const fake = fakeDb({
    tables: {
      chat_sessions: { select: () => ({ data: SESSION, error: null }) },
      agents: { select: () => ({ data: AGENT, error: null }) },
      knowledge_bundles: { select: () => ({ data: BUNDLE, error: null }) },
      messages: { select: () => ({ data: [...MESSAGES].reverse(), error: null }) },
      documents: { insert: () => ({ data: DOC_ROW, error: null }) },
      document_chunks: { insert: () => ({ data: null, error: null }) },
      ...spec,
    },
  });
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", fake.db as never);
    await next();
  });
  app.route("/", reports);
  return { app, fake };
}

const post = (app: Hono<AppEnv>, body: unknown) =>
  app.request(
    "/sessions/sess-1/report",
    { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
    { OPENAI_API_KEY: "sk-test" },
  );

const ask = { instruction: "Write up the quarter.", bundleId: "bundle-1" };

/** The model answers with a titled report and a token count. */
function modelAnswers(markdown: string) {
  completionCreate.mockResolvedValue({
    choices: [{ message: { content: markdown } }],
    usage: { prompt_tokens: 3000, completion_tokens: 1200 },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  guardQuota.mockResolvedValue(null);
  recordQuota.mockResolvedValue(undefined);
  storePut.mockResolvedValue(undefined);
  storeDelete.mockResolvedValue(undefined);
  embedTexts.mockImplementation(async (_env: unknown, texts: string[]) => ({
    vectors: texts.map(() => [0.1, 0.2, 0.3]),
    tokens: texts.length * 100,
  }));
  retrieveForAgent.mockResolvedValue({
    docNames: ["numbers.csv"],
    bundleIds: ["bundle-1"],
    ragBlock: "CONTEXT\nRevenue was up 12%.",
    sources: [{ id: "doc-9", name: "numbers.csv" }],
    grounding: "chunks",
    embeddingTokens: 200,
  });
  modelAnswers("# Q3 Review\n\nRevenue was up 12%.");
});

describe("POST /sessions/:id/report", () => {
  it("refuses before generating anything when the allowance is gone", async () => {
    // The whole reason this route can keep chat's metering shape is that there
    // is one model call and the refusal lands before it. If the guard ever
    // moves below the generation, the user is billed for a 402.
    guardQuota.mockResolvedValue(new Response(JSON.stringify({ error: "quota" }), { status: 402 }));

    const res = await post(appWith().app, ask);

    expect(res.status).toBe(402);
    expect(completionCreate).not.toHaveBeenCalled();
    expect(storePut).not.toHaveBeenCalled();
  });

  it("asks for a document rather than a brief answer", async () => {
    await post(appWith().app, ask);

    const body = completionCreate.mock.calls[0][0] as {
      messages: Array<{ role: string; content: string }>;
      max_tokens?: number;
      max_completion_tokens?: number;
    };
    const system = body.messages.find((m) => m.role === "system");
    expect(system?.content).toContain(REPORT_INSTRUCTIONS);
  });

  it("saves the report under the title the model gave it", async () => {
    const { app, fake } = appWith();

    const res = await post(app, ask);

    expect(res.status).toBe(201);
    const inserted = fake.callsTo("documents")[0].values as Record<string, unknown>;
    expect(inserted.name).toBe("Q3 Review.md");
    expect(inserted.bundle_id).toBe("bundle-1");
    expect(inserted.content).toContain("Revenue was up 12%.");
    expect(inserted.r2_key).toEqual(expect.stringContaining("bundle-1/"));
  });

  it("falls back to a dated name when the model titled nothing", async () => {
    modelAnswers("Revenue was up 12%, and nothing here is a heading.");
    const { app, fake } = appWith();

    await post(app, ask);

    const inserted = fake.callsTo("documents")[0].values as Record<string, unknown>;
    expect(inserted.name).toMatch(/^Report \d{4}-\d{2}-\d{2}\.md$/);
  });

  it("embeds the report, so it retrieves like any other document", async () => {
    // It was born unindexed at first, to save storage, and the stored-text
    // fallback was supposed to be how it was read. It was not: that path only
    // runs when retrieval found nothing at all, and an agent that has a report
    // has the documents it was written from, one of which always matches. The
    // report became the one file that could be named and never read.
    const { app, fake } = appWith();

    const res = await post(app, ask);

    expect(fake.callsTo("document_chunks").length).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ indexed: true });
  });

  it("cuts a report into coarser passages than an upload", async () => {
    // The storage a chunk costs is mostly its vector and its index, both fixed
    // per chunk whatever the passage says — so fewer, larger passages is the
    // dial. A report is one coherent document rather than a pile of unrelated
    // pages, which is what makes the coarser cut safe here and not on uploads.
    const long = `# Q3 Review\n\n${"Revenue rose. ".repeat(1200)}`;
    modelAnswers(long);
    const { app, fake } = appWith();

    await post(app, ask);

    const rows = fake.callsTo("document_chunks").flatMap((c) => c.values as unknown as unknown[]);
    expect(rows).toHaveLength(
      chunkText(long.trim(), REPORT_CHUNK_SIZE, REPORT_CHUNK_OVERLAP).length,
    );
    expect(rows.length).toBeLessThan(chunkText(long.trim()).length / 2);
  });

  it("still saves the report when the embedding fails", async () => {
    // Best effort, the same as an upload: a document that exists and retrieves
    // nothing beats losing what the model just wrote and charging for it.
    embedTexts.mockRejectedValue(new Error("embeddings are down"));
    const { app, fake } = appWith();

    const res = await post(app, ask);

    expect(res.status).toBe(201);
    expect(fake.callsTo("documents")).toHaveLength(1);
    expect(await res.json()).toMatchObject({ chunkCount: 0, indexed: false });
  });

  it("charges the turn for the generation, the retrieval and the indexing", async () => {
    await post(appWith().app, ask);

    // 3000 prompt + 1200 completion + ceil(200 * 0.01) retrieval embedding
    // + ceil(100 * 0.01) for embedding the one passage this report cut into.
    expect(recordQuota).toHaveBeenCalledWith(expect.anything(), 4203);
  });

  it("still charges for the retrieval when the generation fails", async () => {
    // The embedding was really bought before the model was asked anything.
    // Dropping it because the next step failed is a free query.
    completionCreate.mockRejectedValue(new Error("upstream is down"));

    const res = await post(appWith().app, ask);

    expect(res.status).toBe(502);
    expect(recordQuota).toHaveBeenCalledWith(expect.anything(), 2);
    expect(storePut).not.toHaveBeenCalled();
  });

  it("takes the stored object back when the row is refused", async () => {
    // A viewer passes the session read and fails the document insert, and RLS
    // answers that by matching no rows. Without this the refusal leaves an
    // orphaned object in the store that nothing will ever point at or purge.
    const { app } = appWith({
      documents: { insert: () => ({ data: null, error: { message: "denied", code: "42501" } }) },
    });

    const res = await post(app, ask);

    expect(res.status).toBe(500);
    expect(storeDelete).toHaveBeenCalledTimes(1);
    expect(storeDelete).toHaveBeenCalledWith(storePut.mock.calls[0][0]);
  });

  it("refuses a bundle the caller cannot see before paying for a report", async () => {
    const { app } = appWith({ knowledge_bundles: { select: () => ({ data: null, error: null }) } });

    const res = await post(app, ask);

    expect(res.status).toBe(404);
    expect(completionCreate).not.toHaveBeenCalled();
  });

  it("404s a session that is not the caller's", async () => {
    const { app } = appWith({ chat_sessions: { select: () => ({ data: null, error: null }) } });

    const res = await post(app, ask);

    expect(res.status).toBe(404);
    expect(completionCreate).not.toHaveBeenCalled();
  });

  it("rejects a request with no instruction", async () => {
    const res = await post(appWith().app, { bundleId: "bundle-1" });

    expect(res.status).toBe(400);
    expect(guardQuota).not.toHaveBeenCalled();
  });
});
