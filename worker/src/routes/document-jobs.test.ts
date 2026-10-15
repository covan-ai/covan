import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { documentJobs } from "./document-jobs";

const USER = { id: "user-1", email: "a@example.com" };

const serviceUpdate = vi.fn();
const advanceDocumentJob = vi.fn();
const kickDocumentJob = vi.fn();
const guardCredits = vi.fn();
let host: object | null = null;

vi.mock("../lib/supabase", () => ({
  serviceClient: () => ({
    from: () => ({
      update: (values: unknown) => {
        serviceUpdate(values);
        const chain = {
          eq: () => chain,
          in: () => Promise.resolve({ data: null, error: null }),
        };
        return chain;
      },
    }),
  }),
}));
vi.mock("../lib/docs/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/docs/engine")>()),
  advanceDocumentJob: (...args: unknown[]) => advanceDocumentJob(...args),
}));
vi.mock("../lib/docs/host", () => ({
  documentHost: () => host,
  kickDocumentJob: (...args: unknown[]) => kickDocumentJob(...args),
}));
vi.mock("../lib/entitlements/guard", () => ({
  guardCredits: (...args: unknown[]) => guardCredits(...args),
}));

function jobRow(over: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    workspace_id: "ws-1",
    bundle_id: "bundle-1",
    agent_id: "agent-1",
    session_id: "sess-1",
    requested_by: "user-1",
    origin: "tool",
    instruction: "Write it up.",
    title: "Q3",
    outline: [{ heading: "A" }, { heading: "B" }],
    cursor: 1,
    status: "writing",
    document_id: null,
    error: null,
    created_at: "2026-10-15T12:00:00.000Z",
    updated_at: new Date().toISOString(),
    finished_at: null,
    ...over,
  };
}

const SECTIONS = [
  { job_id: "job-1", idx: 1, heading: "B", body: "", status: "pending" },
  { job_id: "job-1", idx: 0, heading: "A", body: "Done.", status: "done" },
];

function appWith(
  row: Record<string, unknown> | null = jobRow(),
  spec: Partial<NonNullable<FakeDbSpec["tables"]>> = {},
) {
  const fake = fakeDb({
    tables: {
      chat_sessions: { select: () => ({ data: { id: "sess-1" }, error: null }) },
      document_jobs: {
        select: (ctx) => ({ data: ctx.single ? row : row ? [row] : [], error: null }),
      },
      document_sections: { select: () => ({ data: SECTIONS, error: null }) },
      ...spec,
    },
  });
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", fake.db as never);
    await next();
  });
  app.route("/", documentJobs);
  return { app, fake };
}

const env = { SUPABASE_URL: "http://db", SUPABASE_SERVICE_ROLE_KEY: "service" };

beforeEach(() => {
  vi.clearAllMocks();
  host = null;
  guardCredits.mockResolvedValue(null);
  advanceDocumentJob.mockResolvedValue({ next: "now" });
});

describe("GET /sessions/:id/document-jobs", () => {
  it("answers each job with its sections, in order", async () => {
    const { app } = appWith();
    const res = await app.request("/sessions/sess-1/document-jobs", {}, env);
    expect(res.status).toBe(200);
    const [job] = (await res.json()) as Array<
      Record<string, unknown> & { sections: Array<{ heading: string }> }
    >;
    expect(job).toMatchObject({ id: "job-1", status: "writing", written: 1, total: 2 });
    expect(job.sections.map((s: { heading: string }) => s.heading)).toEqual(["A", "B"]);
    expect(job).not.toHaveProperty("sources");
  });

  it("is the clock when the deployment has no host: one unit per poll", async () => {
    const { app } = appWith();
    await app.request("/sessions/sess-1/document-jobs", {}, env);
    expect(advanceDocumentJob).toHaveBeenCalledTimes(1);
    expect(advanceDocumentJob.mock.calls[0][2]).toBe("job-1");
  });

  it("leaves a moving job to its host, and kicks one that has stalled", async () => {
    host = {};
    const fresh = appWith();
    await fresh.app.request("/sessions/sess-1/document-jobs", {}, env);
    expect(advanceDocumentJob).not.toHaveBeenCalled();
    expect(kickDocumentJob).not.toHaveBeenCalled();

    const stalled = appWith(jobRow({ updated_at: "2026-10-15T00:00:00.000Z" }));
    await stalled.app.request("/sessions/sess-1/document-jobs", {}, env);
    expect(kickDocumentJob).toHaveBeenCalledWith(expect.anything(), "job-1");
  });

  it("does not drive a finished job", async () => {
    const { app } = appWith(jobRow({ status: "ready" }));
    await app.request("/sessions/sess-1/document-jobs", {}, env);
    expect(advanceDocumentJob).not.toHaveBeenCalled();
  });

  it("answers a conversation the caller cannot see as not found", async () => {
    const { app } = appWith(jobRow(), {
      chat_sessions: { select: () => ({ data: null, error: null }) },
    });
    const res = await app.request("/sessions/sess-1/document-jobs", {}, env);
    expect(res.status).toBe(404);
  });
});

describe("POST /document-jobs/:id/stop", () => {
  it("stops a job that is being written", async () => {
    const { app } = appWith();
    const res = await app.request("/document-jobs/job-1/stop", { method: "POST" }, env);
    expect(res.status).toBe(200);
    expect(serviceUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: "stopped" }));
  });

  it("will not stop somebody else's job: RLS shows it to nobody else", async () => {
    const { app } = appWith(null);
    const res = await app.request("/document-jobs/job-1/stop", { method: "POST" }, env);
    expect(res.status).toBe(404);
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("has nothing to stop on a finished job", async () => {
    const { app } = appWith(jobRow({ status: "ready" }));
    const res = await app.request("/document-jobs/job-1/stop", { method: "POST" }, env);
    expect(res.status).toBe(409);
  });
});

describe("POST /document-jobs/:id/retry", () => {
  it("picks a failed job up at the section it stopped on", async () => {
    const { app } = appWith(jobRow({ status: "failed", cursor: 1 }));
    const res = await app.request("/document-jobs/job-1/retry", { method: "POST" }, env);
    expect(res.status).toBe(202);
    expect(serviceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ status: "writing", attempts: 0, error: null }),
    );
    expect(kickDocumentJob).toHaveBeenCalledWith(expect.anything(), "job-1");
  });

  it("goes straight to filing when every section was written", async () => {
    const { app } = appWith(jobRow({ status: "stopped", cursor: 2 }));
    await app.request("/document-jobs/job-1/retry", { method: "POST" }, env);
    expect(serviceUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: "filing" }));
  });

  it("starts from the outline when there was none", async () => {
    const { app } = appWith(jobRow({ status: "failed", outline: null, cursor: 0 }));
    await app.request("/document-jobs/job-1/retry", { method: "POST" }, env);
    expect(serviceUpdate).toHaveBeenCalledWith(expect.objectContaining({ status: "queued" }));
  });

  it("asks the quota first", async () => {
    guardCredits.mockResolvedValue(new Response(null, { status: 402 }));
    const { app } = appWith(jobRow({ status: "failed" }));
    const res = await app.request("/document-jobs/job-1/retry", { method: "POST" }, env);
    expect(res.status).toBe(402);
    expect(serviceUpdate).not.toHaveBeenCalled();
  });

  it("will not restart a job that is still running", async () => {
    const { app } = appWith();
    const res = await app.request("/document-jobs/job-1/retry", { method: "POST" }, env);
    expect(res.status).toBe(409);
  });
});
