import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { fakeDb } from "../../test-support/fake-db";
import type { WakeUp, Woken } from "./run";

const settleContinuation = vi.fn(async (..._args: unknown[]): Promise<void> => {});
vi.mock("./rows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./rows")>();
  return { ...actual, settleContinuation: (...a: unknown[]) => settleContinuation(...a) };
});

const { BATCH_SIZE, runDueContinuations } = await import("./dispatch");

const ENV = {} as RoutineEnv;

const TIMER = {
  id: "c-1",
  workspace_id: "ws-1",
  agent_id: "agent-1",
  user_id: "user-1",
  session_id: "sess-1",
  routine_run_id: null,
  note: "open the link",
  wake_at: "2026-10-27T14:35:00.000Z",
  depth: 1,
  status: "running",
  attempts: 1,
};

const STEP = {
  id: "t-1",
  workspace_id: "ws-1",
  agent_id: "agent-1",
  user_id: "user-1",
  session_id: "sess-1",
  routine_run_id: "run-1",
  then_step: "post it to Slack",
  status: "finished",
};

const run = vi.fn(async (_env: RoutineEnv, _wake: WakeUp): Promise<Woken> => ({ status: "done" }));

function world(timers: unknown[], steps: unknown[]) {
  const claims: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const { db } = fakeDb({
    rpc: {
      claim_due_continuations: (args) => {
        claims.push({ fn: "timers", args });
        return { data: timers, error: null };
      },
      claim_browser_continuations_unwatched: (args) => {
        claims.push({ fn: "steps", args });
        return { data: steps, error: null };
      },
    },
  });
  return { db: db as unknown as SupabaseClient, claims };
}

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ status: "done" });
  settleContinuation.mockClear();
});

describe("runDueContinuations", () => {
  it("wakes due timers and settles each", async () => {
    run
      .mockResolvedValueOnce({ status: "done" })
      .mockResolvedValueOnce({ status: "failed", error: "conversation is gone" });
    const { db } = world([TIMER, { ...TIMER, id: "c-2" }], []);

    const out = await runDueContinuations(ENV, { db, run });

    expect(out).toEqual({ claimed: 2 });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][1]).toEqual({
      id: "c-1",
      kind: "timer",
      workspaceId: "ws-1",
      agentId: "agent-1",
      userId: "user-1",
      sessionId: "sess-1",
      routineRunId: null,
      note: "open the link",
    });
    expect(settleContinuation).toHaveBeenCalledWith(db, "c-1", { status: "done" });
    expect(settleContinuation).toHaveBeenCalledWith(db, "c-2", {
      status: "failed",
      error: "conversation is gone",
    });
  });

  it("fills the rest of the batch with steps after the browser", async () => {
    const { db, claims } = world([TIMER], [STEP]);

    const out = await runDueContinuations(ENV, { db, run });

    expect(out).toEqual({ claimed: 2 });
    expect(claims).toEqual([
      { fn: "timers", args: { p_limit: BATCH_SIZE } },
      { fn: "steps", args: { p_limit: BATCH_SIZE - 1 } },
    ]);
    expect(run.mock.calls[1][1]).toEqual({
      id: "task:t-1",
      kind: "after_browser",
      workspaceId: "ws-1",
      agentId: "agent-1",
      userId: "user-1",
      sessionId: "sess-1",
      routineRunId: "run-1",
      note: "post it to Slack",
    });
    // The claim set `continued_at`; there is no continuation row to settle.
    expect(settleContinuation).toHaveBeenCalledTimes(1);
  });

  it("asks for no steps when the timers filled the batch", async () => {
    const { db, claims } = world([TIMER, { ...TIMER, id: "c-2" }], [STEP]);
    await runDueContinuations(ENV, { db, run });
    expect(claims.map((c) => c.fn)).toEqual(["timers"]);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs each row it is handed exactly once", async () => {
    const { db } = world([], [STEP, { ...STEP, id: "t-2" }]);
    await runDueContinuations(ENV, { db, run });
    expect(run.mock.calls.map((c) => c[1].id)).toEqual(["task:t-1", "task:t-2"]);
  });

  it("counts nothing when the claim fails", async () => {
    const { db } = fakeDb({
      rpc: {
        claim_due_continuations: () => ({ data: null, error: { message: "boom", code: "57014" } }),
        claim_browser_continuations_unwatched: () => ({
          data: null,
          error: { message: "boom", code: "57014" },
        }),
      },
    });
    const out = await runDueContinuations(ENV, { db: db as unknown as SupabaseClient, run });
    expect(out).toEqual({ claimed: 0 });
    expect(run).not.toHaveBeenCalled();
  });

  it("settles a wake-up whose turn threw, and goes on with the others", async () => {
    run.mockRejectedValueOnce(new Error("provider down")).mockResolvedValueOnce({ status: "done" });
    const { db } = world([TIMER, { ...TIMER, id: "c-2" }], []);
    const out = await runDueContinuations(ENV, { db, run });
    expect(out).toEqual({ claimed: 2 });
    expect(settleContinuation).toHaveBeenCalledWith(db, "c-1", {
      status: "failed",
      error: "provider down",
    });
    expect(settleContinuation).toHaveBeenCalledWith(db, "c-2", { status: "done" });
  });
});
