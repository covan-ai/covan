import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { settleApprovals } from "./dispatch";

const env = {} as RoutineEnv;

function db(rpc: Record<string, { data: unknown; error?: { code: string } | null }>) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  return {
    calls,
    db: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push([name, args]);
        const answer = rpc[name] ?? { data: [] };
        return { data: answer.data, error: answer.error ?? null };
      },
    } as unknown as SupabaseClient,
  };
}

const ANSWERED = {
  id: "pause-1",
  origin: "routine",
  routine_run_id: "run-1",
  session_id: "conv-1",
  message_id: "msg-1",
  workspace_id: "ws-1",
  agent_id: "agent-1",
  user_id: "owner-1",
  tool: "http_request",
  tool_call: { id: "call_1", name: "http_request", arguments: "{}" },
  summary: "POST to Box office?",
  proposal: null,
  messages: [],
  steps: [],
  model: "gpt-4.1",
  status: "approved",
  expires_at: "2026-11-14T03:00:00.000Z",
};

describe("settleApprovals", () => {
  it("carries on with the one answered request the claim handed over", async () => {
    const { db: d, calls } = db({ claim_answered_approvals: { data: [ANSWERED] } });
    const resume = vi.fn(async () => ({ kind: "carried_on" as const }));
    const note = vi.fn();

    expect(await settleApprovals(env, { db: d, resume, note })).toEqual({ settled: 1 });

    expect(calls).toContainEqual(["claim_answered_approvals", { p_limit: 1 }]);
    const [, pause] = resume.mock.calls[0] as unknown as [unknown, Record<string, unknown>];
    expect(pause).toMatchObject({
      id: "pause-1",
      origin: "routine",
      routineRunId: "run-1",
      status: "approved",
    });
    expect(note).not.toHaveBeenCalled();
  });

  it("settles what expired, or was cut off, with a note and nothing run", async () => {
    const ended = [
      {
        id: "pause-2",
        reason: "expired",
        workspace_id: "ws-1",
        user_id: "owner-1",
        session_id: "conv-1",
        message_id: "msg-2",
        routine_run_id: "run-2",
        origin: "routine",
        summary: "POST to Box office?",
      },
      {
        id: "pause-3",
        reason: "interrupted",
        workspace_id: "ws-1",
        user_id: "owner-1",
        session_id: "conv-2",
        message_id: "msg-3",
        routine_run_id: null,
        origin: "wake",
        summary: null,
      },
    ];
    const { db: d } = db({ expire_unattended_approvals: { data: ended } });
    const resume = vi.fn();
    const note = vi.fn(async (..._args: unknown[]) => ({ kind: "noted" as const, note: "" }));

    expect(await settleApprovals(env, { db: d, resume, note })).toEqual({ settled: 2 });

    expect(note).toHaveBeenCalledTimes(2);
    expect(note.mock.calls[0]).toEqual([
      env,
      expect.objectContaining({ id: "pause-2", routineRunId: "run-2", messageId: "msg-2" }),
      "expired",
      expect.anything(),
    ]);
    expect(note.mock.calls[1][2]).toBe("interrupted");
    expect((note.mock.calls[1][1] as { summary: string }).summary).toBe("");
    expect(resume).not.toHaveBeenCalled();
  });

  it("costs an idle tick its two claims and nothing else", async () => {
    const { db: d, calls } = db({});
    expect(await settleApprovals(env, { db: d, resume: vi.fn(), note: vi.fn() })).toEqual({
      settled: 0,
    });
    expect(calls.map(([name]) => name)).toEqual([
      "expire_unattended_approvals",
      "claim_answered_approvals",
    ]);
  });

  it("goes on when a claim fails, and when a resume throws", async () => {
    const { db: d } = db({
      expire_unattended_approvals: { data: null, error: { code: "57014" } },
      claim_answered_approvals: { data: [ANSWERED] },
    });
    const resume = vi.fn(async () => {
      throw new Error("provider down");
    });
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await settleApprovals(env, { db: d, resume, note: vi.fn() })).toEqual({ settled: 1 });
    quiet.mockRestore();
  });
});
