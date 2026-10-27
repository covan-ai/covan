import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import type { AgentTurn, AgentTurnOptions } from "../harness/loop";
import type { Entitlements } from "../entitlements";
import { memoryDb, type Row } from "../../test-support/memory-db";

const writeSteps = vi.fn(async (..._args: unknown[]): Promise<void> => {});
vi.mock("../harness/turn", () => ({
  writeSteps: (...args: unknown[]) => writeSteps(...args),
}));

const completeHeldRun = vi.fn(async (..._args: unknown[]): Promise<boolean> => true);
vi.mock("../routines/held", () => ({
  completeHeldRun: (...args: unknown[]) => completeHeldRun(...args),
}));

const nudge = vi.fn(async (..._args: unknown[]): Promise<void> => {});
vi.mock("../browser/deliver", () => ({
  nudge: (...args: unknown[]) => nudge(...args),
}));

const browserTaskNote = vi.fn(async (..._args: unknown[]): Promise<string | null> => null);
vi.mock("../browser/task-note", () => ({
  browserTaskNote: (...args: unknown[]) => browserTaskNote(...args),
}));

const agentAccessFor = vi.fn(async (..._args: unknown[]): Promise<string | null> => "use");
vi.mock("../agent-access", () => ({
  agentAccessFor: (...args: unknown[]) => agentAccessFor(...args),
}));

const { CARRY_ON, NOTHING_SAID, runContinuationTurn } = await import("./run");
type WakeUp = import("./run").WakeUp;

const ENV = { OPENAI_API_KEY: "sk-test" } as unknown as RoutineEnv;
const NOW = new Date("2026-10-27T14:35:00.000Z");

function at(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

const WAKE: WakeUp = {
  id: "cont-1",
  kind: "timer",
  workspaceId: "ws-1",
  agentId: "agent-1",
  userId: "user-1",
  sessionId: "sess-1",
  routineRunId: null,
  note: "open the link and see whether the video is done",
};

function seed(over: Partial<Record<string, Row[]>> = {}) {
  return memoryDb({
    chat_sessions: [
      {
        id: "sess-1",
        user_id: "user-1",
        workspace_id: "ws-1",
        agent_id: "agent-1",
        visibility: "private",
        deleted_at: null,
        updated_at: at(-20),
      },
    ],
    agents: [
      {
        id: "agent-1",
        workspace_id: "ws-1",
        persona: "You are the marketing team's agent.",
        model: null,
        temperature: null,
        reasoning_effort: null,
      },
    ],
    messages: [
      {
        id: "m-1",
        session_id: "sess-1",
        role: "user",
        content: "make a video and post it to Slack",
        sender_id: "user-1",
        created_at: at(-20),
      },
      {
        id: "m-2",
        session_id: "sess-1",
        role: "assistant",
        content: "Started. I'll check at 14:35.",
        sender_id: null,
        created_at: at(-19),
      },
    ],
    workspace_members: [{ workspace_id: "ws-1", user_id: "user-1", role: "member" }],
    browser_tasks: [],
    continuations: [],
    routine_runs: [],
    routines: [],
    ...over,
  });
}

function turnOf(over: Partial<AgentTurn> = {}): AgentTurn {
  return {
    text: "Not done yet; I'll look again at 14:50.",
    usage: { promptTokens: 120, completionTokens: 30 } as AgentTurn["usage"],
    steps: [],
    passes: [],
    finishReason: "stop",
    ...over,
  };
}

const turn = vi.fn(async (_opts: AgentTurnOptions): Promise<AgentTurn> => turnOf());
const capabilities = vi.fn(async (_input: unknown) => ({ tools: [], manifest: "" }));
const check = vi.fn(async (_workspaceId: string) => ({ allowed: true }));
const record = vi.fn(async (..._args: unknown[]): Promise<void> => {});
const entitlements = {
  check: (w: string) => check(w),
  record: (...a: unknown[]) => record(...a),
} as unknown as Entitlements;

function run(db: ReturnType<typeof memoryDb>, wake = WAKE) {
  return runContinuationTurn(ENV, wake, {
    db: db.db as unknown as SupabaseClient,
    now: () => NOW,
    turn: turn as unknown as typeof import("../harness/loop").runAgentTurn,
    capabilities: capabilities as unknown as typeof import("../harness/available").capabilitiesFor,
    entitlements,
  });
}

function lastMessage(opts: AgentTurnOptions): string {
  const last = opts.request.messages.at(-1);
  return typeof last?.content === "string" ? last.content : "";
}

beforeEach(() => {
  turn.mockReset();
  turn.mockImplementation(async () => turnOf());
  capabilities.mockClear();
  check.mockReset();
  check.mockResolvedValue({ allowed: true });
  record.mockClear();
  writeSteps.mockClear();
  completeHeldRun.mockClear();
  nudge.mockClear();
  browserTaskNote.mockReset();
  browserTaskNote.mockResolvedValue(null);
  agentAccessFor.mockReset();
  agentAccessFor.mockResolvedValue("use");
});

describe("runContinuationTurn", () => {
  it("runs the turn in the conversation and writes the reply", async () => {
    const db = seed();
    const out = await run(db);
    expect(out).toMatchObject({ status: "done", text: "Not done yet; I'll look again at 14:50." });

    const opts = turn.mock.calls[0][0];
    expect(lastMessage(opts)).toBe(
      'You asked to be woken now. Your note to yourself: "open the link and see whether the video is done"',
    );
    // The conversation came with it, oldest first, after the system prefix.
    const roles = opts.request.messages.map((m) => m.role);
    expect(roles[0]).toBe("system");
    expect(opts.request.messages[1]).toMatchObject({
      content: "make a video and post it to Slack",
    });
    expect(String(opts.request.messages[0].content)).toContain("marketing team's agent");
    expect(String(opts.request.messages[0].content)).toContain("Nobody is watching");

    const written = db.tables.messages.at(-1);
    expect(written).toMatchObject({
      session_id: "sess-1",
      role: "assistant",
      content: "Not done yet; I'll look again at 14:50.",
      sender_id: null,
      outcome: "answered",
      prompt_tokens: 120,
      completion_tokens: 30,
    });
    expect(writeSteps).toHaveBeenCalledWith(expect.anything(), written?.id, []);
    expect(db.tables.chat_sessions[0].updated_at).toBe(NOW.toISOString());
  });

  it("marks the turn as nobody's and keeps the conversation's own ids", async () => {
    const db = seed();
    await run(db);
    const { ctx } = turn.mock.calls[0][0];
    expect(ctx).toMatchObject({
      workspaceId: "ws-1",
      agentId: "agent-1",
      userId: "user-1",
      sessionId: "sess-1",
      continuation: { id: "cont-1", browserApproved: false },
      knowledgeScope: { viewer: "user-1" },
    });
    expect(ctx.routineRunId).toBeUndefined();
    expect(ctx.routineBrowser).toBeUndefined();
    expect(capabilities).toHaveBeenCalledWith(
      expect.objectContaining({ surface: "schedule", browser: false, agentId: "agent-1" }),
    );
  });

  it("tells browse a browser was approved here before", async () => {
    const db = seed({
      browser_tasks: [
        {
          id: "t-0",
          session_id: "sess-1",
          user_id: "user-1",
          status: "finished",
          created_at: at(-15),
        },
      ],
    });
    await run(db);
    expect(turn.mock.calls[0][0].ctx.continuation).toEqual({ id: "cont-1", browserApproved: true });
    expect(capabilities).toHaveBeenCalledWith(expect.objectContaining({ browser: true }));
  });

  it("reads only this person's tasks as the approval", async () => {
    const db = seed({
      browser_tasks: [
        {
          id: "t-0",
          session_id: "sess-1",
          user_id: "user-2",
          status: "finished",
          created_at: at(-15),
        },
      ],
    });
    await run(db);
    expect(turn.mock.calls[0][0].ctx.continuation).toEqual({
      id: "cont-1",
      browserApproved: false,
    });
  });

  it("a wake-up for a conversation that is gone fails without a message", async () => {
    for (const session of [{ deleted_at: at(-5) }, { user_id: "user-2" }]) {
      const db = seed({
        chat_sessions: [
          {
            id: "sess-1",
            user_id: "user-1",
            workspace_id: "ws-1",
            agent_id: "agent-1",
            visibility: "private",
            deleted_at: null,
            ...session,
          },
        ],
      });
      const out = await run(db);
      expect(out.status).toBe("failed");
      expect(db.tables.messages).toHaveLength(2);
      expect(turn).not.toHaveBeenCalled();
    }
  });

  // The executor's two checks (lib/routines/executor.ts), for its reason: the
  // service role reads past the policies that cut a removed member off, and a
  // wake-up can be twelve hours old.
  it("does nothing for a person who is no longer in the workspace", async () => {
    const db = seed({ workspace_members: [] });
    const out = await run(db);
    expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(/member/) });
    expect(turn).not.toHaveBeenCalled();
    expect(db.tables.messages).toHaveLength(2);
  });

  it("does nothing for an agent the person can no longer use", async () => {
    agentAccessFor.mockResolvedValue(null);
    const db = seed();
    const out = await run(db);
    expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(/agent/) });
    expect(agentAccessFor).toHaveBeenCalledWith(expect.anything(), "agent-1", "user-1");
    expect(turn).not.toHaveBeenCalled();
    expect(db.tables.messages).toHaveLength(2);
  });

  it("fails before the model when the workspace has no credits", async () => {
    check.mockResolvedValue({ allowed: false });
    const db = seed();
    const out = await run(db);
    expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(/credits/) });
    expect(turn).not.toHaveBeenCalled();
    expect(db.tables.messages).toHaveLength(2);
  });

  it("uses the CARRY_ON words after a browser", async () => {
    const db = seed();
    await run(db, { ...WAKE, id: "task:t-9", kind: "after_browser", note: "post it to Slack" });
    expect(lastMessage(turn.mock.calls[0][0])).toBe(CARRY_ON);
  });

  it("gives a step to a browser task the turn started without one", async () => {
    const db = seed({
      browser_tasks: [
        {
          id: "t-new",
          session_id: "sess-1",
          user_id: "user-1",
          status: "queued",
          then_step: null,
          created_at: at(0),
        },
        {
          id: "t-old",
          session_id: "sess-1",
          user_id: "user-1",
          status: "finished",
          then_step: null,
          created_at: at(-15),
        },
      ],
    });
    await run(db);
    const byId = Object.fromEntries(db.tables.browser_tasks.map((t) => [t.id, t.then_step]));
    expect(byId).toEqual({
      "t-new": "Carry on with: open the link and see whether the video is done",
      "t-old": null,
    });
  });

  it("nudges once, when the chain ends", async () => {
    const db = seed();
    await run(db);
    expect(nudge).toHaveBeenCalledTimes(1);
    expect(nudge).toHaveBeenCalledWith(
      ENV,
      expect.anything(),
      "user-1",
      { subject: "Your agent came back to this", body: "Not done yet; I'll look again at 14:50." },
      "cont-1",
    );
  });

  it("does not nudge while the chain goes on", async () => {
    const waiting = seed({
      continuations: [{ id: "c-next", session_id: "sess-1", status: "waiting", created_at: at(0) }],
    });
    await run(waiting);
    expect(nudge).not.toHaveBeenCalled();

    const browsing = seed({
      browser_tasks: [
        {
          id: "t-new",
          session_id: "sess-1",
          user_id: "user-1",
          status: "queued",
          created_at: at(0),
        },
      ],
    });
    await run(browsing);
    expect(nudge).not.toHaveBeenCalled();
  });

  it("says what it stopped short of", async () => {
    turn.mockImplementation(async () =>
      turnOf({
        text: "I found the video.",
        paused: { reason: "confirmation", messages: [], summary: "Post to Slack" },
      }),
    );
    const db = seed();
    const out = await run(db);
    expect(out.text).toMatch(/^I found the video\./);
    expect(out.text).toContain('stopped short of "Post to Slack"');
    expect(out.text).toContain("nobody was watching");
    expect(db.tables.messages.at(-1)).toMatchObject({ outcome: "cut_short" });
  });

  it("writes something when the model said nothing", async () => {
    turn.mockImplementation(async () => turnOf({ text: "   " }));
    const db = seed();
    await run(db);
    expect(db.tables.messages.at(-1)).toMatchObject({ content: NOTHING_SAID, outcome: "empty" });
  });

  it("records the spend against the workspace", async () => {
    const db = seed();
    await run(db);
    expect(record).toHaveBeenCalledTimes(1);
    const [workspaceId, spends, ref] = record.mock.calls[0];
    expect(workspaceId).toBe("ws-1");
    expect(spends).toEqual([
      expect.objectContaining({
        kind: "completion",
        promptTokens: 120,
        completionTokens: 30,
        purpose: "reply",
      }),
    ]);
    expect(ref).toMatchObject({
      userId: "user-1",
      sessionId: "sess-1",
      messageId: db.tables.messages.at(-1)?.id,
    });
  });

  describe("a routine's wake-up", () => {
    const routineSeed = (runOver: Row = {}) =>
      seed({
        routine_runs: [
          { id: "run-1", routine_id: "r-1", status: "waiting", started_at: at(-30), ...runOver },
        ],
        routines: [
          {
            id: "r-1",
            browser_access: "all",
            browser_site: null,
            timezone: "Europe/Istanbul",
            instruction: "Make the weekly video and post it.",
          },
        ],
      });
    const ROUTINE_WAKE = { ...WAKE, routineRunId: "run-1" };

    it("attaches to its held run and hands its reply over as the report", async () => {
      const db = routineSeed();
      const out = await run(db, ROUTINE_WAKE);
      expect(out.status).toBe("done");
      const { ctx, request } = turn.mock.calls[0][0];
      expect(ctx.routineRunId).toBe("run-1");
      expect(ctx.routineBrowser).toMatchObject({ access: "all", site: null, started: [] });
      expect(await ctx.routineBrowser?.conversation()).toBe("sess-1");
      expect(ctx.knowledgeScope).toEqual({ viewer: "user-1" });
      expect(String(request.messages[0].content)).toContain("report");
      expect(capabilities).toHaveBeenCalledWith(expect.objectContaining({ browser: true }));
      // `except`: the wake-up's own row is still `running` until the dispatcher
      // settles it, and the held report must not wait on the turn that is
      // handing it over.
      expect(completeHeldRun).toHaveBeenCalledWith(
        ENV,
        "run-1",
        expect.objectContaining({ db: expect.anything() }),
        { report: "Not done yet; I'll look again at 14:50.", except: "cont-1" },
      );
      expect(nudge).not.toHaveBeenCalled();
      const [, spends] = record.mock.calls[0];
      expect(spends).toEqual([expect.objectContaining({ purpose: "routine" })]);
    });

    it("does nothing for a run that is no longer waiting", async () => {
      const db = routineSeed({ status: "ok" });
      const out = await run(db, ROUTINE_WAKE);
      expect(out.status).toBe("failed");
      expect(turn).not.toHaveBeenCalled();
      expect(completeHeldRun).not.toHaveBeenCalled();
    });

    it("lets the report go out when there are no credits to wake with", async () => {
      check.mockResolvedValue({ allowed: false });
      const db = routineSeed();
      const out = await run(db, ROUTINE_WAKE);
      expect(out.status).toBe("failed");
      expect(completeHeldRun).toHaveBeenCalledWith(ENV, "run-1", expect.anything(), {
        except: "cont-1",
      });
    });

    it("names no row to leave out after a browser, whose wake-up has none", async () => {
      const db = routineSeed();
      await run(db, { ...ROUTINE_WAKE, id: "task:t-1", kind: "after_browser" });
      expect(completeHeldRun).toHaveBeenCalledWith(ENV, "run-1", expect.anything(), {
        report: "Not done yet; I'll look again at 14:50.",
      });
    });

    it("offers no browser to a routine whose owner turned it off", async () => {
      const db = seed({
        routine_runs: [{ id: "run-1", routine_id: "r-1", status: "waiting", started_at: at(-30) }],
        routines: [
          {
            id: "r-1",
            browser_access: "off",
            browser_site: null,
            timezone: "UTC",
            instruction: "x",
          },
        ],
      });
      await run(db, ROUTINE_WAKE);
      expect(capabilities).toHaveBeenCalledWith(expect.objectContaining({ browser: false }));
      expect(turn.mock.calls[0][0].ctx.routineBrowser).toBeUndefined();
    });
  });
});
