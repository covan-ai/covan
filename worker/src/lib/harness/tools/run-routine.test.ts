import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { memoryDb, type Row } from "../../../test-support/memory-db";
import type { ToolContext } from "../registry";

const runPokedRoutine = vi.fn(
  async (..._args: unknown[]): Promise<{ status: string; itemsNew: number; summary?: string }> => ({
    status: "ok",
    itemsNew: 1,
    summary: "Forty orders yesterday.",
  }),
);
vi.mock("../../routines/dispatcher", () => ({
  runPokedRoutine: (...args: unknown[]) => runPokedRoutine(...args),
}));

const { runRoutineTool, MAX_CHAIN_DEPTH } = await import("./run-routine");

const routine = (over: Row = {}): Row => ({
  id: "r2",
  user_id: "u1",
  workspace_id: "w1",
  name: "Order digest",
  source_kind: "none",
  status: "active",
  deleted_at: null,
  ...over,
});

function ctx(rows: Row[], over: Partial<ToolContext> = {}): ToolContext {
  return {
    db: memoryDb({ routines: rows }).db as unknown as SupabaseClient,
    env: {} as never,
    workspaceId: "w1",
    agentId: "a1",
    userId: "u1",
    ...over,
  };
}

const ARGS = { routineId: "r2", payload: "Summarise yesterday's orders." };

beforeEach(() => runPokedRoutine.mockClear());

describe("run_routine", () => {
  it("asks in a conversation before starting anything", async () => {
    const out = await runRoutineTool.run(ARGS, ctx([routine()]));
    expect(out).toMatchObject({
      kind: "needs_confirmation",
      proposal: { kind: "run_routine", routine: { id: "r2", name: "Order digest" } },
    });
    expect(runPokedRoutine).not.toHaveBeenCalled();
  });

  it("runs it once approved, one step deep, and hands back its report", async () => {
    const out = await runRoutineTool.run(ARGS, ctx([routine()], { confirmed: true }));
    expect(out).toMatchObject({
      kind: "ok",
      content: expect.stringContaining("Forty orders yesterday."),
    });
    const [, ran, trigger] = runPokedRoutine.mock.calls[0] as [
      unknown,
      Row,
      Record<string, unknown>,
    ];
    expect(ran.id).toBe("r2");
    expect(trigger).toMatchObject({
      payload: "Summarise yesterday's orders.",
      source: "event",
      label: "Started from a conversation",
      depth: 1,
    });
    expect(String(trigger.eventId)).toMatch(/^agent:/);
  });

  it("runs without a card on a scheduled run, a step deeper than the run it is in", async () => {
    await runRoutineTool.run(ARGS, ctx([routine()], { routineRunId: "run-1", chainDepth: 1 }));
    expect(runPokedRoutine.mock.calls[0][2]).toMatchObject({
      label: "Started by another routine",
      depth: 2,
    });
  });

  it("refuses to go deeper than the limit", async () => {
    const out = await runRoutineTool.run(
      ARGS,
      ctx([routine()], { routineRunId: "run-1", chainDepth: MAX_CHAIN_DEPTH }),
    );
    expect(out).toMatchObject({ kind: "error", message: expect.stringMatching(/could loop/) });
    expect(runPokedRoutine).not.toHaveBeenCalled();
  });

  it("starts only the person's own, running routines that have no source", async () => {
    const confirmed = { confirmed: true };
    for (const rows of [
      [routine({ user_id: "someone-else" })],
      [routine({ workspace_id: "w2" })],
      [routine({ deleted_at: "2026-10-16T00:00:00Z" })],
      [],
    ]) {
      expect(await runRoutineTool.run(ARGS, ctx(rows, confirmed))).toMatchObject({
        kind: "error",
        message: "no such routine belongs to this person",
      });
    }
    expect(
      await runRoutineTool.run(ARGS, ctx([routine({ status: "paused" })], confirmed)),
    ).toMatchObject({
      kind: "error",
    });
    expect(
      await runRoutineTool.run(ARGS, ctx([routine({ source_kind: "rss" })], confirmed)),
    ).toMatchObject({
      kind: "error",
      message: expect.stringMatching(/source of its own/),
    });
    expect(runPokedRoutine).not.toHaveBeenCalled();
  });

  it("says a failed run failed", async () => {
    runPokedRoutine.mockResolvedValueOnce({ status: "failed", itemsNew: 0 });
    expect(await runRoutineTool.run(ARGS, ctx([routine()], { confirmed: true }))).toMatchObject({
      kind: "error",
    });
  });

  it("runs without a card in a woken turn, where nobody is watching (0142)", async () => {
    const out = await runRoutineTool.run(
      ARGS,
      ctx([routine()], { continuation: { id: "cont-1", browserApproved: false } }),
    );
    expect(out.kind).toBe("ok");
    expect(runPokedRoutine).toHaveBeenCalledTimes(1);
  });
});
