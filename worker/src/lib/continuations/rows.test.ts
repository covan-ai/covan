import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { memoryDb, type Row } from "../../test-support/memory-db";
import { HELD_MAX_MS } from "../routines/held";
import {
  cancelContinuations,
  chainPending,
  MAX_WAKEUPS_PER_DAY,
  scheduleContinuation,
  settleContinuation,
  UNWATCHED_STEP_WINDOW_MS,
} from "./rows";

const ENV = {} as RoutineEnv;
const NOW = new Date("2026-10-27T12:00:00.000Z");

function at(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

const IDS = {
  workspaceId: "ws-1",
  agentId: "agent-1",
  userId: "user-1",
  sessionId: "sess-1",
};

function store(seed: Partial<Record<string, Row[]>> = {}) {
  return memoryDb({
    continuations: [],
    routine_runs: [],
    browser_tasks: [],
    ...seed,
  });
}

function deps(db: ReturnType<typeof memoryDb>) {
  return { db: db.db as unknown as SupabaseClient, now: () => NOW };
}

describe("scheduleContinuation", () => {
  it("refuses a wait outside the bounds", async () => {
    const db = store();
    for (const minutes of [4, 721]) {
      const out = await scheduleContinuation(
        ENV,
        { ...IDS, minutes, note: "open the link" },
        deps(db),
      );
      expect(out.kind).toBe("refused");
      if (out.kind === "refused") expect(out.message).toMatch(/5.*720/);
    }
    expect(db.tables.continuations).toHaveLength(0);
  });

  it("writes the row from the turn's own ids", async () => {
    const db = store();
    const out = await scheduleContinuation(
      ENV,
      { ...IDS, minutes: 15, note: "open the link" },
      deps(db),
    );
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.wakeAt.toISOString()).toBe(at(15));
    expect(db.tables.continuations).toHaveLength(1);
    const row = db.tables.continuations[0];
    expect(row).toMatchObject({
      id: out.id,
      workspace_id: "ws-1",
      agent_id: "agent-1",
      user_id: "user-1",
      session_id: "sess-1",
      routine_run_id: null,
      note: "open the link",
      wake_at: at(15),
      status: "waiting",
      depth: 1,
    });
  });

  it("refuses the 25th wake-up in a day", async () => {
    const earlier = Array.from({ length: MAX_WAKEUPS_PER_DAY }, (_, i) => ({
      id: `c-${i}`,
      session_id: "sess-1",
      status: "done",
      created_at: at(-60),
    }));
    const db = store({
      continuations: [
        ...earlier,
        // Yesterday's do not count.
        { id: "c-old", session_id: "sess-1", status: "done", created_at: at(-25 * 60) },
        // Another conversation's do not count.
        { id: "c-other", session_id: "sess-2", status: "waiting", created_at: at(-1) },
      ],
    });
    const out = await scheduleContinuation(
      ENV,
      { ...IDS, minutes: 15, note: "open the link" },
      deps(db),
    );
    expect(out.kind).toBe("refused");
    if (out.kind === "refused") expect(out.message).toMatch(/24/);
  });

  it("counts the day's wake-ups into depth", async () => {
    const db = store({
      continuations: [
        { id: "c-1", session_id: "sess-1", status: "done", created_at: at(-30) },
        { id: "c-2", session_id: "sess-1", status: "done", created_at: at(-15) },
      ],
    });
    const out = await scheduleContinuation(
      ENV,
      { ...IDS, minutes: 15, note: "open the link" },
      deps(db),
    );
    expect(out.kind).toBe("ok");
    expect(db.tables.continuations.at(-1)).toMatchObject({ depth: 3 });
  });

  it("keeps a routine's wake-up inside the held window", async () => {
    const db = store({
      routine_runs: [{ id: "run-1", started_at: at(-100), status: "waiting" }],
    });
    const late = await scheduleContinuation(
      ENV,
      { ...IDS, routineRunId: "run-1", minutes: 15, note: "look again" },
      deps(db),
    );
    expect(late.kind).toBe("refused");
    if (late.kind === "refused") expect(late.message).toMatch(/10 minutes/);

    const inTime = await scheduleContinuation(
      ENV,
      { ...IDS, routineRunId: "run-1", minutes: 5, note: "look again" },
      deps(db),
    );
    expect(inTime.kind).toBe("ok");
    expect(db.tables.continuations[0]).toMatchObject({ routine_run_id: "run-1" });
  });

  it("refuses a routine's wake-up when no time is left", async () => {
    const db = store({
      routine_runs: [{ id: "run-1", started_at: at(-115), status: "waiting" }],
    });
    const out = await scheduleContinuation(
      ENV,
      { ...IDS, routineRunId: "run-1", minutes: 5, note: "look again" },
      deps(db),
    );
    expect(out.kind).toBe("refused");
    if (out.kind === "refused") expect(out.message).toMatch(/no time left/);
  });
});

describe("chainPending", () => {
  const db = (seed: Partial<Record<string, Row[]>>) =>
    store(seed).db as unknown as SupabaseClient;

  it("is pending while a wake-up waits", async () => {
    const d = db({
      continuations: [{ id: "c-1", routine_run_id: "run-1", status: "waiting" }],
    });
    expect(await chainPending(d, "run-1", NOW)).toBe(true);
  });

  it("is pending while a wake-up runs", async () => {
    const d = db({
      continuations: [{ id: "c-1", routine_run_id: "run-1", status: "running" }],
    });
    expect(await chainPending(d, "run-1", NOW)).toBe(true);
  });

  it("is not pending once every wake-up is done", async () => {
    const d = db({
      continuations: [
        { id: "c-1", routine_run_id: "run-1", status: "done" },
        { id: "c-2", routine_run_id: "run-2", status: "waiting" },
      ],
    });
    expect(await chainPending(d, "run-1", NOW)).toBe(false);
  });

  it("is pending while a finished task's step is unclaimed and fresh", async () => {
    const task = {
      id: "t-1",
      routine_run_id: "run-1",
      status: "finished",
      then_step: "post it",
      continued_at: null,
      delivered_at: at(-10),
    };
    expect(await chainPending(db({ browser_tasks: [task] }), "run-1", NOW)).toBe(true);
    expect(
      await chainPending(db({ browser_tasks: [{ ...task, delivered_at: at(-180) }] }), "run-1", NOW),
    ).toBe(false);
    expect(
      await chainPending(db({ browser_tasks: [{ ...task, continued_at: at(-1) }] }), "run-1", NOW),
    ).toBe(false);
    expect(
      await chainPending(db({ browser_tasks: [{ ...task, then_step: null }] }), "run-1", NOW),
    ).toBe(false);
    expect(
      await chainPending(db({ browser_tasks: [{ ...task, delivered_at: null }] }), "run-1", NOW),
    ).toBe(false);
  });

  it("agrees with the held window", () => {
    expect(UNWATCHED_STEP_WINDOW_MS).toBe(HELD_MAX_MS);
  });
});

describe("cancelContinuations and settleContinuation", () => {
  it("cancels only the run's open wake-ups", async () => {
    const d = store({
      continuations: [
        { id: "c-1", routine_run_id: "run-1", status: "waiting" },
        { id: "c-2", routine_run_id: "run-1", status: "running" },
        { id: "c-3", routine_run_id: "run-1", status: "done" },
        { id: "c-4", routine_run_id: "run-2", status: "waiting" },
      ],
    });
    await cancelContinuations(d.db as unknown as SupabaseClient, "run-1", NOW);
    const byId = Object.fromEntries(d.tables.continuations.map((r) => [r.id, r.status]));
    expect(byId).toEqual({ "c-1": "cancelled", "c-2": "cancelled", "c-3": "done", "c-4": "waiting" });
    expect(d.tables.continuations[0]).toMatchObject({ finished_at: NOW.toISOString() });
  });

  it("settles by id", async () => {
    const d = store({
      continuations: [
        { id: "c-1", status: "running" },
        { id: "c-2", status: "running" },
      ],
    });
    await settleContinuation(d.db as unknown as SupabaseClient, "c-1", { status: "done" }, NOW);
    await settleContinuation(
      d.db as unknown as SupabaseClient,
      "c-2",
      { status: "failed", error: "no credits" },
      NOW,
    );
    expect(d.tables.continuations[0]).toMatchObject({
      status: "done",
      finished_at: NOW.toISOString(),
      error: null,
    });
    expect(d.tables.continuations[1]).toMatchObject({ status: "failed", error: "no credits" });
  });
});
