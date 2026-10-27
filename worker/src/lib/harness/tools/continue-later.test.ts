import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ToolContext } from "../registry";

const scheduleContinuation = vi.fn(
  async (
    ..._args: unknown[]
  ): Promise<{ kind: "ok"; id: string; wakeAt: Date } | { kind: "refused"; message: string }> => ({
    kind: "ok",
    id: "c-1",
    wakeAt: new Date("2026-10-27T12:15:00.000Z"),
  }),
);
vi.mock("../../continuations/rows", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../continuations/rows")>();
  return { ...actual, scheduleContinuation: (...a: unknown[]) => scheduleContinuation(...a) };
});

const { continueLaterTool } = await import("./continue-later");
const { toolByName } = await import("../registry");

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    db: {} as unknown as SupabaseClient,
    env: {} as never,
    workspaceId: "w1",
    agentId: "a1",
    userId: "u1",
    sessionId: "s1",
    ...over,
  };
}

beforeEach(() => scheduleContinuation.mockClear());

describe("continue_later", () => {
  it("is listed as a tool that changes nothing outside Covan", () => {
    const tool = toolByName("continue_later");
    expect(tool).not.toBeNull();
    expect(tool?.destructive).toBe(false);
    expect(tool?.isConfigured({} as never)).toBe(true);
  });

  it("refuses a bad wait", async () => {
    for (const args of [
      { minutes: 3, note: "open the link" },
      { minutes: 721, note: "open the link" },
      { minutes: 7.5, note: "open the link" },
      { minutes: 15, note: "   " },
      { minutes: "15", note: "open the link" },
    ]) {
      const out = await continueLaterTool.run(args, ctx());
      expect(out.kind).toBe("error");
    }
    expect(scheduleContinuation).not.toHaveBeenCalled();
  });

  it("needs a conversation to come back to", async () => {
    const out = await continueLaterTool.run(
      { minutes: 15, note: "open the link" },
      ctx({ sessionId: undefined, routineRunId: "run-1" }),
    );
    expect(out).toMatchObject({
      kind: "error",
      message: expect.stringContaining("no conversation to come back to"),
    });
    expect(scheduleContinuation).not.toHaveBeenCalled();
  });

  it("a routine's own turn sets a timer only after a browser task", async () => {
    const browser = {
      access: "all" as const,
      site: null,
      conversation: async () => "sess-routine",
      started: [] as string[],
    };
    const early = await continueLaterTool.run(
      { minutes: 15, note: "look again" },
      ctx({ sessionId: undefined, routineRunId: "run-1", routineBrowser: browser }),
    );
    expect(early).toMatchObject({
      kind: "error",
      message: expect.stringContaining("start the browser task first"),
    });
    expect(scheduleContinuation).not.toHaveBeenCalled();

    const later = await continueLaterTool.run(
      { minutes: 15, note: "look again" },
      ctx({
        sessionId: undefined,
        routineRunId: "run-1",
        routineBrowser: { ...browser, started: ["t1"] },
      }),
    );
    expect(later.kind).toBe("ok");
    expect(scheduleContinuation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sessionId: "sess-routine", routineRunId: "run-1", minutes: 15 }),
    );
  });

  it("a woken routine turn may set a timer with nothing started yet", async () => {
    const out = await continueLaterTool.run(
      { minutes: 15, note: "look again" },
      ctx({
        sessionId: "sess-routine",
        routineRunId: "run-1",
        continuation: { id: "c-0", browserApproved: true },
        routineBrowser: {
          access: "all",
          site: null,
          conversation: async () => "sess-routine",
          started: [],
        },
      }),
    );
    expect(out.kind).toBe("ok");
  });

  it("writes the row from the turn's own ids and the model's two values", async () => {
    await continueLaterTool.run({ minutes: 15, note: "  open the link  " }, ctx());
    expect(scheduleContinuation).toHaveBeenCalledWith(expect.anything(), {
      workspaceId: "w1",
      agentId: "a1",
      userId: "u1",
      sessionId: "s1",
      routineRunId: null,
      minutes: 15,
      note: "open the link",
    });
  });

  it("tells the model the turn ends and when it wakes", async () => {
    const out = await continueLaterTool.run({ minutes: 15, note: "open the link" }, ctx());
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.content).toContain("15 minutes");
    expect(out.content).toContain("12:15 UTC");
    expect(out.content).toContain("do not call continue_later again");
  });

  it("passes a refusal on as an error", async () => {
    scheduleContinuation.mockResolvedValueOnce({ kind: "refused", message: "too many today" });
    const out = await continueLaterTool.run({ minutes: 15, note: "open the link" }, ctx());
    expect(out).toEqual({ kind: "error", message: "too many today" });
  });
});
