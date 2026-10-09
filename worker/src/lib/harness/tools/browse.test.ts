import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";
import type { BrowserResult, CreatedTask } from "../../browser/client";
import type { QuotaSnapshot } from "../../entitlements";

/**
 * Each mock is declared with the real signature and forwarded by name, which
 * is the shape `http-request.test.ts` established: a `vi.fn()` with no
 * parameters infers a no-argument procedure, and then every spread into it is
 * a type error and every `mockResolvedValue` is checked against the wrong
 * return type.
 */
const createTask = vi.fn(
  async (
    _env: unknown,
    _input: { task: string },
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<CreatedTask>> => ({
    kind: "ok",
    value: { id: "bu-1", sessionId: "bus-1" },
  }),
);
vi.mock("../../browser/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../browser/client")>();
  return {
    ...actual,
    createTask: (env: unknown, input: { task: string }, opts?: { signal?: AbortSignal }) =>
      createTask(env, input, opts),
  };
});

const recordBrowserTask = vi.fn(
  async (
    _env: unknown,
    _input: {
      workspaceId: string;
      agentId: string;
      userId: string;
      sessionId: string;
      providerTaskId: string;
      task: string;
    },
  ): Promise<string | null> => "bt-1",
);
vi.mock("../../browser/tasks", () => ({
  recordBrowserTask: (env: unknown, input: Parameters<typeof recordBrowserTask>[1]) =>
    recordBrowserTask(env, input),
}));

/**
 * Mocked because the real one builds a service-role client, and the point of
 * these tests is the tool's own decisions rather than Supabase's constructor.
 * Null is the ordinary case — somebody who has never taken over a browser has
 * no cookie jar — and it is also the case that must stay byte-identical to the
 * request this tool made before takeovers existed.
 */
const profileFor = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{
      id: string;
      providerProfileId: string;
      proxyCountryCode: string | null;
    } | null> => null,
  ),
);
vi.mock("../../browser/takeover", () => ({ profileFor }));

const affordable = vi.fn(async (_ctx: ToolContext): Promise<ToolResult | null> => null);
const spend = vi.fn(async (_ctx: ToolContext, _tokens: number): Promise<void> => {});
vi.mock("../spend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spend")>();
  return {
    ...actual,
    affordable: (ctx: ToolContext) => affordable(ctx),
    spend: (ctx: ToolContext, tokens: number) => spend(ctx, tokens),
  };
});

const snapshot = vi.fn(async (_userId: string): Promise<QuotaSnapshot> => ({
  used: 0,
  limit: 1_000_000,
  resetsAt: "2026-11-01T00:00:00Z",
}));
vi.mock("../../entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../entitlements")>();
  return { ...actual, entitlementsFor: () => ({ snapshot: (userId: string) => snapshot(userId) }) };
});

import { browseTool, BROWSER_TASK_TOKENS } from "./browse";

/**
 * `ctx.db` is a TRIPWIRE, and it is the guard for the defect of 2026-10-09.
 *
 * `browse` wrote its row through the caller's own client. `0073` gives
 * `browser_tasks` no write grant to any client role, so production answered
 * `42501 permission denied` — after the task had already been created at
 * browser-use, so the money was spent on an answer that could never arrive.
 *
 * The unit tests did not catch it because `ctx.db` was a mock, and a mock has
 * no grants with which to refuse anything. So the mock now refuses on
 * principle: any touch of it from this tool fails the test by name. The write
 * goes through `lib/browser/tasks.ts` and the service role.
 */
function refusingDb(): ToolContext["db"] {
  return new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(
          `browse must not reach the database through ctx.db (touched .${String(prop)}) — ` +
            "browser_tasks refuses every client write (0073). Use recordBrowserTask.",
        );
      },
    },
  ) as unknown as ToolContext["db"];
}

function ctxWith(over: Partial<ToolContext> = {}): ToolContext {
  return {
    db: refusingDb(),
    env: { BROWSER_USE_API_KEY: "bu_test" } as ToolEnv,
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    sessionId: "sess-1",
    ...over,
  };
}

beforeEach(() => {
  recordBrowserTask.mockReset();
  recordBrowserTask.mockResolvedValue("bt-1");
  createTask.mockReset();
  affordable.mockReset();
  affordable.mockResolvedValue(null);
  spend.mockReset();
  snapshot.mockReset();
  snapshot.mockResolvedValue({ used: 0, limit: 1_000_000, resetsAt: "2026-11-01T00:00:00Z" });
  createTask.mockResolvedValue({ kind: "ok", value: { id: "bu-1", sessionId: "bus-1" } });
});

const TASK = "read the pricing table on example.com and list the tiers";

describe("asking first", () => {
  it("asks for confirmation before it spends anything", async () => {
    const result = await browseTool.run({ task: TASK }, ctxWith());
    expect(result.kind).toBe("needs_confirmation");
    expect(createTask).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  /**
   * §4: the card shows the task sentence verbatim. It is the entire blast
   * radius — no endpoint to inspect, no method to check, no origin to lock —
   * so a truncated or summarised version would be an approval screen lying
   * about what it is approving. `ProposalRows` prints proposal fields
   * untruncated, so putting the whole sentence in the proposal is the whole
   * of the requirement.
   */
  it("puts the task sentence in the proposal verbatim", async () => {
    const long = `${TASK} ${"and also ".repeat(60)}`;
    const result = await browseTool.run({ task: long }, ctxWith());
    const proposal = (result as { proposal: Record<string, unknown> }).proposal;
    expect(proposal.task).toBe(long.trim());
  });

  it("tells the person what the task costs against their allowance", async () => {
    snapshot.mockResolvedValue({
      used: 300_000,
      limit: 1_000_000,
      resetsAt: "2026-11-01T00:00:00Z",
    });
    const result = await browseTool.run({ task: TASK }, ctxWith());
    const proposal = (result as { proposal: Record<string, string> }).proposal;
    // 137,000 of 1,000,000 is ~14%; 700,000 left is 5 more whole tasks.
    expect(proposal.cost).toContain("14%");
    expect(proposal.cost).toContain("5");
  });

  it("says nothing about cost on an unmetered deployment rather than inventing a share", async () => {
    snapshot.mockResolvedValue({ used: 0, limit: null, resetsAt: null });
    const result = await browseTool.run({ task: TASK }, ctxWith());
    const proposal = (result as { proposal: Record<string, unknown> }).proposal;
    expect(proposal.cost).toBeUndefined();
  });

  it("does not let a failed allowance read stop a person being asked", async () => {
    snapshot.mockRejectedValue(new Error("quota backend down"));
    const result = await browseTool.run({ task: TASK }, ctxWith());
    expect(result.kind).toBe("needs_confirmation");
  });
});

describe("once approved", () => {
  const ctx = () => ctxWith({ confirmed: true });

  it("hands the task over and returns the id rather than the answer", async () => {
    const result = await browseTool.run({ task: TASK }, ctx());
    expect(result.kind).toBe("ok");
    expect(createTask).toHaveBeenCalledWith(
      expect.anything(),
      { task: TASK },
      expect.objectContaining({ signal: undefined }),
    );
    // The turn ends here. The content must not read as an answer.
    expect((result as { content: string }).content).toMatch(/started|few minutes/i);
  });

  it("records the handoff with the session the answer has to go back to", async () => {
    await browseTool.run({ task: TASK }, ctx());
    expect(recordBrowserTask).toHaveBeenCalledTimes(1);
    expect(recordBrowserTask.mock.calls[0][1]).toEqual({
      workspaceId: "ws-1",
      agentId: "agent-1",
      userId: "user-1",
      sessionId: "sess-1",
      providerTaskId: "bu-1",
      task: TASK,
    });
  });

  /**
   * The 2026-10-09 defect, pinned. Writing through the caller's client is a
   * `42501` in production and a silent pass against a mock, so the mock
   * refuses and this says why.
   */
  it("does not write through the caller's own client, which browser_tasks refuses", async () => {
    const result = await browseTool.run({ task: TASK }, ctx());
    expect(result.kind).toBe("ok");
  });

  it("charges the allowance once, after the provider accepted the task", async () => {
    await browseTool.run({ task: TASK }, ctx());
    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledWith(expect.anything(), BROWSER_TASK_TOKENS);
  });

  it("refuses before the network when the allowance is spent", async () => {
    affordable.mockResolvedValue({ kind: "error", message: "no allowance left" });
    const result = await browseTool.run({ task: TASK }, ctx());
    expect(result).toEqual({ kind: "error", message: "no allowance left" });
    expect(createTask).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  /**
   * The concurrency pool is account-wide and shared across every tenant — ten
   * sessions at $0 lifetime spend. A refused creation cost nothing, so it
   * must charge nothing.
   */
  it("does not charge for a task the concurrency pool refused", async () => {
    createTask.mockResolvedValue({
      kind: "error",
      status: 429,
      message: "Too many concurrent active sessions",
    });
    const result = await browseTool.run({ task: TASK }, ctx());
    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toMatch(/busy|again/i);
    expect(spend).not.toHaveBeenCalled();
    expect(recordBrowserTask).not.toHaveBeenCalled();
  });

  it("does not charge when the provider could not be reached at all", async () => {
    createTask.mockResolvedValue({ kind: "error", status: 0, message: "network down" });
    await browseTool.run({ task: TASK }, ctx());
    expect(spend).not.toHaveBeenCalled();
  });

  /**
   * A 500 means they took the request. `wasBilled` is the existing rule for
   * which failures are somebody's money and which are not.
   */
  it("charges for a failure the provider is nonetheless responsible for", async () => {
    createTask.mockResolvedValue({ kind: "error", status: 500, message: "internal error" });
    await browseTool.run({ task: TASK }, ctx());
    expect(spend).toHaveBeenCalledWith(expect.anything(), BROWSER_TASK_TOKENS);
  });

  it("does not charge when the handoff could not be recorded, because nothing will ever poll it", async () => {
    recordBrowserTask.mockResolvedValue(null);
    const result = await browseTool.run({ task: TASK }, ctx());
    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toMatch(/could not be recorded/i);
    expect(spend).not.toHaveBeenCalled();
  });
});

describe("arguments", () => {
  it("requires a task", async () => {
    const result = await browseTool.run({}, ctxWith({ confirmed: true }));
    expect(result).toEqual({ kind: "error", message: "task is required" });
  });

  it("refuses a task too short to be a task", async () => {
    const result = await browseTool.run({ task: "hi" }, ctxWith({ confirmed: true }));
    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toContain("one sentence");
  });

  it("cannot be run by a scheduled turn, because there is nobody to deliver to", async () => {
    const result = await browseTool.run(
      { task: TASK },
      ctxWith({ confirmed: true, sessionId: undefined, routineRunId: "run-1" }),
    );
    expect(result.kind).toBe("error");
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("availability", () => {
  it("is not offered on a deployment with no browser-use key", () => {
    expect(browseTool.isConfigured({} as ToolEnv)).toBe(false);
    expect(browseTool.isConfigured({ BROWSER_USE_API_KEY: "bu_x" } as ToolEnv)).toBe(true);
  });

  it("needs nothing from the workspace, because it points at the public web", () => {
    expect(browseTool.needs).toBeUndefined();
  });

  it("is destructive, because it acts in the world under instruction", () => {
    expect(browseTool.destructive).toBe(true);
  });
});
