import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { memoryDb, type Row } from "../../test-support/memory-db";
import type { AgentTurn } from "../harness/loop";
import type { AnsweredCall } from "../harness/resume";
import type { StoredPause } from "../harness/turn";

const { agentAccessFor } = vi.hoisted(() => ({
  agentAccessFor: vi.fn(async (..._args: unknown[]): Promise<string | null> => "use"),
}));
vi.mock("../agent-access", () => ({
  agentAccessFor: (...args: unknown[]) => agentAccessFor(...args),
}));

import { noteFor, resumeApproved, settleWithNote, type ResumeDeps } from "./resume";

const env = { OPENAI_API_KEY: "sk-test" } as unknown as RoutineEnv;
const NOW = new Date("2026-11-13T03:10:00.000Z");

/** A routine's request, asked at 03:00 while nobody was watching, answered yes. */
const PAUSE: StoredPause = {
  id: "pause-1",
  origin: "routine",
  routineRunId: "run-1",
  sessionId: "conv-1",
  messageId: "msg-1",
  workspaceId: "ws-1",
  agentId: "agent-1",
  userId: "owner-1",
  tool: "http_request",
  toolCall: {
    id: "call_1",
    name: "http_request",
    arguments: '{"method":"POST","path":"/seats/14/close"}',
  },
  summary: "POST to Box office?",
  proposal: { kind: "http_request", method: "POST", path: "/seats/14/close" },
  messages: [
    { role: "system", content: "You are running a scheduled routine." },
    { role: "user", content: "Close the seat the mail asks about." },
  ],
  steps: [
    {
      index: 0,
      tool: "find_tool",
      request: { query: "send an email" },
      resultExcerpt: "GMAIL_SEND_EMAIL",
      offered: ["GMAIL_SEND_EMAIL"],
      status: "ok",
      durationMs: 2,
    },
    {
      index: 1,
      tool: "http_request",
      request: { method: "POST", path: "/seats/14/close" },
      resultExcerpt: "POST to Box office?",
      status: "pending",
      durationMs: 3,
    },
  ],
  model: "gpt-4.1",
  usage: null,
  grounding: null,
  sources: null,
  status: "approved",
  expiresAt: "2026-11-14T03:00:00.000Z",
};

function world(over: Partial<Record<string, Row[]>> = {}) {
  return memoryDb({
    chat_sessions: [{ id: "conv-1", user_id: "owner-1", visibility: "private", deleted_at: null }],
    workspace_members: [{ workspace_id: "ws-1", user_id: "owner-1", role: "member" }],
    agents: [
      {
        id: "agent-1",
        workspace_id: "ws-1",
        model: "gpt-4.1",
        temperature: null,
        reasoning_effort: null,
        web_search: false,
        deleted_at: null,
      },
    ],
    routine_runs: [
      {
        id: "run-1",
        routine_id: "routine-1",
        status: "waiting",
        waiting_for: "approval",
        summary: "A mail asked to close seat 14.",
      },
    ],
    routines: [
      {
        id: "routine-1",
        user_id: "owner-1",
        visibility: "private",
        browser_access: "off",
        timezone: "Europe/Istanbul",
        status: "active",
        deleted_at: null,
      },
    ],
    messages: [
      {
        id: "msg-1",
        session_id: "conv-1",
        content: "A mail asked to close seat 14.",
        prompt_tokens: 100,
        completion_tokens: 20,
      },
    ],
    message_steps: [],
    paused_turns: [
      { id: "pause-1", status: "approved", resumed_at: null, routine_run_id: "run-1" },
    ],
    ...over,
  });
}

function turnSaying(text: string, over: Partial<AgentTurn> = {}): AgentTurn {
  return {
    text,
    usage: {
      promptTokens: 50,
      completionTokens: 10,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
      webSearches: null,
    },
    steps: [],
    passes: [],
    finishReason: "stop",
    ...over,
  };
}

function answered(over: Partial<AnsweredCall> = {}): AnsweredCall {
  return {
    steps: [PAUSE.steps[0], { ...PAUSE.steps[1], status: "ok", resultExcerpt: "closed" }],
    messages: [...PAUSE.messages, { role: "tool", toolCallId: "call_1", content: "closed" }],
    tools: [],
    asked: null,
    ran: true,
    ...over,
  };
}

function deps(db: ReturnType<typeof memoryDb>, over: Partial<ResumeDeps> = {}) {
  return {
    db: db.db as unknown as SupabaseClient,
    now: () => NOW,
    answer: vi.fn(async () => answered()),
    turn: vi.fn(async () => turnSaying("Seat 14 is closed.")),
    capabilities: vi.fn(async () => ({ tools: [], manifest: "" })),
    entitlements: {
      check: vi.fn(async () => ({ allowed: true })),
      record: vi.fn(async () => {}),
    },
    completeHeld: vi.fn(async () => true),
    nudge: vi.fn(async () => {}),
    ...over,
  } as unknown as ResumeDeps & {
    answer: ReturnType<typeof vi.fn>;
    turn: ReturnType<typeof vi.fn>;
    completeHeld: ReturnType<typeof vi.fn>;
    nudge: ReturnType<typeof vi.fn>;
    entitlements: { check: ReturnType<typeof vi.fn>; record: ReturnType<typeof vi.fn> };
  };
}

beforeEach(() => {
  agentAccessFor.mockReset();
  agentAccessFor.mockResolvedValue("use");
});

describe("resumeApproved", () => {
  it("runs the approved call once, finishes the turn, and sends the report with both halves", async () => {
    const db = world();
    const d = deps(db);

    expect(await resumeApproved(env, PAUSE, d)).toEqual({ kind: "carried_on" });

    expect(d.answer).toHaveBeenCalledOnce();
    const asked = d.answer.mock.calls[0][0] as { approve: boolean; ctx: Record<string, unknown> };
    expect(asked.approve).toBe(true);
    // The approved call runs confirmed, as the owner, marked as a run.
    expect(asked.ctx).toMatchObject({
      confirmed: true,
      userId: "owner-1",
      routineRunId: "run-1",
      sessionId: "conv-1",
    });
    // The rest of the turn asks again for anything else.
    const ran = d.turn.mock.calls[0][0] as { ctx: Record<string, unknown> };
    expect(ran.ctx.confirmed).toBe(false);
    // And keeps what the first half's own searches offered.
    expect([...(ran.ctx.offeredSlugs as Set<string>)]).toEqual(["GMAIL_SEND_EMAIL"]);

    // One reply, two halves, what each spent added.
    const reply = db.tables.messages[0];
    expect(reply.content).toBe("A mail asked to close seat 14.\n\nSeat 14 is closed.");
    expect(reply.prompt_tokens).toBe(150);

    expect(db.tables.paused_turns[0].resumed_at).toBe(NOW.toISOString());
    expect(db.tables.routine_runs[0]).toMatchObject({
      summary: "A mail asked to close seat 14.\n\nSeat 14 is closed.",
      waiting_for: null,
    });
    // Composed from the new draft rather than sent as written, so a browser
    // answer that came in while the run waited on a person is not lost.
    expect(d.completeHeld).toHaveBeenCalledWith(env, "run-1", expect.anything());
    expect(d.completeHeld.mock.calls[0]).toHaveLength(3);
    expect(db.tables.routine_runs[0].held_until).toBeNull();
    expect(d.entitlements.record).toHaveBeenCalledWith(
      "ws-1",
      expect.any(Array),
      expect.objectContaining({ routineRunId: "run-1", messageId: "msg-1" }),
    );
  });

  // A day can pass between the question and the answer; each of these is a
  // "no" that the yes cannot override, and none of them runs anything.
  for (const [what, over, check] of [
    [
      "the routine was paused",
      {
        routines: [
          {
            id: "routine-1",
            user_id: "owner-1",
            status: "paused",
            deleted_at: null,
          },
        ],
      },
      /no longer on/,
    ],
    ["the conversation was deleted", { chat_sessions: [] }, /conversation is gone/],
    ["the owner left the workspace", { workspace_members: [] }, /no longer in this workspace/],
    [
      "the run already finished",
      { routine_runs: [{ id: "run-1", routine_id: "routine-1", status: "ok", summary: "" }] },
      /already finished/,
    ],
  ] as const) {
    it(`does nothing when ${what}, and says so`, async () => {
      const db = world(over as unknown as Partial<Record<string, Row[]>>);
      const d = deps(db);

      const out = await resumeApproved(env, PAUSE, d);

      expect(out.kind).toBe("noted");
      if (out.kind === "noted") expect(out.note).toMatch(check);
      expect(d.answer).not.toHaveBeenCalled();
      expect(d.turn).not.toHaveBeenCalled();
      expect(db.tables.paused_turns[0].resumed_at).toBe(NOW.toISOString());
    });
  }

  it("does nothing when the owner can no longer use the agent", async () => {
    agentAccessFor.mockResolvedValue(null);
    const d = deps(world());
    const out = await resumeApproved(env, PAUSE, d);
    expect(out.kind).toBe("noted");
    expect(d.answer).not.toHaveBeenCalled();
  });

  it("does nothing when the workspace has no credits", async () => {
    const d = deps(world());
    d.entitlements.check.mockResolvedValue({ allowed: false });
    const out = await resumeApproved(env, PAUSE, d);
    expect(out.kind).toBe("noted");
    if (out.kind === "noted") expect(out.note).toMatch(/no credits/);
    expect(d.answer).not.toHaveBeenCalled();
  });

  it("settles a no with a line and no model call", async () => {
    const db = world();
    const d = deps(db);

    const out = await resumeApproved(env, { ...PAUSE, status: "declined" }, d);

    expect(out).toEqual({ kind: "noted", note: noteFor("declined", PAUSE.summary) });
    expect(d.answer).not.toHaveBeenCalled();
    expect(d.turn).not.toHaveBeenCalled();
    expect(String(db.tables.messages[0].content)).toContain("was declined");
    expect(d.completeHeld).toHaveBeenCalledOnce();
  });

  it("parks again when the rest of the turn asks about something else", async () => {
    const db = world();
    const d = deps(db, {
      turn: vi.fn(async () =>
        turnSaying("Closed. One more:", {
          paused: {
            reason: "confirmation",
            messages: PAUSE.messages,
            call: { id: "call_2", name: "http_request", arguments: "{}" },
            summary: "POST to Box office again?",
            proposal: null,
          },
        }),
      ),
    } as Partial<ResumeDeps>);

    expect(await resumeApproved(env, PAUSE, d)).toEqual({ kind: "asked_again" });

    const parked = db.tables.paused_turns.find((p) => p.id !== "pause-1");
    expect(parked).toMatchObject({
      origin: "routine",
      routine_run_id: "run-1",
      session_id: "conv-1",
      message_id: "msg-1",
      summary: "POST to Box office again?",
    });
    // A day, not the conversation's hour.
    expect(parked?.expires_at).toBe("2026-11-14T03:10:00.000Z");
    // The report waits for the second answer.
    expect(d.completeHeld).not.toHaveBeenCalled();
    expect(db.tables.paused_turns[0].resumed_at).toBe(NOW.toISOString());
  });

  it("tells the owner when a woken conversation carried on", async () => {
    const db = world();
    const d = deps(db);
    const wake: StoredPause = { ...PAUSE, origin: "wake", routineRunId: null };

    expect(await resumeApproved(env, wake, d)).toEqual({ kind: "carried_on" });

    const asked = d.answer.mock.calls[0][0] as { ctx: Record<string, unknown> };
    expect(asked.ctx.routineRunId).toBeUndefined();
    expect(asked.ctx.continuation).toEqual({ id: "approval:pause-1", browserApproved: false });
    expect(d.nudge).toHaveBeenCalledOnce();
    expect(d.completeHeld).not.toHaveBeenCalled();
  });
});

describe("settleWithNote", () => {
  it("writes why under the reply and sends the report with it", async () => {
    const db = world({
      paused_turns: [{ id: "pause-1", status: "expired", resumed_at: NOW.toISOString() }],
    });
    const d = deps(db);

    await settleWithNote(
      env,
      {
        id: "pause-1",
        origin: "routine",
        workspaceId: "ws-1",
        userId: "owner-1",
        sessionId: "conv-1",
        messageId: "msg-1",
        routineRunId: "run-1",
        summary: "POST to Box office?",
      },
      "expired",
      d,
    );

    const line = noteFor("expired", "POST to Box office?");
    expect(line).toMatch(/Nobody answered within 24 hours/);
    expect(db.tables.messages[0].content).toBe(`A mail asked to close seat 14.\n\n${line}`);
    expect(db.tables.routine_runs[0].summary).toBe(`A mail asked to close seat 14.\n\n${line}`);
    expect(d.completeHeld).toHaveBeenCalledWith(env, "run-1", expect.anything());
  });

  it("does not call a later question approved when it could not be asked", () => {
    const line = noteFor({ unasked: "it had already asked 5 times on this run" }, "Delete it?");
    expect(line).toContain("could not be asked");
    expect(line).not.toContain("approved");
  });

  it("says a cut-off resume may have happened, rather than running it again", () => {
    expect(noteFor("interrupted", "POST to Box office?")).toMatch(
      /approved, but carrying on was cut off. Check whether it happened/,
    );
  });
});
