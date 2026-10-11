import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import type { BrowserResult, TaskStatus } from "./client";

const taskStatus = vi.fn(
  async (
    _env: unknown,
    _id: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<TaskStatus>> => ({
    kind: "ok",
    value: { status: "running", output: null, isSuccess: null, costUsd: null, finishedAt: null },
  }),
);
const stopTask = vi.fn(
  async (
    _env: unknown,
    _id: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<null>> => ({ kind: "ok", value: null }),
);
vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    taskStatus: (env: unknown, id: string, opts?: { signal?: AbortSignal }) =>
      taskStatus(env, id, opts),
    stopTask: (env: unknown, id: string, opts?: { signal?: AbortSignal }) =>
      stopTask(env, id, opts),
  };
});

const runStatus = vi.fn(
  async (
    _env: unknown,
    _id: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<{ status: RunStatus }>> => ({
    kind: "ok",
    value: { status: "running" },
  }),
);
const runSummary = vi.fn(
  async (
    _env: unknown,
    _id: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<RunSummary>> => ({ kind: "error", status: 500, message: "unset" }),
);
const cancelRun = vi.fn(
  async (
    _env: unknown,
    _id: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<{ status: RunStatus }>> => ({
    kind: "ok",
    value: { status: "cancelled" },
  }),
);
vi.mock("./v4", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./v4")>();
  return {
    ...actual,
    runStatus: (env: unknown, id: string, opts?: { signal?: AbortSignal }) =>
      runStatus(env, id, opts),
    runSummary: (env: unknown, id: string, opts?: { signal?: AbortSignal }) =>
      runSummary(env, id, opts),
    cancelRun: (env: unknown, id: string, opts?: { signal?: AbortSignal }) =>
      cancelRun(env, id, opts),
  };
});

import {
  pollDueBrowserTasks,
  MAX_POLLS,
  BATCH_SIZE,
  type BrowserTaskRow,
  type FinishedTask,
} from "./poller";
import type { RunStatus, RunSummary } from "./v4";
import { memoryDb } from "../../test-support/memory-db";

const ENV = { BROWSER_USE_API_KEY: "bu_test" } as RoutineEnv;
const NOW = new Date("2026-10-09T12:00:00Z");

type Row = Record<string, unknown>;
let claimed: BrowserTaskRow[];
/** What the table holds, when a test wants it to differ from what was claimed. */
let stored: Row[] | null;
let mem: ReturnType<typeof memoryDb>;

/** The task-row writes the tick made, oldest first, as `{ id, patch }`. */
function updatesOf(): { id: unknown; patch: Row }[] {
  return mem
    .callsTo("browser_tasks")
    .filter((c) => c.op === "update")
    .map((c) => ({
      id: c.filters.find((f) => f.column === "id")?.value,
      patch: c.values ?? {},
    }));
}

function row(over: Partial<BrowserTaskRow> = {}): BrowserTaskRow {
  return {
    id: "bt-1",
    workspace_id: "ws-1",
    agent_id: "agent-1",
    user_id: "user-1",
    session_id: "sess-1",
    provider_task_id: "bu-1",
    task: "read the pricing table",
    status: "running",
    poll_count: 0,
    ...over,
  };
}

/**
 * A db whose `rpc` hands back whatever `claimed` holds, over tables that apply
 * the writes they are sent — conditions included, because the settle's claim
 * and the release are both conditional on the row not having ended, and that
 * condition is what keeps the cron from delivering an answer the open tab
 * already delivered. `rpc` is a `vi.fn` so a test can assert the claim's
 * arguments and that an idle tick never makes it.
 */
function fakeDb(): SupabaseClient & { rpc: ReturnType<typeof vi.fn> } {
  mem = memoryDb({
    browser_tasks: stored ?? claimed.map((r) => ({ ...r })),
    browser_sessions: [{ id: "bs-1", live_state: "agent" }],
  });
  const rpc = vi.fn(async () => ({ data: claimed, error: null }));
  return { ...mem.db, rpc } as unknown as SupabaseClient & { rpc: ReturnType<typeof vi.fn> };
}

// Typed with the real signature so `finish.mock.calls[0][1]` is a
// FinishedTask rather than an element of an empty tuple.
const finish = vi.fn(
  async (
    _row: BrowserTaskRow,
    _outcome: FinishedTask,
    _env: RoutineEnv,
    _db: SupabaseClient,
  ): Promise<void> => {},
);

function deps() {
  return { db: fakeDb(), now: () => NOW, finish };
}

beforeEach(() => {
  claimed = [];
  stored = null;
  runStatus.mockReset();
  runSummary.mockReset();
  cancelRun.mockReset();
  cancelRun.mockResolvedValue({ kind: "ok", value: { status: "cancelled" } });
  taskStatus.mockReset();
  stopTask.mockReset();
  stopTask.mockResolvedValue({ kind: "ok", value: null });
  finish.mockReset();
});

describe("an idle tick", () => {
  it("claims nothing and does no work", async () => {
    const result = await pollDueBrowserTasks(ENV, deps());
    expect(result).toEqual({ claimed: 0, ok: 0, failed: 0 });
    expect(taskStatus).not.toHaveBeenCalled();
  });

  /**
   * The poller is on the cron Worker, which is a different Worker with a
   * different secret store. A key set on the API Worker alone means tasks are
   * created and never polled, and the operator needs to find that in
   * `wrangler tail` rather than in the database. Asked BEFORE anything is
   * claimed, the way `background.ts` asks its question.
   */
  it("says so and claims nothing when this Worker has no key", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const d = deps();
    const result = await pollDueBrowserTasks({} as RoutineEnv, d);
    expect(result).toEqual({ claimed: 0, ok: 0, failed: 0 });
    expect(d.db.rpc).not.toHaveBeenCalled();
    expect(warn.mock.calls[0]?.[0]).toContain("BROWSER_USE_API_KEY");
    warn.mockRestore();
  });

  it("claims no more than one tick's worth", async () => {
    const d = deps();
    await pollDueBrowserTasks(ENV, d);
    expect(d.db.rpc).toHaveBeenCalledWith("claim_due_browser_tasks", { p_limit: BATCH_SIZE });
  });
});

describe("a task still running", () => {
  beforeEach(() => {
    claimed = [row()];
    taskStatus.mockResolvedValue({
      kind: "ok",
      value: { status: "running", output: null, isSuccess: null, costUsd: null, finishedAt: null },
    });
  });

  it("releases the claim and books the next poll", async () => {
    const result = await pollDueBrowserTasks(ENV, deps());
    expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });
    expect(updatesOf()[0].patch).toMatchObject({
      status: "running",
      claimed_at: null,
      poll_count: 1,
    });
    expect(new Date(String(updatesOf()[0].patch.next_poll_at)).getTime()).toBeGreaterThan(
      NOW.getTime(),
    );
    expect(finish).not.toHaveBeenCalled();
  });

  /**
   * What stops a task that never finishes. The provider caps a free session
   * at fifteen minutes but guarantees no terminal status, and a row polled
   * forever is a person never told.
   */
  it("stops a task that has been polled too many times, and tells the person", async () => {
    claimed = [row({ poll_count: MAX_POLLS - 1 })];
    await pollDueBrowserTasks(ENV, deps());
    expect(stopTask).toHaveBeenCalledWith(expect.anything(), "bu-1", expect.anything());
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0][1]).toMatchObject({ status: "stopped" });
    expect(String(finish.mock.calls[0][1].error)).toMatch(/too long|gave up|given up/i);
  });

  it("still records the row as stopped when the provider refuses the stop", async () => {
    claimed = [row({ poll_count: MAX_POLLS - 1 })];
    stopTask.mockResolvedValue({ kind: "error", status: 500, message: "nope" });
    await pollDueBrowserTasks(ENV, deps());
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0][1]).toMatchObject({ status: "stopped" });
  });
});

describe("a task that has ended", () => {
  it("hands a finished task to the delivery step with its cost", async () => {
    claimed = [row()];
    taskStatus.mockResolvedValue({
      kind: "ok",
      value: {
        status: "finished",
        output: "Starter $29, Pro $99",
        isSuccess: true,
        costUsd: 0.21,
        finishedAt: "2026-10-09T11:58:00Z",
      },
    });
    const result = await pollDueBrowserTasks(ENV, deps());
    expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });
    expect(finish).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bt-1", session_id: "sess-1" }),
      { status: "finished", output: "Starter $29, Pro $99", error: null, costUsd: 0.21 },
      ENV,
      expect.anything(),
    );
  });

  /**
   * `isSuccess: false` with an output is the provider saying "I ran and I did
   * not manage it". That is a failure with something to say, not a success.
   */
  it("treats a finished-but-unsuccessful task as a failure that still has something to report", async () => {
    claimed = [row()];
    taskStatus.mockResolvedValue({
      kind: "ok",
      value: {
        status: "finished",
        output: "The page asked me to sign in.",
        isSuccess: false,
        costUsd: 0.08,
        finishedAt: "2026-10-09T11:58:00Z",
      },
    });
    await pollDueBrowserTasks(ENV, deps());
    expect(finish.mock.calls[0][1]).toMatchObject({
      status: "failed",
      output: "The page asked me to sign in.",
    });
  });

  it("reports a failed task with no output as a failure", async () => {
    claimed = [row()];
    taskStatus.mockResolvedValue({
      kind: "ok",
      value: { status: "failed", output: null, isSuccess: false, costUsd: 0.03, finishedAt: null },
    });
    await pollDueBrowserTasks(ENV, deps());
    expect(finish.mock.calls[0][1]).toMatchObject({ status: "failed" });
  });
});

describe("when things go wrong", () => {
  it("leaves a task claimable when the provider cannot be reached", async () => {
    claimed = [row({ poll_count: 2 })];
    taskStatus.mockResolvedValue({ kind: "error", status: 0, message: "network down" });
    const result = await pollDueBrowserTasks(ENV, deps());
    expect(result).toEqual({ claimed: 1, ok: 0, failed: 1 });
    expect(updatesOf()[0].patch).toMatchObject({
      status: "running",
      claimed_at: null,
      poll_count: 3,
    });
    expect(finish).not.toHaveBeenCalled();
  });

  /**
   * A 404 is the provider saying the task is not there. Polling it again
   * forever would be the one failure this ceiling exists to prevent, so it
   * ends the row.
   */
  it("ends a task the provider has never heard of", async () => {
    claimed = [row()];
    taskStatus.mockResolvedValue({ kind: "error", status: 404, message: "not found" });
    await pollDueBrowserTasks(ENV, deps());
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0][1]).toMatchObject({ status: "failed" });
  });

  it("does not let one task strand the others in a claimed state", async () => {
    claimed = [row({ id: "bt-1" }), row({ id: "bt-2", provider_task_id: "bu-2" })];
    taskStatus.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({
      kind: "ok",
      value: {
        status: "finished",
        output: "done",
        isSuccess: true,
        costUsd: 0.1,
        finishedAt: null,
      },
    });
    const result = await pollDueBrowserTasks(ENV, deps());
    expect(result.claimed).toBe(2);
    expect(result.failed).toBe(1);
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("throws when the claim itself fails, so a broken tick is not a green one", async () => {
    const d = {
      ...deps(),
      db: {
        rpc: async () => ({ data: null, error: { message: "no such function" } }),
        from: () => ({ update: () => ({ eq: async () => ({ error: null }) }) }),
      } as unknown as SupabaseClient & { rpc: ReturnType<typeof vi.fn> },
    };
    await expect(pollDueBrowserTasks(ENV, d)).rejects.toThrow(/claim_due_browser_tasks/);
  });
});

describe("two clocks, one delivery", () => {
  /**
   * The open tab polls every three seconds and may settle a run between the
   * cron's claim and its write. Whatever the cron then writes must not put
   * the row back to `running` — that would make it due again, and the next
   * tick would deliver the same answer a second time.
   */
  it("does not bring a row the open tab settled back to running", async () => {
    claimed = [row({ status: "running" })];
    stored = [{ ...row(), status: "finished" }];
    taskStatus.mockResolvedValue({
      kind: "ok",
      value: { status: "running", output: null, isSuccess: null, costUsd: null, finishedAt: null },
    });
    await pollDueBrowserTasks(ENV, deps());
    expect(mem.tables.browser_tasks[0].status).toBe("finished");
    const release = mem.callsTo("browser_tasks").find((c) => c.op === "update");
    expect(release?.filters).toContainEqual({
      column: "status",
      value: ["queued", "running"],
      kind: "in",
    });
  });

  it("delivers nothing for a row the open tab already settled", async () => {
    claimed = [row()];
    stored = [{ ...row(), status: "finished" }];
    taskStatus.mockResolvedValue({
      kind: "ok",
      value: {
        status: "finished",
        output: "done",
        isSuccess: true,
        costUsd: 0.1,
        finishedAt: null,
      },
    });
    await pollDueBrowserTasks(ENV, deps());
    expect(finish).not.toHaveBeenCalled();
  });
});

describe("a v4 run", () => {
  function v4Row(over: Partial<BrowserTaskRow> = {}): BrowserTaskRow {
    return row({
      api_version: "v4",
      provider_task_id: "run-1",
      provider_run_id: "run-1",
      browser_session_id: "bs-1",
      ...over,
    });
  }

  function summary(over: Partial<RunSummary> = {}): RunSummary {
    return {
      id: "run-1",
      status: "completed",
      result: "Starter $29, Pro $99",
      output: null,
      error: null,
      totalCostUsd: 0.09,
      sessionId: "bu-session-1",
      ...over,
    };
  }

  it("is polled on the runs API, not as a v2 task", async () => {
    claimed = [v4Row()];
    runStatus.mockResolvedValue({ kind: "ok", value: { status: "running" } });
    const result = await pollDueBrowserTasks(ENV, deps());
    expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });
    expect(runStatus).toHaveBeenCalledWith(ENV, "run-1", expect.anything());
    expect(taskStatus).not.toHaveBeenCalled();
    expect(runSummary).not.toHaveBeenCalled();
    expect(updatesOf()[0].patch).toMatchObject({ status: "running", poll_count: 1 });
  });

  it("counts dispatching as still going", async () => {
    claimed = [v4Row()];
    runStatus.mockResolvedValue({ kind: "ok", value: { status: "dispatching" } });
    await pollDueBrowserTasks(ENV, deps());
    expect(finish).not.toHaveBeenCalled();
  });

  it("reads the summary once the run has ended, and settles it", async () => {
    claimed = [v4Row()];
    runStatus.mockResolvedValue({ kind: "ok", value: { status: "completed" } });
    runSummary.mockResolvedValue({ kind: "ok", value: summary() });
    await pollDueBrowserTasks(ENV, deps());
    expect(runSummary).toHaveBeenCalledWith(ENV, "run-1", expect.anything());
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0][1]).toMatchObject({
      status: "finished",
      output: "Starter $29, Pro $99",
      costUsd: 0.09,
    });
    expect(mem.tables.browser_tasks[0]).toMatchObject({ status: "finished", poll_count: 1 });
    // R4: the agent let go of the browser.
    expect(mem.tables.browser_sessions[0].live_state).toBe("none");
  });

  it("carries a login wall through to the delivery", async () => {
    claimed = [v4Row()];
    runStatus.mockResolvedValue({ kind: "ok", value: { status: "completed" } });
    runSummary.mockResolvedValue({
      kind: "ok",
      value: summary({ result: null, output: { status: "login_required", host: "linkedin.com" } }),
    });
    await pollDueBrowserTasks(ENV, deps());
    expect(finish.mock.calls[0][1]).toMatchObject({
      status: "failed",
      reported: { status: "login_required", host: "linkedin.com" },
    });
  });

  it("tries again next tick when the summary cannot be read", async () => {
    claimed = [v4Row()];
    runStatus.mockResolvedValue({ kind: "ok", value: { status: "completed" } });
    runSummary.mockResolvedValue({ kind: "error", status: 502, message: "502 Bad Gateway" });
    const result = await pollDueBrowserTasks(ENV, deps());
    expect(result.failed).toBe(1);
    expect(finish).not.toHaveBeenCalled();
    expect(mem.tables.browser_tasks[0].status).toBe("running");
  });

  it("gives up on an unreadable summary at the same ceiling as everything else", async () => {
    claimed = [v4Row({ poll_count: MAX_POLLS - 1 })];
    runStatus.mockResolvedValue({ kind: "ok", value: { status: "completed" } });
    runSummary.mockResolvedValue({ kind: "error", status: 502, message: "502 Bad Gateway" });
    await pollDueBrowserTasks(ENV, deps());
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish.mock.calls[0][1]).toMatchObject({ status: "failed" });
  });

  it("cancels a run that has been polled too many times, and tells the person", async () => {
    claimed = [v4Row({ poll_count: MAX_POLLS - 1 })];
    runStatus.mockResolvedValue({ kind: "ok", value: { status: "running" } });
    await pollDueBrowserTasks(ENV, deps());
    expect(cancelRun).toHaveBeenCalledWith(ENV, "run-1", expect.anything());
    expect(stopTask).not.toHaveBeenCalled();
    expect(finish.mock.calls[0][1]).toMatchObject({ status: "stopped", stopReason: "cancelled" });
    expect(mem.tables.browser_tasks[0]).toMatchObject({
      status: "stopped",
      stop_reason: "cancelled",
    });
  });

  it("ends a run the provider has never heard of", async () => {
    claimed = [v4Row()];
    runStatus.mockResolvedValue({ kind: "error", status: 404, message: "404 Not Found" });
    await pollDueBrowserTasks(ENV, deps());
    expect(finish.mock.calls[0][1]).toMatchObject({ status: "failed" });
  });

  it("leaves a run claimable when the provider cannot be reached", async () => {
    claimed = [v4Row()];
    runStatus.mockResolvedValue({ kind: "error", status: 0, message: "network down" });
    const result = await pollDueBrowserTasks(ENV, deps());
    expect(result.failed).toBe(1);
    expect(mem.tables.browser_tasks[0]).toMatchObject({ status: "running", claimed_at: null });
  });
});
