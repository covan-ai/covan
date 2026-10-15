import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { reports, workingTitle } from "./reports";

/**
 * The Report button only asks now: the document is written in the background
 * by the engine (`lib/docs/engine.ts`), which has its own tests. What is left
 * to see from here is the order of the steps — the caller's own reads, then
 * the quota, then the job — and that the answer is the job rather than a wait.
 */

const USER = { id: "user-1", email: "a@example.com" };
const SESSION = { id: "sess-1", workspace_id: "ws-1", agent_id: "agent-1" };
const AGENT = { id: "agent-1", name: "Finance" };
const JOB = { id: "job-1", status: "queued", title: "Write up the quarter." };

const guardCredits = vi.fn();
const recordCredits = vi.fn();
const enqueueDocumentJob = vi.fn();

vi.mock("../lib/entitlements/guard", () => ({
  guardCredits: (...args: unknown[]) => guardCredits(...args),
  recordCredits: (...args: unknown[]) => recordCredits(...args),
}));

vi.mock("../lib/docs/enqueue", () => ({
  enqueueDocumentJob: (...args: unknown[]) => enqueueDocumentJob(...args),
}));

function appWith(spec?: Partial<NonNullable<FakeDbSpec["tables"]>>) {
  const fake = fakeDb({
    tables: {
      chat_sessions: { select: () => ({ data: SESSION, error: null }) },
      agents: { select: () => ({ data: AGENT, error: null }) },
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

const post = (app: Hono<AppEnv>, body: unknown, env: Record<string, unknown> = {}) =>
  app.request(
    "/sessions/sess-1/report",
    { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } },
    { OPENAI_API_KEY: "sk-test", DOCS_DIR: "/tmp/docs", ...env },
  );

beforeEach(() => {
  vi.clearAllMocks();
  guardCredits.mockResolvedValue(null);
  recordCredits.mockResolvedValue(undefined);
  enqueueDocumentJob.mockResolvedValue({ ok: true, job: JOB, embeddingTokens: 12 });
});

describe("POST /sessions/:id/report", () => {
  it("starts a document and answers with it at once", async () => {
    const { app } = appWith();

    const res = await post(app, { instruction: "Write up the quarter." });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(JOB);
    expect(enqueueDocumentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        agent: { id: "agent-1", name: "Finance" },
        userId: "user-1",
        sessionId: "sess-1",
        instruction: "Write up the quarter.",
        origin: "button",
        bundleId: undefined,
      }),
    );
  });

  it("passes a chosen bundle through", async () => {
    const { app } = appWith();
    await post(app, { instruction: "x", bundleId: "bundle-7" });
    expect(enqueueDocumentJob.mock.calls[0][0]).toMatchObject({ bundleId: "bundle-7" });
  });

  it("charges the retrieval the job was started with", async () => {
    const { app } = appWith();
    await post(app, { instruction: "x" });
    expect(recordCredits).toHaveBeenCalledWith(
      expect.anything(),
      [expect.objectContaining({ kind: "embedding", tokens: 12, purpose: "retrieval" })],
      { sessionId: "sess-1" },
    );
  });

  it("asks the quota before starting anything", async () => {
    const { app } = appWith();
    guardCredits.mockResolvedValue(new Response(null, { status: 402 }));

    const res = await post(app, { instruction: "x" });

    expect(res.status).toBe(402);
    expect(enqueueDocumentJob).not.toHaveBeenCalled();
  });

  it("answers a conversation the caller cannot see as not found", async () => {
    const { app } = appWith({ chat_sessions: { select: () => ({ data: null, error: null }) } });
    const res = await post(app, { instruction: "x" });
    expect(res.status).toBe(404);
    expect(guardCredits).not.toHaveBeenCalled();
  });

  it("says a viewer cannot write into the workspace, in words", async () => {
    const { app } = appWith();
    enqueueDocumentJob.mockResolvedValue({ ok: false, status: 403, reason: "read only" });

    const res = await post(app, { instruction: "x" });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "read only" });
    expect(recordCredits).not.toHaveBeenCalled();
  });

  it("refuses an empty instruction", async () => {
    const { app } = appWith();
    const res = await post(app, { instruction: "   " });
    expect(res.status).toBe(400);
  });

  it("says so when the deployment has nowhere to put a document", async () => {
    const { app } = appWith();
    const res = await post(app, { instruction: "x" }, { DOCS_DIR: undefined });
    expect(res.status).toBe(501);
    expect(enqueueDocumentJob).not.toHaveBeenCalled();
  });
});

describe("workingTitle", () => {
  it("keeps a short instruction whole and on one line", () => {
    expect(workingTitle("  Write up\nthe quarter ")).toBe("Write up the quarter");
  });

  it("cuts a long one", () => {
    expect(workingTitle("x".repeat(200))).toHaveLength(80);
  });
});
