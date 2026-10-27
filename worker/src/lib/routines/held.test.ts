import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";

const { deliver, record, complete } = vi.hoisted(() => ({
  deliver: vi.fn(async (..._args: unknown[]): Promise<void> => {}),
  record: vi.fn(async (..._args: unknown[]): Promise<void> => {}),
  complete: vi.fn(
    async (
      ..._args: unknown[]
    ): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number } }> => ({
      text: "the composed report",
      usage: { promptTokens: 10, completionTokens: 5 },
    }),
  ),
}));

vi.mock("./delivery", () => ({
  deliver: (...args: unknown[]) => deliver(...args),
  deliveryDepsFrom: () => ({}),
}));
vi.mock("./address-confirmation", () => ({
  CONFIRMABLE_COLUMNS: "id, kind, secret_ciphertext, confirmed_at",
  readyForDelivery: async (_env: unknown, channel: unknown) => channel,
}));
vi.mock("../entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../entitlements")>();
  return { ...actual, entitlementsFor: () => ({ record: (...a: unknown[]) => record(...a) }) };
});
vi.mock("../completion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../completion")>();
  return { ...actual, complete: (...a: unknown[]) => complete(...a) };
});
const { chainPending, cancelContinuations } = vi.hoisted(() => ({
  chainPending: vi.fn(async (..._args: unknown[]): Promise<boolean> => false),
  cancelContinuations: vi.fn(async (..._args: unknown[]): Promise<void> => {}),
}));
vi.mock("../continuations/rows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../continuations/rows")>();
  return {
    ...actual,
    chainPending: (...a: unknown[]) => chainPending(...a),
    cancelContinuations: (...a: unknown[]) => cancelContinuations(...a),
  };
});

import {
  answered,
  completeHeldRun,
  composeReport,
  openRoutineConversation,
  sweepHeldRuns,
  type HeldTask,
} from "./held";

const env = { OPENAI_API_KEY: "sk-test" } as unknown as RoutineEnv;

type Call = { table: string; op: string; filters: Array<[string, unknown]>; payload?: unknown };
type Answer = { data: unknown; error: { code?: string; message: string } | null };

/**
 * A query builder that records what it was asked and answers from `respond`.
 * Every chain this module makes ends in `maybeSingle`, `single` or an await,
 * and each of those resolves through the same function.
 */
function fakeDb(respond: (call: Call) => Answer) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: [] };
      const builder: Record<string, unknown> = {};
      const chain =
        (name: string) =>
        (...args: unknown[]) => {
          if (name === "update" || name === "insert" || name === "delete") {
            call.op = name;
            call.payload = args[0];
          } else if (name !== "select" || call.op === "select") {
            if (name !== "select") call.filters.push([name, args]);
          }
          return builder;
        };
      for (const name of [
        "select",
        "eq",
        "is",
        "or",
        "order",
        "limit",
        "lt",
        "in",
        "update",
        "insert",
        "delete",
      ]) {
        builder[name] = chain(name);
      }
      const finish = () => {
        calls.push(call);
        return Promise.resolve(respond(call));
      };
      builder.maybeSingle = finish;
      builder.single = finish;
      builder.then = (ok: (v: Answer) => unknown, no: (e: unknown) => unknown) =>
        finish().then(ok, no);
      return builder;
    },
  } as unknown as SupabaseClient;
  return { db, calls };
}

const ROUTINE = {
  id: "routine-1",
  name: "Morning prices",
  agent_id: "agent-1",
  user_id: "user-1",
  workspace_id: "ws-1",
  instruction: "check the prices",
  delivery_channel_id: "chan-1",
  output_bundle_id: null,
  output_retention: 52,
  ends_after_runs: null,
  runs_done: 0,
  status: "active",
};

const RUN = {
  id: "run-1",
  routine_id: "routine-1",
  started_at: "2026-10-15T06:00:00.000Z",
  tokens: 100,
  summary: "Draft: the browser is checking the prices.",
  items_new: 0,
  items_overflow: 0,
};

function task(over: Partial<HeldTask> = {}): HeldTask {
  return {
    id: "bt-1",
    task: "read the prices on example.com",
    status: "finished",
    output: "Basic is $10, Pro is $20.",
    error: null,
    retry_of: null,
    ...over,
  };
}

/** The ordinary world: one answered task, a run nobody has claimed, a channel. */
function world(over: { tasks?: HeldTask[]; claimed?: boolean } = {}) {
  return fakeDb((call) => {
    if (call.table === "browser_tasks") return { data: over.tasks ?? [task()], error: null };
    if (
      call.table === "routine_runs" &&
      call.op === "update" &&
      "held_claimed_at" in (call.payload as object)
    ) {
      return { data: over.claimed === false ? null : RUN, error: null };
    }
    if (call.table === "routine_runs") return { data: null, error: null };
    if (call.table === "routines" && call.op === "select") return { data: ROUTINE, error: null };
    if (call.table === "agents") return { data: { model: null }, error: null };
    if (call.table === "delivery_channels") {
      return { data: { id: "chan-1", kind: "slack_webhook", disabled_at: null }, error: null };
    }
    return { data: null, error: null };
  });
}

beforeEach(() => {
  deliver.mockReset();
  deliver.mockResolvedValue(undefined);
  record.mockReset();
  complete.mockReset();
  complete.mockResolvedValue({
    text: "the composed report",
    usage: { promptTokens: 10, completionTokens: 5 },
  });
  chainPending.mockReset();
  chainPending.mockResolvedValue(false);
  cancelContinuations.mockClear();
});

describe("completeHeldRun", () => {
  it("waits, and claims nothing, while one of the run's tasks has not answered", async () => {
    const { db, calls } = world({ tasks: [task(), task({ id: "bt-2", status: "running" })] });

    expect(await completeHeldRun(env, "run-1", { db })).toBe(false);
    expect(calls.some((c) => c.table === "routine_runs")).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("sends the report once, with the answers written in, when the last one has", async () => {
    const { db, calls } = world();

    expect(await completeHeldRun(env, "run-1", { db })).toBe(true);

    expect(deliver).toHaveBeenCalledOnce();
    const [channel, message, , context] = deliver.mock.calls[0] as [
      { id: string },
      { subject: string; body: string },
      unknown,
      { routine: { id: string } },
    ];
    expect(channel.id).toBe("chan-1");
    expect(message).toEqual({ subject: "Morning prices", body: "the composed report" });
    expect(context.routine.id).toBe("routine-1");

    // The model saw the draft and the browser's answer, as material.
    const asked = JSON.stringify(complete.mock.calls[0]);
    expect(asked).toContain("Draft: the browser is checking the prices.");
    expect(asked).toContain("Basic is $10, Pro is $20.");

    const written = calls.find(
      (c) =>
        c.table === "routine_runs" &&
        c.op === "update" &&
        !("held_claimed_at" in (c.payload as object)),
    );
    expect(written?.payload).toMatchObject({
      status: "ok",
      summary: "the composed report",
      tokens: 115,
    });
    expect(written?.filters).toContainEqual(["eq", ["status", "waiting"]]);
    expect(record).toHaveBeenCalledOnce();
  });

  it("sends nothing when another settle already claimed the run", async () => {
    const { db } = world({ claimed: false });

    expect(await completeHeldRun(env, "run-1", { db })).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("records a run whose channel refused as failed, keeping the draft", async () => {
    deliver.mockRejectedValue(new Error("slack said 404"));
    const { db, calls } = world();

    await completeHeldRun(env, "run-1", { db });

    const written = calls.find(
      (c) =>
        c.table === "routine_runs" &&
        c.op === "update" &&
        !("held_claimed_at" in (c.payload as object)),
    );
    expect(written?.payload).toMatchObject({
      status: "failed",
      error: "slack said 404",
      summary: RUN.summary,
    });
  });

  it("delivers a woken turn's reply as the report without composing (0142)", async () => {
    const { db } = world();

    expect(await completeHeldRun(env, "run-1", { db }, { report: "the chain's last word" })).toBe(
      true,
    );

    expect(complete).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledOnce();
    const [, message] = deliver.mock.calls[0] as [unknown, { subject: string; body: string }];
    expect(message).toEqual({ subject: "Morning prices", body: "the chain's last word" });
  });

  it("sends an overdue run with what it has", async () => {
    const { db } = world({ tasks: [task({ status: "waiting", output: null })] });

    expect(await completeHeldRun(env, "run-1", { db }, { overdue: true })).toBe(true);
    expect(JSON.stringify(complete.mock.calls[0])).toContain("had not finished in time");
  });

  // The chain (0142): a wake-up not yet run, or a step the cron has yet to
  // claim, is work the report is waiting for as much as a browser task is.
  it("waits while the run's chain is pending", async () => {
    chainPending.mockResolvedValue(true);
    const { db, calls } = world();

    expect(await completeHeldRun(env, "run-1", { db })).toBe(false);
    expect(chainPending).toHaveBeenCalledWith(db, "run-1", expect.any(Date));
    expect(calls.some((c) => c.table === "routine_runs")).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("sends once the chain has ended", async () => {
    chainPending.mockResolvedValue(false);
    const { db } = world();

    expect(await completeHeldRun(env, "run-1", { db })).toBe(true);
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("does not ask about the chain when the run is overdue", async () => {
    chainPending.mockResolvedValue(true);
    const { db } = world();

    expect(await completeHeldRun(env, "run-1", { db }, { overdue: true })).toBe(true);
    expect(deliver).toHaveBeenCalledOnce();
  });
});

describe("answered", () => {
  it("leaves out an attempt a take-over replaced, and keeps the retry", () => {
    const rows = answered([
      task({ id: "bt-1", status: "stopped", output: null, error: "cancelled" }),
      task({ id: "bt-2", retry_of: "bt-1", output: "after sign-in: 3 messages" }),
    ]);
    expect(rows).toEqual([{ task: task().task, answer: "after sign-in: 3 messages" }]);
  });

  it("says why a task did not finish", () => {
    const [row] = answered([task({ status: "failed", output: null, error: "a login wall" })]);
    expect(row.answer).toBe("(did not finish: a login wall)");
  });
});

describe("composeReport", () => {
  it("appends the answers to the draft when the model call fails", async () => {
    complete.mockRejectedValue(new Error("provider down"));
    const result = await composeReport(env, {
      model: "gpt-4.1-mini",
      instruction: "x",
      draft: "Draft.",
      answers: [{ task: "read it", answer: "it said hello" }],
    });
    expect(result.text).toContain("Draft.");
    expect(result.text).toContain("it said hello");
    expect(result.usage).toBeNull();
  });

  it("makes no call when there is nothing to write in", async () => {
    const result = await composeReport(env, {
      model: "m",
      instruction: "x",
      draft: "Draft.",
      answers: [],
    });
    expect(result.text).toBe("Draft.");
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("sweepHeldRuns", () => {
  it("finishes the runs that waited too long", async () => {
    const { db, calls } = fakeDb((call) => {
      if (call.table === "routine_runs" && call.op === "select") {
        return { data: [{ id: "run-1" }], error: null };
      }
      if (call.table === "browser_tasks")
        return { data: [task({ status: "running" })], error: null };
      if (call.table === "routine_runs" && call.op === "update") return { data: RUN, error: null };
      if (call.table === "routines") return { data: ROUTINE, error: null };
      if (call.table === "agents") return { data: { model: null }, error: null };
      if (call.table === "delivery_channels") return { data: { id: "chan-1" }, error: null };
      return { data: null, error: null };
    });

    const now = () => new Date("2026-10-15T09:00:00.000Z");
    expect(await sweepHeldRuns(env, { db, now })).toEqual({ finished: 1 });
    const read = calls[0];
    expect(read.filters).toContainEqual(["eq", ["status", "waiting"]]);
    expect(read.filters).toContainEqual(["lt", ["started_at", "2026-10-15T07:00:00.000Z"]]);
    expect(deliver).toHaveBeenCalledOnce();
    // The chain is cut (0142): a run sent without it has no wake-up to run into.
    expect(cancelContinuations).toHaveBeenCalledWith(db, "run-1", expect.any(Date));
    expect(cancelContinuations.mock.invocationCallOrder[0]).toBeLessThan(
      deliver.mock.invocationCallOrder[0],
    );
  });
});

describe("openRoutineConversation", () => {
  const routine = () => ({ ...ROUTINE, browser_conversation_id: null as string | null });

  it("reuses the conversation the routine already has", async () => {
    const { db, calls } = fakeDb((call) =>
      call.table === "chat_sessions"
        ? { data: { id: "conv-1" }, error: null }
        : { data: null, error: null },
    );
    const r = { ...routine(), browser_conversation_id: "conv-1" };

    expect(await openRoutineConversation(db, r)).toBe("conv-1");
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("opens the owner's own private conversation, and remembers it", async () => {
    const { db, calls } = fakeDb((call) =>
      call.table === "chat_sessions" && call.op === "insert"
        ? { data: { id: "conv-2" }, error: null }
        : { data: null, error: null },
    );
    const r = routine();

    expect(await openRoutineConversation(db, r)).toBe("conv-2");
    const opened = calls.find((c) => c.table === "chat_sessions" && c.op === "insert");
    expect(opened?.payload).toMatchObject({
      agent_id: "agent-1",
      user_id: "user-1",
      workspace_id: "ws-1",
      visibility: "private",
      title: "Routine: Morning prices",
    });
    const linked = calls.find((c) => c.table === "routines" && c.op === "update");
    expect(linked?.payload).toEqual({ browser_conversation_id: "conv-2" });
    expect(r.browser_conversation_id).toBe("conv-2");
  });
});
