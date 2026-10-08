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

import {
  pollDueBrowserTasks,
  MAX_POLLS,
  BATCH_SIZE,
  type BrowserTaskRow,
  type FinishedTask,
} from "./poller";

const ENV = { BROWSER_USE_API_KEY: "bu_test" } as RoutineEnv;
const NOW = new Date("2026-10-09T12:00:00Z");

type Row = Record<string, unknown>;
let claimed: BrowserTaskRow[];
let updates: { id: unknown; patch: Row }[];

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
 * A db whose `rpc` hands back whatever `claimed` holds and whose `update`
 * records the patch instead of applying it. `rpc` is a `vi.fn` so a test can
 * assert the claim's arguments and that an idle tick never makes it.
 */
function fakeDb(): SupabaseClient & { rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(async () => ({ data: claimed, error: null }));
  return {
    rpc,
    from: () => ({
      update: (patch: Row) => ({
        eq: (_col: string, id: unknown) => {
          updates.push({ id, patch });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  } as unknown as SupabaseClient & { rpc: ReturnType<typeof vi.fn> };
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
  updates = [];
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
    expect(updates[0].patch).toMatchObject({
      status: "running",
      claimed_at: null,
      poll_count: 1,
    });
    expect(new Date(String(updates[0].patch.next_poll_at)).getTime()).toBeGreaterThan(
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
    expect(updates[0].patch).toMatchObject({ status: "running", claimed_at: null, poll_count: 3 });
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
