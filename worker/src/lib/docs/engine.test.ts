import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb, type QueryContext } from "../../test-support/fake-db";
import type { RoutineEnv } from "../../types";
import {
  advanceDocumentJob,
  MAX_ATTEMPTS,
  outlineRequest,
  sectionRequest,
  type DocumentJob,
  type EngineDeps,
} from "./engine";

/**
 * One unit of work per call, and what each unit leaves behind: the outline as
 * section rows, a section as its body, the last section as a filed document —
 * and, when a unit fails, a backoff rather than a lost document.
 */

const NOW = Date.parse("2026-10-15T12:00:00.000Z");

const ENV = {
  SUPABASE_URL: "http://db",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  OPENAI_API_KEY: "sk-test",
  DOCS_DIR: "/tmp/docs",
} as unknown as RoutineEnv;

const CRON_ENV = { ...ENV, DOCS_DIR: undefined } as unknown as RoutineEnv;

function job(over: Partial<DocumentJob> & Record<string, unknown> = {}): DocumentJob {
  return {
    id: "job-1",
    workspace_id: "ws-1",
    bundle_id: "bundle-1",
    agent_id: "agent-1",
    session_id: "sess-1",
    requested_by: "user-1",
    instruction: "Write up the quarter for the board.",
    title: "Q3",
    history: [{ role: "user", content: "How did Q3 go?" }],
    sources: "<documents>Revenue was 4.2M.</documents>",
    outline: null,
    cursor: 0,
    status: "queued",
    attempts: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    next_run_at: new Date(NOW - 1000).toISOString(),
    ...over,
  } as DocumentJob;
}

const SECTIONS = [
  { idx: 0, heading: "Revenue", brief: "The numbers.", body: "", status: "pending" },
  { idx: 1, heading: "Risks", brief: "What could go wrong.", body: "", status: "pending" },
];

type Spec = {
  claimed?: DocumentJob | null;
  sections?: typeof SECTIONS;
  statusIfUnclaimed?: string | null;
};

function world(spec: Spec = {}) {
  const fake = fakeDb({
    rpc: {
      claim_document_job: () => ({
        data: spec.claimed === null ? [] : [spec.claimed ?? job()],
        error: null,
      }),
    },
    tables: {
      agents: {
        select: () => ({
          data: {
            persona: "You are our CFO.",
            model: null,
            temperature: null,
            reasoning_effort: null,
          },
          error: null,
        }),
      },
      document_jobs: {
        update: () => ({ data: null, error: null }),
        select: () => ({
          data: spec.statusIfUnclaimed ? { status: spec.statusIfUnclaimed } : null,
          error: null,
        }),
      },
      document_sections: {
        insert: () => ({ data: null, error: null }),
        update: () => ({ data: null, error: null }),
        select: () => ({ data: spec.sections ?? SECTIONS, error: null }),
      },
    },
  });
  return fake;
}

const usage = {
  promptTokens: 1000,
  completionTokens: 400,
  cachedTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  webSearches: null,
};

const complete = vi.fn();
const fileDocument = vi.fn();
const check = vi.fn();
const record = vi.fn();

const deps: Partial<EngineDeps> = {
  complete: complete as unknown as EngineDeps["complete"],
  fileDocument: fileDocument as unknown as EngineDeps["fileDocument"],
  entitlements: () => ({ check, record, snapshot: vi.fn() }) as never,
  now: () => NOW,
};

function lastJobUpdate(calls: QueryContext[]) {
  const updates = calls.filter((c) => c.table === "document_jobs" && c.op === "update");
  return updates[updates.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  check.mockResolvedValue({ allowed: true });
  record.mockResolvedValue(undefined);
});

describe("the outline", () => {
  it("turns the plan into section rows and moves the job to writing", async () => {
    const fake = world();
    complete.mockResolvedValue({
      text: JSON.stringify({
        title: "Q3 for the board",
        sections: [
          { heading: "Revenue", brief: "The numbers." },
          { heading: "Risks", brief: "What could go wrong." },
        ],
      }),
      usage,
      finishReason: "stop",
    });

    const next = await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    expect(next).toEqual({ next: "now" });
    expect(complete.mock.calls[0][1]).toMatchObject({ json: true });
    const rows = fake.callsTo("document_sections").find((c) => c.op === "insert")?.values;
    expect(rows).toEqual([
      expect.objectContaining({ job_id: "job-1", idx: 0, heading: "Revenue", status: "pending" }),
      expect.objectContaining({ job_id: "job-1", idx: 1, heading: "Risks", status: "pending" }),
    ]);
    const update = lastJobUpdate(fake.calls);
    expect(update.values).toMatchObject({
      status: "writing",
      title: "Q3 for the board",
      cursor: 0,
      lease_until: null,
    });
    // Conditional on the job still running, so a Stop pressed meanwhile wins.
    expect(update.filters).toContainEqual(
      expect.objectContaining({ column: "status", kind: "in" }),
    );
  });

  it("charges the outline to the job's workspace, for the person who asked", async () => {
    const fake = world();
    complete.mockResolvedValue({ text: "{}", usage, finishReason: "stop" });

    await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    expect(record).toHaveBeenCalledWith(
      "ws-1",
      [expect.objectContaining({ kind: "completion", purpose: "report", promptTokens: 1000 })],
      { userId: "user-1", sessionId: "sess-1" },
    );
  });

  it("falls back to one section when the plan does not parse", async () => {
    const fake = world();
    complete.mockResolvedValue({ text: "Sure! Here is a plan:", usage, finishReason: "stop" });

    await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    const rows = fake.callsTo("document_sections").find((c) => c.op === "insert")
      ?.values as unknown as Array<{ heading: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].heading).toBe("Q3");
  });
});

describe("a section", () => {
  const writing = () => job({ status: "writing", outline: SECTIONS, cursor: 0 });

  it("is written, saved, and the cursor moves on", async () => {
    const fake = world({ claimed: writing() });
    complete.mockResolvedValue({ text: "Revenue was 4.2M.", usage, finishReason: "stop" });

    const next = await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    expect(next).toEqual({ next: "now" });
    const saved = fake.callsTo("document_sections").find((c) => c.op === "update");
    expect(saved?.values).toMatchObject({ body: "Revenue was 4.2M.", status: "done" });
    expect(lastJobUpdate(fake.calls).values).toMatchObject({
      cursor: 1,
      status: "writing",
      attempts: 0,
    });
  });

  it("asks once more when the model runs out of room, and keeps both halves", async () => {
    const fake = world({ claimed: writing() });
    complete
      .mockResolvedValueOnce({ text: "Revenue was ", usage, finishReason: "length" })
      .mockResolvedValueOnce({ text: "4.2M.", usage, finishReason: "stop" });

    await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    expect(complete).toHaveBeenCalledTimes(2);
    const second = complete.mock.calls[1][1].messages;
    expect(second[second.length - 2]).toEqual({ role: "assistant", content: "Revenue was " });
    const saved = fake.callsTo("document_sections").find((c) => c.op === "update");
    expect(saved?.values).toMatchObject({ body: "Revenue was 4.2M." });
  });

  it("drops a heading the model wrote anyway, since the engine adds it", async () => {
    const fake = world({ claimed: writing() });
    complete.mockResolvedValue({
      text: "## Revenue\n\nRevenue was 4.2M.",
      usage,
      finishReason: "stop",
    });

    await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    const saved = fake.callsTo("document_sections").find((c) => c.op === "update");
    expect(saved?.values).toMatchObject({ body: "Revenue was 4.2M." });
  });

  it("moves to filing after the last one", async () => {
    const fake = world({ claimed: job({ status: "writing", outline: SECTIONS, cursor: 1 }) });
    complete.mockResolvedValue({ text: "Supply chain.", usage, finishReason: "stop" });

    await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    expect(lastJobUpdate(fake.calls).values).toMatchObject({ cursor: 2, status: "filing" });
  });

  it("is grounded in the conversation and the sources taken when the job began", async () => {
    const fake = world({ claimed: writing() });
    complete.mockResolvedValue({ text: "x", usage, finishReason: "stop" });

    await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    const messages = complete.mock.calls[0][1].messages;
    expect(messages[0].role).toBe("system");
    expect(messages).toContainEqual({ role: "user", content: "How did Q3 go?" });
    expect(messages).toContainEqual(
      expect.objectContaining({
        role: "user",
        content: "<documents>Revenue was 4.2M.</documents>",
      }),
    );
  });
});

describe("filing", () => {
  const filing = () => job({ status: "filing", title: "Q3 for the board", cursor: 2 });
  const written = [
    { ...SECTIONS[0], body: "Up.", status: "done" },
    { ...SECTIONS[1], body: "Few.", status: "done" },
  ];

  it("joins the sections under the title and files the document", async () => {
    const fake = world({ claimed: filing(), sections: written });
    fileDocument.mockResolvedValue({ filed: true, documentId: "doc-9", indexTokens: 50 });

    const next = await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    expect(next).toEqual({ next: "none" });
    expect(fileDocument.mock.calls[0][2]).toMatchObject({
      workspaceId: "ws-1",
      bundleId: "bundle-1",
      name: "Q3 for the board.md",
      text: "# Q3 for the board\n\n## Revenue\n\nUp.\n\n## Risks\n\nFew.\n",
      createdBy: "user-1",
    });
    expect(lastJobUpdate(fake.calls).values).toMatchObject({
      status: "ready",
      document_id: "doc-9",
    });
  });

  it("waits for a worker that has a document store, rather than failing", async () => {
    const fake = world({ claimed: filing(), sections: written });

    const next = await advanceDocumentJob(fake.db as never, CRON_ENV, "job-1", deps);

    expect(next.next).toBe("at");
    expect(fileDocument).not.toHaveBeenCalled();
    expect(lastJobUpdate(fake.calls).values).toMatchObject({ lease_until: null });
    expect(lastJobUpdate(fake.calls).values).not.toHaveProperty("status");
  });

  it("fails in words when the bundle was deleted meanwhile", async () => {
    const fake = world({ claimed: filing(), sections: written });
    fileDocument.mockResolvedValue({ filed: false, reason: "bundle_gone" });

    await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    expect(lastJobUpdate(fake.calls).values).toMatchObject({ status: "failed" });
  });
});

describe("the lease and the clock", () => {
  it("does nothing when somebody else holds the job, and says when to look again", async () => {
    const fake = world({ claimed: null, statusIfUnclaimed: "writing" });

    const next = await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    expect(next.next).toBe("at");
    expect(complete).not.toHaveBeenCalled();
  });

  it("stops asking about a job that is over", async () => {
    const fake = world({ claimed: null, statusIfUnclaimed: "stopped" });

    expect(await advanceDocumentJob(fake.db as never, ENV, "job-1", deps)).toEqual({
      next: "none",
    });
  });

  it("gives an early job straight back rather than spending its backoff", async () => {
    const early = job({ next_run_at: new Date(NOW + 30_000).toISOString() });
    const fake = world({ claimed: early });

    const next = await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    expect(next).toEqual({ next: "at", at: NOW + 30_000 });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("failure", () => {
  it("backs off and keeps the job when a unit fails", async () => {
    const fake = world();
    complete.mockRejectedValue(new Error("upstream 529"));

    const next = await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    expect(next.next).toBe("at");
    expect(lastJobUpdate(fake.calls).values).toMatchObject({ attempts: 1, lease_until: null });
  });

  it("gives up after the last attempt, and says why", async () => {
    const fake = world({ claimed: job({ attempts: MAX_ATTEMPTS - 1 }) });
    complete.mockRejectedValue(new Error("upstream 529"));

    const next = await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    expect(next).toEqual({ next: "none" });
    const update = lastJobUpdate(fake.calls).values as Record<string, unknown>;
    expect(update.status).toBe("failed");
    expect(String(update.error)).toContain("upstream 529");
  });

  it("stops at the credit check, before any model call", async () => {
    const fake = world();
    check.mockResolvedValue({ allowed: false, balance: 0 });

    const next = await advanceDocumentJob(fake.db as never, ENV, "job-1", deps);

    expect(next).toEqual({ next: "none" });
    expect(complete).not.toHaveBeenCalled();
    expect(lastJobUpdate(fake.calls).values).toMatchObject({ status: "failed" });
  });
});

describe("what the model is asked", () => {
  it("asks for a plan in the request's own language", () => {
    const text = outlineRequest({ title: "Q3", instruction: "Çeyreği yönetim kuruluna yaz." });
    expect(text).toContain("Çeyreği yönetim kuruluna yaz.");
    expect(text).toContain("language the request was made in");
  });

  it("shows a section the plan and the end of the part before it", () => {
    const text = sectionRequest(
      { title: "Q3", instruction: "Write it up." },
      [
        { heading: "Revenue", brief: "The numbers.", body: "Revenue was up." },
        { heading: "Risks", brief: "What could go wrong.", body: "" },
      ],
      1,
    );
    expect(text).toContain("1. Revenue — The numbers.");
    expect(text).toContain("Revenue was up.");
    expect(text).toContain('part 2 of 2: "Risks"');
  });
});
