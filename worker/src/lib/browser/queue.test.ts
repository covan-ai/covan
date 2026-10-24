import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { fakeDb, type QueryContext, type QueryResult } from "../../test-support/fake-db";
import {
  advanceBrowserQueue,
  cancelledNotice,
  cancelWaitingTask,
  cancelWaitingTasks,
  MAX_START_ATTEMPTS,
  NOT_STARTED,
  queueBrowserTask,
  QUEUE_MAX,
  startQueuedBrowserTasks,
  waitingInLine,
  type QueueDeps,
} from "./queue";
import type { BegunRun } from "./start";

const completeHeldRun = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => true));
vi.mock("../routines/held", () => ({
  completeHeldRun: (...args: unknown[]) => completeHeldRun(...args),
}));

/**
 * A conversation's browser tasks, one after another (0080).
 *
 * 2026-10-11: an agent asked to look at three sites started one, was refused
 * the other two, and told the person all three were running. These are the
 * worker's half of the line; `tests/rls/browser-tasks.test.ts` proves the
 * claim that orders it.
 */

const ENV = { BROWSER_USE_API_KEY: "bu_test" } as RoutineEnv;
const NOW = new Date("2026-10-11T16:00:00.000Z");

const WAITING = {
  id: "bt-2",
  workspace_id: "ws-1",
  agent_id: "agent-1",
  user_id: "user-1",
  session_id: "sess-1",
  provider_task_id: null,
  task: "Review covan.app and summarise the pricing",
  status: "waiting",
  poll_count: 0,
  api_version: "v4",
  browser_session_id: "bs-1",
  login_host: null,
  created_at: "2026-10-11T15:20:00.000Z",
};

const BROWSER = {
  id: "bs-1",
  provider_session_id: "ps-1",
  profile_id: "prof-1",
  provider_browser_id: "pb-1",
  live_state: "none",
};

const BEGUN: BegunRun = {
  run: { id: "run-2", sessionId: "ps-1", status: "queued" },
  credentialId: null,
  opening: false,
  detach: false,
  withoutProfile: false,
  sentProfileId: "prof-1",
};

let claims: unknown[][];
let browserRow: Record<string, unknown> | null;
let casWins: boolean;
let rpcCalls: Array<Record<string, unknown>>;

function deps(over: Partial<QueueDeps> = {}) {
  const { db, calls } = fakeDb({
    rpc: {
      claim_next_browser_tasks: (args) => {
        rpcCalls.push(args);
        return { data: claims.shift() ?? [], error: null };
      },
    },
    tables: {
      browser_tasks: {
        select: () => ({ data: [{ id: "a" }, { id: "b" }], error: null }),
        insert: () => ({ data: { id: "bt-new" }, error: null }),
        update: (ctx: QueryContext): QueryResult => {
          if (ctx.values?.status === "queued") {
            return { data: casWins ? { id: WAITING.id } : null, error: null };
          }
          if (ctx.filters.some((f) => f.column === "browser_session_id")) {
            return {
              data: [
                { id: "bt-2", session_id: "sess-1", task: "Review covan.app" },
                { id: "bt-3", session_id: "sess-1", task: "Review tasklet.ai" },
              ],
              error: null,
            };
          }
          if (ctx.filters.some((f) => f.kind === "or")) {
            return { data: [{ ...WAITING, browser_session_id: null }], error: null };
          }
          return { data: ctx.single ? { id: WAITING.id } : null, error: null };
        },
      },
      browser_sessions: { select: () => ({ data: browserRow, error: null }) },
      messages: { insert: () => ({ data: null, error: null }) },
      chat_sessions: { update: () => ({ data: null, error: null }) },
    },
  });
  const all = {
    db: db as unknown as SupabaseClient,
    now: () => NOW,
    begin: vi.fn(async () => ({ kind: "ok" as const, value: BEGUN })),
    finish: vi.fn(async () => {}),
    heldTakeover: vi.fn(async () => false as boolean | null),
    cancelRun: vi.fn(async () => ({
      kind: "ok" as const,
      value: { status: "cancelled" as const },
    })),
    deliver: vi.fn(async () => {}),
    entitlements: {
      check: vi.fn(async () => ({ allowed: true }) as { allowed: true }),
      record: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    },
    ...over,
  };
  return { deps: all as unknown as QueueDeps & typeof all, calls };
}

const updates = (calls: ReturnType<typeof fakeDb>["calls"]) =>
  calls.filter((c) => c.table === "browser_tasks" && c.op === "update");

beforeEach(() => {
  claims = [];
  browserRow = BROWSER;
  casWins = true;
  rpcCalls = [];
  completeHeldRun.mockClear();
});

describe("waitingInLine", () => {
  it("counts this browser's waiting tasks, reading no further than one past the cap", async () => {
    const { deps: d, calls } = deps();
    expect(await waitingInLine(ENV, "bs-1", d)).toBe(2);
    expect(calls[0].filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: "browser_session_id", value: "bs-1" }),
        expect.objectContaining({ column: "status", value: "waiting" }),
      ]),
    );
    expect(calls[0].limit).toBe(QUEUE_MAX + 1);
  });
});

describe("queueBrowserTask", () => {
  it("writes a waiting v4 row in the browser's line, carrying the site and no run", async () => {
    const { deps: d, calls } = deps();
    const id = await queueBrowserTask(
      ENV,
      {
        workspaceId: "ws-1",
        agentId: "agent-1",
        userId: "user-1",
        sessionId: "sess-1",
        task: "Review tasklet.ai",
        site: "tasklet.ai",
        browserSessionId: "bs-1",
      },
      d,
    );
    expect(id).toBe("bt-new");
    expect(calls[0].values).toMatchObject({
      status: "waiting",
      api_version: "v4",
      browser_session_id: "bs-1",
      login_host: "tasklet.ai",
    });
    expect(calls[0].values).not.toHaveProperty("provider_task_id");
  });
});

describe("advanceBrowserQueue", () => {
  it("claims the next task of the browser it was told about, one at a time", async () => {
    const { deps: d } = deps();
    expect(await advanceBrowserQueue(ENV, "bs-1", d)).toBe(0);
    expect(rpcCalls[0]).toMatchObject({ p_browser_session_id: "bs-1", p_limit: 1 });
  });

  it("starts it: the run, then waiting to queued naming it, then the browser, then the charge", async () => {
    claims = [[WAITING]];
    const { deps: d, calls } = deps();

    expect(await advanceBrowserQueue(ENV, "bs-1", d)).toBe(1);

    expect(d.begin).toHaveBeenCalledWith(ENV, {
      userId: "user-1",
      agentId: "agent-1",
      workspaceId: "ws-1",
      // The ceiling is held under the row's own id, which the settle lets go.
      holdId: WAITING.id,
      task: WAITING.task,
      site: null,
      browser: {
        id: "bs-1",
        providerSessionId: "ps-1",
        profileId: "prof-1",
        providerBrowserId: "pb-1",
      },
    });
    const [started] = updates(calls);
    expect(started.values).toMatchObject({
      status: "queued",
      provider_task_id: "run-2",
      provider_run_id: "run-2",
      claimed_at: null,
    });
    expect(started.filters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ column: "id", value: "bt-2" }),
        expect.objectContaining({ column: "status", value: "waiting" }),
      ]),
    );
    expect(d.finish).toHaveBeenCalledTimes(1);
    expect(d.entitlements.record).toHaveBeenCalledWith(
      "ws-1",
      [{ kind: "browser_task", stage: "started", browserTaskId: WAITING.id, costUsd: null }],
      { userId: "user-1", sessionId: "sess-1", browserTaskId: WAITING.id },
    );
  });

  it("cancels the run, and charges nothing, when the task left the line while it started", async () => {
    claims = [[WAITING]];
    casWins = false;
    const { deps: d } = deps();

    expect(await advanceBrowserQueue(ENV, "bs-1", d)).toBe(0);
    expect(d.cancelRun).toHaveBeenCalledWith(ENV, "run-2");
    expect(d.finish).not.toHaveBeenCalled();
    expect(d.entitlements.record).not.toHaveBeenCalled();
    // No settle will come for it, so the queue lets go of its ceiling itself.
    expect(d.entitlements.release).toHaveBeenCalledWith(WAITING.id);
  });

  it.each([0, 409, 429, 503])(
    "keeps the lease and counts the try when the provider answers %s",
    async (status) => {
      claims = [[WAITING]];
      const { deps: d, calls } = deps({
        begin: vi.fn(async () => ({ kind: "error" as const, status, message: "busy" })),
      } as Partial<QueueDeps>);

      await advanceBrowserQueue(ENV, "bs-1", d);

      expect(updates(calls).map((u) => u.values)).toEqual([{ poll_count: 1 }]);
      expect(d.deliver).not.toHaveBeenCalled();
      expect(d.entitlements.record).not.toHaveBeenCalled();
    },
  );

  it("gives up after MAX_START_ATTEMPTS tries, and says so in the conversation", async () => {
    claims = [[{ ...WAITING, poll_count: MAX_START_ATTEMPTS - 1 }]];
    const { deps: d, calls } = deps({
      begin: vi.fn(async () => ({ kind: "error" as const, status: 429, message: "busy" })),
    } as Partial<QueueDeps>);

    await advanceBrowserQueue(ENV, "bs-1", d);

    expect(updates(calls)[0].values).toMatchObject({ status: "failed", stop_reason: NOT_STARTED });
    expect(d.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bt-2" }),
      expect.objectContaining({ status: "failed", output: null }),
      ENV,
      d.db,
    );
  });

  it("charges a request the provider took and failed (R12), gives it up, and tries the next", async () => {
    claims = [[WAITING], []];
    const { deps: d, calls } = deps({
      begin: vi.fn(async () => ({
        kind: "error" as const,
        status: 400,
        message: "400 Bad Request",
      })),
    } as Partial<QueueDeps>);

    await advanceBrowserQueue(ENV, "bs-1", d);

    expect(d.entitlements.record).toHaveBeenCalledWith(
      "ws-1",
      [{ kind: "browser_task", stage: "started", browserTaskId: WAITING.id, costUsd: null }],
      { userId: "user-1", sessionId: "sess-1", browserTaskId: WAITING.id },
    );
    expect(updates(calls)[0].values).toMatchObject({
      status: "failed",
      error: "the browser could not start it (400 Bad Request)",
    });
    expect(rpcCalls).toHaveLength(2);
  });

  it("gives up, without starting, a task whose workspace ran out of credits while it waited", async () => {
    claims = [[WAITING]];
    const { deps: d } = deps();
    vi.mocked(d.entitlements.check).mockResolvedValueOnce({ allowed: false, balance: 0 });

    await advanceBrowserQueue(ENV, "bs-1", d);

    expect(d.begin).not.toHaveBeenCalled();
    expect(d.deliver).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ error: expect.stringMatching(/out of credits/) }),
      ENV,
      d.db,
    );
  });

  it("waits while the person's own browser is open (R44), and when that cannot be told", async () => {
    for (const own of [true, null]) {
      claims = [[WAITING]];
      const { deps: d } = deps({ heldTakeover: vi.fn(async () => own) } as Partial<QueueDeps>);
      await advanceBrowserQueue(ENV, "bs-1", d);
      expect(d.begin).not.toHaveBeenCalled();
      expect(d.deliver).not.toHaveBeenCalled();
    }
  });

  it("gives up a task whose browser is gone", async () => {
    claims = [[WAITING]];
    browserRow = null;
    const { deps: d } = deps();

    await advanceBrowserQueue(ENV, "bs-1", d);

    expect(d.begin).not.toHaveBeenCalled();
    expect(d.deliver).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a deployment with no browser key", async () => {
    const { deps: d } = deps();
    expect(await advanceBrowserQueue({} as RoutineEnv, "bs-1", d)).toBe(0);
    expect(rpcCalls).toHaveLength(0);
  });
});

describe("taking tasks out of the line", () => {
  it("cancels everything waiting for a closed browser, and says so once per conversation", async () => {
    const { deps: d, calls } = deps();

    expect(await cancelWaitingTasks(ENV, "bs-1", d)).toBe(2);

    expect(updates(calls)[0].values).toMatchObject({ status: "stopped", stop_reason: NOT_STARTED });
    const notices = calls.filter((c) => c.table === "messages");
    expect(notices).toHaveLength(1);
    expect(notices[0].values).toMatchObject({
      session_id: "sess-1",
      role: "assistant",
      sender_id: null,
      content: cancelledNotice(["Review covan.app", "Review tasklet.ai"]),
    });
  });

  it("names what did not start, one task or several", () => {
    expect(cancelledNotice(["Review covan.app"])).toBe(
      "The browser beside this conversation was closed, so the task waiting for it did not start:\n- Review covan.app",
    );
    expect(cancelledNotice(["a", "b"])).toMatch(
      /the 2 tasks waiting for it did not start:\n- a\n- b$/,
    );
  });

  it("removes one task only while it is still waiting", async () => {
    const { deps: d, calls } = deps();
    expect(await cancelWaitingTask(ENV, "bt-2", d)).toBe(true);
    expect(updates(calls)[0].filters).toEqual(
      expect.arrayContaining([expect.objectContaining({ column: "status", value: "waiting" })]),
    );
  });
});

describe("startQueuedBrowserTasks (the cron stage)", () => {
  it("ends what waited too long or lost its browser, says so, then starts what is due", async () => {
    claims = [[WAITING]];
    const { deps: d, calls } = deps();

    expect(await startQueuedBrowserTasks(ENV, d)).toEqual({ expired: 1, started: 1 });

    const expired = updates(calls)[0];
    expect(expired.values).toMatchObject({ status: "stopped", stop_reason: NOT_STARTED });
    expect(expired.filters).toEqual(
      expect.arrayContaining([
        {
          column: "",
          kind: "or",
          value: 'created_at.lt."2026-10-11T12:00:00.000Z",browser_session_id.is.null',
        },
      ]),
    );
    expect(d.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ id: "bt-2" }),
      expect.objectContaining({ error: "its browser was closed before it could start" }),
      ENV,
      d.db,
    );
    expect(rpcCalls[0]).toMatchObject({ p_browser_session_id: null, p_limit: 2 });
  });

  it("does nothing on a deployment with no browser key", async () => {
    const { deps: d, calls } = deps();
    expect(await startQueuedBrowserTasks({} as RoutineEnv, d)).toEqual({ expired: 0, started: 0 });
    expect(calls).toHaveLength(0);
  });
});

/** A routine's tasks in the line (0100). */
describe("a routine's task in the line", () => {
  it("is queued with the run it answers and whether it may carry the jar", async () => {
    const { deps: d, calls } = deps();
    await queueBrowserTask(
      ENV,
      {
        workspaceId: "ws-1",
        agentId: "agent-1",
        userId: "user-1",
        sessionId: "sess-1",
        task: WAITING.task,
        site: "linkedin.com",
        browserSessionId: "bs-1",
        routineRunId: "run-1",
        jarless: true,
      },
      d,
    );
    const inserted = calls.find((c) => c.table === "browser_tasks" && c.op === "insert");
    expect(inserted?.values).toMatchObject({ routine_run_id: "run-1", jarless: true });
  });

  it("starts without the jar when it was asked for without one", async () => {
    claims = [[{ ...WAITING, jarless: true }]];
    const { deps: d } = deps();

    await advanceBrowserQueue(ENV, "bs-1", d);

    expect(d.begin).toHaveBeenCalledWith(ENV, expect.objectContaining({ withoutJar: true }));
  });

  it("asks a held report to finish when its waiting task is taken out of the line", async () => {
    const { deps: d } = deps();
    const { db } = fakeDb({
      tables: {
        browser_tasks: {
          update: () => ({ data: { id: "bt-2", routine_run_id: "run-1" }, error: null }),
        },
      },
    });

    expect(
      await cancelWaitingTask(ENV, "bt-2", { ...d, db: db as unknown as SupabaseClient }),
    ).toBe(true);
    expect(completeHeldRun).toHaveBeenCalledOnce();
    expect(completeHeldRun.mock.calls[0][1]).toBe("run-1");
  });

  it("asks nothing of a conversation's own task", async () => {
    const { deps: d } = deps();
    await cancelWaitingTasks(ENV, "bs-1", d);
    expect(completeHeldRun).not.toHaveBeenCalled();
  });
});
