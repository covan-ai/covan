import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import type { QueryContext, QueryResult } from "../../test-support/fake-db";
import { memoryDb, type Row } from "../../test-support/memory-db";
import {
  HAND_BACK_TASK,
  TAKE_OVER_POLLS,
  handBackBrowser,
  liveBrowser,
  stopConversationBrowser,
  takeOverBrowser,
} from "./controls";
import { OUTCOME_SCHEMA, runTask } from "./outcome";
import type { BrowserTaskRow, FinishedTask } from "./poller";
import { finishedRun, settleBrowserTask } from "./settle";
import type { RetryableTask } from "./takeover";
import { RUN_COST_CAP_USD, V4_BASE } from "./v4";

/**
 * Who has the controls of the browser beside a conversation, and the four
 * moves that change it. `fetch` is mocked and `v4.ts`/`profiles.ts` are real,
 * so what is asserted is what would cross the wire; the database is
 * `memoryDb`, so a conditional write that loses a race answers no row here
 * exactly as it would in Postgres.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

/** The one writer `hand-back` shares with `browse`, recorded into the same memory. */
let current: ReturnType<typeof memoryDb>;
const recordBrowserTask = vi.fn(
  async (_env: RoutineEnv, input: Record<string, unknown>): Promise<string | null> => {
    const id = `bt-${current.tables.browser_tasks.length + 1}`;
    current.tables.browser_tasks.push({
      id,
      user_id: input.userId,
      session_id: input.sessionId,
      task: input.task,
      provider_run_id: input.providerRunId,
      browser_session_id: input.browserSessionId,
      api_version: "v4",
      status: "queued",
      retry_of: input.retryOf ?? null,
      created_at: "2026-10-10T12:00:30.000Z",
    });
    return id;
  },
);
vi.mock("./tasks", () => ({
  recordBrowserTask: (env: RoutineEnv, input: Record<string, unknown>) =>
    recordBrowserTask(env, input),
}));

const ENV = { BROWSER_USE_API_KEY: "bu_test" } as RoutineEnv;
const NOW = new Date("2026-10-10T12:00:00.000Z");
const FAKE_LIVE = "https://live.browser-use.example/v/abc?token=live-secret";
const FAKE_CDP = "wss://cdp.browser-use.example/devtools/browser/cdp-secret";
const ME = { browserSessionId: "bs-1", userId: "user-1" };

function taskRow(over: Row = {}): Row {
  return {
    id: "bt-0",
    workspace_id: "ws-1",
    agent_id: "agent-1",
    user_id: "user-1",
    session_id: "chat-1",
    provider_task_id: "run-1",
    provider_run_id: "run-1",
    browser_session_id: "bs-1",
    api_version: "v4",
    task: "read the pricing table",
    status: "running",
    stop_reason: null,
    retry_of: null,
    poll_count: 0,
    created_at: "2026-10-10T11:59:00.000Z",
    ...over,
  };
}

function sessionRow(over: Row = {}): Row {
  return {
    id: "bs-1",
    chat_session_id: "chat-1",
    user_id: "user-1",
    live_state: "agent",
    human_since: null,
    profile_id: "bp-1",
    provider_session_id: "bu-session-1",
    provider_browser_id: "bu-browser-1",
    events_cursor: 7,
    last_run_at: "2026-10-10T11:59:00.000Z",
    claimed_at: null,
    ...over,
  };
}

const ORIGINAL: RetryableTask = {
  id: "bt-0",
  workspace_id: "ws-1",
  agent_id: "agent-1",
  user_id: "user-1",
  session_id: "chat-1",
  task: "read the pricing table",
  retry_of: null,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** What the provider says, per endpoint. A function is asked on every call. */
type Provider = {
  cancel: () => Response;
  status: () => Response;
  browser: (id: string) => Response;
  list: () => Response;
  stop: (id: string) => Response;
  create: () => Response;
  /** `POST /profiles`: a jar provisioned for a run (ruling R19). */
  createProfile: () => Response;
  /** `GET /profiles/:id`: the jar read back after a stop. */
  profile: (id: string) => Response;
};

let provider: Provider;

function route(url: string, init?: RequestInit): Response {
  const path = url.slice(V4_BASE.length);
  const method = init?.method ?? "GET";
  if (method === "POST" && /^\/runs\/[^/]+\/cancel$/.test(path)) return provider.cancel();
  if (method === "GET" && /^\/runs\/[^/]+\/status$/.test(path)) return provider.status();
  if (method === "POST" && path === "/runs") return provider.create();
  if (method === "POST" && path === "/profiles") return provider.createProfile();
  const profile = /^\/profiles\/([^/?]+)$/.exec(path);
  if (profile && method === "GET") return provider.profile(decodeURIComponent(profile[1]));
  if (method === "GET" && path.startsWith("/browsers?agentSessionId=")) return provider.list();
  const browser = /^\/browsers\/([^/?]+)$/.exec(path);
  if (browser && method === "GET") return provider.browser(decodeURIComponent(browser[1]));
  if (browser && method === "PATCH") return provider.stop(decodeURIComponent(browser[1]));
  throw new Error(`unexpected provider call ${method} ${url}`);
}

const calls = () =>
  fetchMock.mock.calls.map((c) => `${(c[1] as RequestInit | undefined)?.method ?? "GET"} ${c[0]}`);

function sentBody(match: RegExp): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((c) => match.test(String(c[0])));
  return JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
}

const sleep = vi.fn(async (_ms: number) => {});

function setup(
  tasks: Row[] = [taskRow()],
  sessions: Row[] = [sessionRow()],
  intercept?: (ctx: QueryContext) => QueryResult | undefined,
) {
  current = memoryDb(
    {
      browser_tasks: tasks,
      browser_sessions: sessions,
      browser_profiles: [
        {
          id: "bp-1",
          user_id: "user-1",
          provider_profile_id: "bu-profile-1",
          proxy_country_code: "de",
          created_at: "2026-10-01T00:00:00.000Z",
        },
      ],
    },
    intercept,
  );
  const deps = { db: current.db as unknown as SupabaseClient, now: () => NOW, sleep };
  return { mem: current, deps };
}

let spoken: unknown[][];

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => route(url, init));
  sleep.mockClear();
  recordBrowserTask.mockClear();
  provider = {
    cancel: () => json({ id: "run-1", status: "running" }),
    status: () => json({ status: "cancelled" }),
    browser: (id) => json({ id, status: "active", liveUrl: FAKE_LIVE, cdpUrl: FAKE_CDP }),
    list: () => json({ items: [] }),
    stop: (id) => json({ id, status: "stopped" }),
    create: () => json({ id: "run-2", sessionId: "bu-session-1", status: "queued" }),
    createProfile: () => json({ id: "bu-profile-new", cookieDomains: [] }),
    profile: (id) => json({ id, cookieDomains: ["linkedin.com"] }),
  };
  spoken = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...a: unknown[]) => void spoken.push(a));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("takeOverBrowser", () => {
  it("cancels the run, waits for the provider to say it ended, then hands over", async () => {
    let polled = 0;
    provider.status = () => json({ status: polled++ < 2 ? "running" : "cancelled" });
    const { mem, deps } = setup();

    const result = await takeOverBrowser(ENV, ME, deps);

    expect(result).toEqual({ kind: "human", humanSince: NOW.getTime() });
    expect(calls()[0]).toBe(`POST ${V4_BASE}/runs/run-1/cancel`);
    // A second each between asks, and never a real one in a test.
    expect(sleep.mock.calls.every(([ms]) => ms === 1_000)).toBe(true);
    expect(polled).toBe(3);
    expect(mem.tables.browser_sessions[0]).toMatchObject({
      live_state: "human",
      human_since: NOW.toISOString(),
      // Ruling R21: the take-over's own clock, which the heartbeat never moves.
      human_started_at: NOW.toISOString(),
      // Ruling R11: a lease left by an earlier take-over's sweep must not
      // delay this one's.
      claimed_at: null,
    });
    expect(mem.tables.browser_tasks[0]).toMatchObject({
      status: "stopped",
      stop_reason: "handed_to_person",
    });
  });

  it("stops the task with the settle's own condition (ruling R5)", async () => {
    const { mem, deps } = setup();

    await takeOverBrowser(ENV, ME, deps);

    const claim = mem.calls.find(
      (c) => c.table === "browser_tasks" && c.op === "update" && c.values?.status === "stopped",
    );
    expect(claim?.filters).toContainEqual({
      column: "status",
      value: ["queued", "running"],
      kind: "in",
    });
  });

  /**
   * Review focus 1 and ruling R5: the open tab's poll sees the cancelled run
   * end while the take-over is still waiting on it. The take-over claimed the
   * task first, so the settle gets no row and nobody is told "cancelled".
   */
  it("leaves a settle racing it nothing to deliver", async () => {
    const deliver = vi.fn(async () => {});
    const { mem, deps } = setup();
    let settled: boolean | null = null;
    sleep.mockImplementationOnce(async () => {
      settled = await settleBrowserTask(
        ENV,
        mem.tables.browser_tasks[0] as unknown as BrowserTaskRow,
        finishedRun({
          id: "run-1",
          status: "cancelled",
          result: null,
          output: null,
          error: null,
          totalCostUsd: 0.02,
          sessionId: "bu-session-1",
        }),
        { db: deps.db, now: () => NOW, deliver },
      );
    });
    provider.status = () => json({ status: "cancelled" });

    const result = await takeOverBrowser(ENV, ME, deps);

    expect(settled).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(result).toMatchObject({ kind: "human" });
    expect(mem.tables.browser_tasks[0]).toMatchObject({ stop_reason: "handed_to_person" });
  });

  it("still hands over when the run had already ended and its answer was settled", async () => {
    const deliver = vi.fn(async (_r: BrowserTaskRow, _o: FinishedTask) => {});
    const { mem, deps } = setup();
    const row = mem.tables.browser_tasks[0] as unknown as BrowserTaskRow;
    await settleBrowserTask(
      ENV,
      row,
      { status: "finished", output: "Starter $29", error: null, costUsd: 0.1 },
      { db: deps.db, now: () => NOW, deliver },
    );
    provider.cancel = () => json({ id: "run-1", status: "completed" });

    const result = await takeOverBrowser(ENV, ME, deps);

    expect(deliver).toHaveBeenCalledOnce();
    expect(result).toEqual({ kind: "human", humanSince: NOW.getTime() });
    // The settle's answer stands; the take-over's claim found nothing to stop.
    expect(mem.tables.browser_tasks[0]).toMatchObject({ status: "finished", stop_reason: null });
    expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "human" });
  });

  /**
   * Review focus 2. Cancel is asynchronous, and a panel that went interactive
   * while the agent was mid-type would have two pairs of hands on one field.
   */
  it("answers cancelling after ten seconds, and leaves the controls with the agent", async () => {
    provider.status = () => json({ status: "running" });
    const { mem, deps } = setup();

    const result = await takeOverBrowser(ENV, ME, deps);

    expect(result).toEqual({ kind: "cancelling" });
    expect(TAKE_OVER_POLLS).toBe(10);
    expect(sleep).toHaveBeenCalledTimes(10);
    expect(calls().filter((c) => c.endsWith("/status"))).toHaveLength(10);
    expect(mem.tables.browser_sessions[0]).toMatchObject({
      live_state: "agent",
      human_since: null,
    });
  });

  it("finishes the switch when asked again once the run has ended", async () => {
    provider.status = () => json({ status: "running" });
    const { mem, deps } = setup();
    await takeOverBrowser(ENV, ME, deps);

    // The client's second press, or its retry: cancel is idempotent at the
    // provider, and answers the run's real status.
    provider.cancel = () => json({ id: "run-1", status: "cancelled" });
    fetchMock.mockClear();
    const again = await takeOverBrowser(ENV, ME, deps);

    expect(again).toEqual({ kind: "human", humanSince: NOW.getTime() });
    expect(calls()).toEqual([`POST ${V4_BASE}/runs/run-1/cancel`]);
    expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "human" });
  });

  it("hands over an idle browser once the provider says it is still open", async () => {
    const { mem, deps } = setup(
      [taskRow({ status: "finished" })],
      [sessionRow({ live_state: "none" })],
    );

    const result = await takeOverBrowser(ENV, ME, deps);

    expect(result).toEqual({ kind: "human", humanSince: NOW.getTime() });
    // One status read of the browser the row names; nothing to cancel.
    expect(calls()).toEqual([`GET ${V4_BASE}/browsers/bu-browser-1`]);
    expect(mem.tables.browser_tasks[0]).toMatchObject({ status: "finished" });
  });

  /**
   * Final-review I2. With no run to stop, a take-over used to switch to
   * `human` on the row's word alone — and a browser the idle sweep (or the
   * provider's own cleanup) had stopped became a panel saying "You're
   * driving" over nothing, with a Done that spent the free retry on it.
   */
  describe("a browser that no longer exists", () => {
    it("is refused with a 409 that says to ask the agent again, and nobody gets the controls", async () => {
      provider.browser = (id) => json({ id, status: "stopped" });
      provider.list = () => json({ items: [{ id: "bu-browser-1", status: "stopped" }] });
      const { mem, deps } = setup(
        [taskRow({ status: "failed", stop_reason: "login_required" })],
        [sessionRow({ live_state: "none" })],
      );

      const result = await takeOverBrowser(ENV, ME, deps);

      expect(result).toMatchObject({ kind: "error", status: 409 });
      expect((result as { message: string }).message).toMatch(/ask the agent again/i);
      expect(mem.tables.browser_sessions[0]).toMatchObject({
        live_state: "none",
        human_since: null,
        // Known stopped now, so the panel's sign-in prompt goes too.
        provider_browser_id: null,
      });
    });

    it("is refused when the row names no browser and the session lists none", async () => {
      provider.list = () => json({ items: [] });
      const { mem, deps } = setup(
        [taskRow({ status: "finished" })],
        [sessionRow({ live_state: "none", provider_browser_id: null })],
      );

      expect(await takeOverBrowser(ENV, ME, deps)).toMatchObject({ kind: "error", status: 409 });
      expect(mem.tables.browser_sessions[0].live_state).toBe("none");
    });

    it("hands over the session's other active browser, and keeps its id", async () => {
      provider.browser = (id) => json({ id, status: "stopped" });
      provider.list = () => json({ items: [{ id: "bu-browser-2", status: "active" }] });
      const { mem, deps } = setup(
        [taskRow({ status: "finished" })],
        [sessionRow({ live_state: "none" })],
      );

      expect(await takeOverBrowser(ENV, ME, deps)).toMatchObject({ kind: "human" });
      expect(mem.tables.browser_sessions[0]).toMatchObject({
        live_state: "human",
        provider_browser_id: "bu-browser-2",
      });
    });

    it("finds one through the session when no event ever named it", async () => {
      provider.list = () => json({ items: [{ id: "bu-browser-3", status: "active" }] });
      const { mem, deps } = setup(
        [taskRow({ status: "finished" })],
        [sessionRow({ live_state: "none", provider_browser_id: null })],
      );

      expect(await takeOverBrowser(ENV, ME, deps)).toMatchObject({ kind: "human" });
      expect(mem.tables.browser_sessions[0].provider_browser_id).toBe("bu-browser-3");
    });

    it("changes nothing when the provider cannot say", async () => {
      provider.browser = () => json({ detail: "upstream" }, 500);
      const { mem, deps } = setup(
        [taskRow({ status: "finished" })],
        [sessionRow({ live_state: "none" })],
      );

      expect(await takeOverBrowser(ENV, ME, deps)).toMatchObject({ kind: "error", status: 502 });
      expect(mem.tables.browser_sessions[0]).toMatchObject({
        live_state: "none",
        provider_browser_id: "bu-browser-1",
      });
    });
  });

  it("changes nothing when the provider refuses the cancel", async () => {
    provider.cancel = () => json({ detail: "upstream" }, 500);
    const { mem, deps } = setup();

    const result = await takeOverBrowser(ENV, ME, deps);

    expect(result).toMatchObject({ kind: "error", status: 502 });
    expect(mem.tables.browser_tasks[0]).toMatchObject({ status: "running" });
    expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "agent" });
  });

  it("touches nothing of somebody else's", async () => {
    const { mem, deps } = setup();

    const result = await takeOverBrowser(ENV, { ...ME, userId: "user-2" }, deps);

    expect(result).toMatchObject({ kind: "error", status: 404 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "agent" });
    expect(mem.tables.browser_tasks[0]).toMatchObject({ status: "running" });
  });
});

describe("handBackBrowser", () => {
  function inTheirHands() {
    return setup(
      [taskRow({ status: "stopped", stop_reason: "handed_to_person" })],
      [sessionRow({ live_state: "human", human_since: "2026-10-10T11:58:00.000Z" })],
    );
  }

  it("runs the original task once more, in the same browser, free", async () => {
    const { mem, deps } = inTheirHands();

    const result = await handBackBrowser(ENV, { ...ME, original: ORIGINAL }, deps);

    expect(result).toEqual({ kind: "ok", browserTaskId: "bt-2" });
    const body = sentBody(/\/runs$/);
    expect(body).toMatchObject({
      task: runTask(`${HAND_BACK_TASK}read the pricing table`),
      sessionId: "bu-session-1",
      outputSchema: OUTCOME_SCHEMA,
      maxCostUsd: RUN_COST_CAP_USD,
      browserSettings: { profileId: "bu-profile-1", proxyCountryCode: "de" },
    });
    expect(String(body.task)).toContain(
      "The person has handled the browser themselves (for example signed in). " +
        "Continue the original task: read the pricing table",
    );
    expect(recordBrowserTask.mock.calls[0][1]).toMatchObject({
      providerRunId: "run-2",
      browserSessionId: "bs-1",
      retryOf: "bt-0",
      task: "read the pricing table",
    });
  });

  /**
   * `recordRunStart` skips its whole update while the person holds the
   * controls, so the hand-back writes the run-start bookkeeping itself — the
   * cursor above all: the old run's last event id would skip the new run's
   * first events.
   */
  it("gives the agent the controls and starts the event log over", async () => {
    const { mem, deps } = inTheirHands();

    await handBackBrowser(ENV, { ...ME, original: ORIGINAL }, deps);

    expect(mem.tables.browser_sessions[0]).toMatchObject({
      live_state: "agent",
      events_cursor: 0,
      last_run_at: NOW.toISOString(),
      human_since: null,
      human_started_at: null,
      claimed_at: null,
    });
  });

  /**
   * Final-review I2: Done on a browser the sweep or the provider has already
   * stopped. A run would be created in the session — the provider would even
   * give it a new browser — but the sign-in the person performed was in the
   * one that is gone, so the free retry would be spent on a fresh wall.
   */
  it("refuses Done on a browser that is gone, without spending the retry", async () => {
    provider.browser = (id) => json({ id, status: "stopped" });
    provider.list = () => json({ items: [] });
    const { mem, deps } = inTheirHands();

    const result = await handBackBrowser(ENV, { ...ME, original: ORIGINAL }, deps);

    expect(result).toMatchObject({ kind: "error", status: 409 });
    expect((result as { message: string }).message).toMatch(/ask the agent again/i);
    expect(calls().some((c) => c.endsWith("/runs"))).toBe(false);
    expect(recordBrowserTask).not.toHaveBeenCalled();
    // Nobody's hands, and no browser named: the panel shows neither a Done
    // that can only fail nor a sign-in prompt for a browser that is gone.
    expect(mem.tables.browser_sessions[0]).toMatchObject({
      live_state: "none",
      provider_browser_id: null,
    });
  });

  it("gives the browser back to the person when the provider cannot say whether it is open", async () => {
    provider.browser = () => json({ detail: "upstream" }, 500);
    const { mem, deps } = inTheirHands();

    const result = await handBackBrowser(ENV, { ...ME, original: ORIGINAL }, deps);

    expect(result).toMatchObject({ kind: "error", status: 502 });
    expect(recordBrowserTask).not.toHaveBeenCalled();
    expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "human" });
  });

  it("refuses a second hand-back of the same take-over without calling the provider", async () => {
    const { deps } = inTheirHands();

    await handBackBrowser(ENV, { ...ME, original: ORIGINAL }, deps);
    fetchMock.mockClear();
    const again = await handBackBrowser(ENV, { ...ME, original: ORIGINAL }, deps);

    expect(again).toMatchObject({ kind: "error", status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(recordBrowserTask).toHaveBeenCalledOnce();
  });

  it("refuses a task that is itself a retry", async () => {
    const { mem, deps } = inTheirHands();

    const result = await handBackBrowser(
      ENV,
      { ...ME, original: { ...ORIGINAL, retry_of: "bt-earlier" } },
      deps,
    );

    expect(result).toMatchObject({ kind: "error", status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "human" });
  });

  it("gives the browser back to the person when the provider refuses the run", async () => {
    provider.create = () => json({ detail: "busy" }, 409);
    const { mem, deps } = inTheirHands();

    const result = await handBackBrowser(ENV, { ...ME, original: ORIGINAL }, deps);

    expect(result).toMatchObject({ kind: "error", status: 409 });
    expect(recordBrowserTask).not.toHaveBeenCalled();
    expect(mem.tables.browser_sessions[0]).toMatchObject({
      live_state: "human",
      human_since: NOW.toISOString(),
      human_started_at: NOW.toISOString(),
    });
  });

  /**
   * Ruling R19: the hand-back can be the first run to want a jar — the
   * `browse` that opened this browser could not provision one — and the
   * sign-in the person just performed is saved only into a profile the
   * browser runs with.
   */
  it("provisions the person's jar when the hand-back is the first run to need one, for the next browser", async () => {
    const { mem, deps } = inTheirHands();
    mem.tables.browser_profiles.length = 0;
    mem.tables.browser_sessions[0].profile_id = null;

    const result = await handBackBrowser(ENV, { ...ME, original: ORIGINAL }, deps);

    expect(result).toMatchObject({ kind: "ok" });
    expect(calls().filter((c) => c === `POST ${V4_BASE}/profiles`)).toHaveLength(1);
    // But not sent to THIS browser, which was opened without a profile: the
    // provider would decline to reuse it and open a fresh one, which has lost
    // the sign-in the person just performed.
    expect(sentBody(/\/runs$/)).not.toHaveProperty("browserSettings");
    expect(mem.tables.browser_profiles).toHaveLength(1);
    expect(mem.tables.browser_profiles[0]).toMatchObject({ provider_profile_id: "bu-profile-new" });
  });

  /**
   * The provider's contract on `profileId`: an explicit value mismatching the
   * live browser's profile declines reuse and provisions a fresh browser, and a
   * different profile on a session is a 400. So the hand-back names the jar
   * only when it is the one this browser was opened with.
   */
  it("sends the jar into the browser that was opened with it", async () => {
    const { deps } = inTheirHands();

    await handBackBrowser(ENV, { ...ME, original: ORIGINAL }, deps);

    const body = sentBody(/\/runs$/);
    expect(body.sessionId).toBe("bu-session-1");
    expect(body.browserSettings).toEqual({ profileId: "bu-profile-1", proxyCountryCode: "de" });
  });

  it("sends no jar into a browser that was opened without one", async () => {
    const { mem, deps } = inTheirHands();
    mem.tables.browser_sessions[0].profile_id = null;

    const result = await handBackBrowser(ENV, { ...ME, original: ORIGINAL }, deps);

    expect(result).toMatchObject({ kind: "ok" });
    const body = sentBody(/\/runs$/);
    expect(body.sessionId).toBe("bu-session-1");
    expect(body).not.toHaveProperty("browserSettings");
  });

  it("sends no jar into a browser that was opened with a different one", async () => {
    const { mem, deps } = inTheirHands();
    mem.tables.browser_sessions[0].profile_id = "bp-other";

    await handBackBrowser(ENV, { ...ME, original: ORIGINAL }, deps);

    expect(sentBody(/\/runs$/)).not.toHaveProperty("browserSettings");
  });

  it("still continues, with no jar, when one cannot be provisioned", async () => {
    provider.createProfile = () => json({ detail: "Profile limit exceeded" }, 402);
    const { mem, deps } = inTheirHands();
    mem.tables.browser_profiles.length = 0;

    const result = await handBackBrowser(ENV, { ...ME, original: ORIGINAL }, deps);

    expect(result).toMatchObject({ kind: "ok" });
    expect(sentBody(/\/runs$/)).not.toHaveProperty("browserSettings");
  });

  it("cancels the run and gives the browser back when the run cannot be recorded", async () => {
    recordBrowserTask.mockResolvedValueOnce(null);
    provider.cancel = () => json({ id: "run-2", status: "cancelled" });
    const { mem, deps } = inTheirHands();

    const result = await handBackBrowser(ENV, { ...ME, original: ORIGINAL }, deps);

    expect(result).toMatchObject({ kind: "error", status: 500 });
    expect(calls()).toContain(`POST ${V4_BASE}/runs/run-2/cancel`);
    expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "human" });
  });
});

describe("liveBrowser", () => {
  it("re-reads the live URL for the browser on the row, every time it is asked", async () => {
    const { deps } = setup();

    const first = await liveBrowser(ENV, ME, deps);
    const second = await liveBrowser(ENV, ME, deps);

    expect(first).toEqual({ kind: "ok", liveUrl: FAKE_LIVE, liveState: "agent" });
    expect(second).toEqual(first);
    expect(calls()).toEqual([
      `GET ${V4_BASE}/browsers/bu-browser-1`,
      `GET ${V4_BASE}/browsers/bu-browser-1`,
    ]);
  });

  it("finds the session's active browser when the stored one has stopped, and keeps its id", async () => {
    provider.browser = (id) =>
      id === "bu-browser-1"
        ? json({ id, status: "stopped", liveUrl: null })
        : json({ id, status: "active", liveUrl: FAKE_LIVE, cdpUrl: FAKE_CDP });
    provider.list = () =>
      json({
        items: [
          { id: "bu-browser-1", status: "stopped", liveUrl: FAKE_LIVE },
          { id: "bu-browser-2", status: "active", liveUrl: FAKE_LIVE, cdpUrl: FAKE_CDP },
        ],
      });
    const { mem, deps } = setup();

    const result = await liveBrowser(ENV, ME, deps);

    expect(result).toMatchObject({ kind: "ok", liveUrl: FAKE_LIVE });
    expect(mem.tables.browser_sessions[0].provider_browser_id).toBe("bu-browser-2");
    expect(JSON.stringify(mem.calls.map((c) => c.values ?? null))).not.toContain(
      "browser-use.example",
    );
  });

  it("looks the browser up when no event has named one yet", async () => {
    provider.list = () => json({ items: [{ id: "bu-browser-3", status: "active" }] });
    const { mem, deps } = setup([taskRow()], [sessionRow({ provider_browser_id: null })]);

    const result = await liveBrowser(ENV, ME, deps);

    expect(result).toMatchObject({ kind: "ok", liveUrl: FAKE_LIVE });
    expect(mem.tables.browser_sessions[0].provider_browser_id).toBe("bu-browser-3");
  });

  it("409s when nothing is live", async () => {
    provider.browser = (id) => json({ id, status: "stopped" });
    provider.list = () => json({ items: [{ id: "bu-browser-1", status: "stopped" }] });
    const { deps } = setup();

    const result = await liveBrowser(ENV, ME, deps);

    expect(result).toMatchObject({ kind: "error", status: 409 });
  });

  it("409s a browser that never opened", async () => {
    const { deps } = setup(
      [],
      [sessionRow({ provider_session_id: null, provider_browser_id: null })],
    );

    expect(await liveBrowser(ENV, ME, deps)).toMatchObject({ kind: "error", status: 409 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers 404 for somebody else's browser", async () => {
    const { deps } = setup();

    expect(await liveBrowser(ENV, { ...ME, userId: "user-2" }, deps)).toMatchObject({
      kind: "error",
      status: 404,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * "Treat the URL as a credential." The provider's own error bodies and list
   * items carry it; nothing on this path may hand it to a log line or put it
   * in an error string, however the path fails.
   */
  it("puts the URL in no error string and no console line when the provider fails", async () => {
    provider.browser = (id) =>
      id === "bu-browser-1"
        ? json({ id, status: "stopped", liveUrl: FAKE_LIVE, cdpUrl: FAKE_CDP })
        : json({ detail: `could not reach ${FAKE_LIVE} (cdp ${FAKE_CDP})` }, 500);
    provider.list = () =>
      json({
        items: [{ id: "bu-browser-2", status: "active", liveUrl: FAKE_LIVE, cdpUrl: FAKE_CDP }],
      });
    const { deps } = setup([taskRow()], [sessionRow()], (ctx) =>
      ctx.table === "browser_sessions" && ctx.op === "update"
        ? { data: null, error: { message: "check violation", code: "23514" } }
        : undefined,
    );

    const result = await liveBrowser(ENV, ME, deps);

    expect(result).toMatchObject({ kind: "error", status: 502 });
    expect(JSON.stringify(result)).not.toContain("browser-use.example");
    expect(spoken.length).toBeGreaterThan(0);
    expect(JSON.stringify(spoken)).not.toContain("browser-use.example");
  });

  it("logs nothing at all on the way to a URL", async () => {
    const { deps } = setup();

    await liveBrowser(ENV, ME, deps);

    expect(spoken).toEqual([]);
  });
});

describe("stopConversationBrowser", () => {
  it("stops the session's live browser and gives the controls to nobody", async () => {
    provider.list = () =>
      json({
        items: [
          { id: "bu-browser-1", status: "stopped" },
          { id: "bu-browser-2", status: "active" },
        ],
      });
    const { mem, deps } = setup(
      [],
      [
        sessionRow({
          live_state: "human",
          human_since: "2026-10-10T11:58:00.000Z",
          claimed_at: "x",
        }),
      ],
    );

    const result = await stopConversationBrowser(ENV, ME, deps);

    expect(result).toEqual({ kind: "ok" });
    expect(calls()).toContain(`PATCH ${V4_BASE}/browsers/bu-browser-2`);
    expect(sentBody(/\/browsers\/bu-browser-2$/)).toEqual({ action: "stop" });
    expect(mem.tables.browser_sessions[0]).toMatchObject({
      live_state: "none",
      human_since: null,
      human_started_at: null,
      claimed_at: null,
      // Ruling R20's marker: a confirmed stop means the row names no browser,
      // so neither the idle sweep nor the panel's `browserReady` sees one.
      provider_browser_id: null,
    });
  });

  /**
   * Must-fix minor: the close saved the jar at the provider and then said
   * nothing about it here, so Settings → Browser sign-ins showed the list from
   * before. It reads the jar back the way the sweep does — the same helper,
   * the same wait for the provider's late write.
   */
  it("reads the jar back after the stop, as the sweep does", async () => {
    let read = 0;
    provider.list = () => json({ items: [{ id: "bu-browser-1", status: "active" }] });
    provider.profile = (id) => json({ id, cookieDomains: read++ < 2 ? [] : ["linkedin.com"] });
    const { mem, deps } = setup(
      [],
      [
        sessionRow({
          live_state: "human",
          human_since: "2026-10-10T11:58:00.000Z",
          profile_id: "bp-1",
        }),
      ],
    );

    expect(await stopConversationBrowser(ENV, ME, deps)).toEqual({ kind: "ok" });

    expect(calls()).toContain(`GET ${V4_BASE}/profiles/bu-profile-1`);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(mem.tables.browser_profiles[0]).toMatchObject({
      cookie_domains: ["linkedin.com"],
      last_used_at: NOW.toISOString(),
    });
  });

  it("does not read the jar when the stop failed, which saved nothing", async () => {
    provider.list = () => json({ items: [{ id: "bu-browser-1", status: "active" }] });
    provider.stop = () => json({ detail: "upstream" }, 500);
    const { deps } = setup([], [sessionRow({ live_state: "human", profile_id: "bp-1" })]);

    await stopConversationBrowser(ENV, ME, deps);

    expect(calls().some((c) => c.includes("/profiles/"))).toBe(false);
  });

  it("says, when the stop fails, to try again rather than promising when it will happen", async () => {
    provider.list = () => json({ items: [{ id: "bu-browser-1", status: "active" }] });
    provider.stop = () => json({ detail: "upstream" }, 500);
    const { deps } = setup([], [sessionRow({ live_state: "none" })]);

    const result = await stopConversationBrowser(ENV, ME, deps);

    expect(result).toMatchObject({ kind: "error", status: 502 });
    expect((result as { message: string }).message).toMatch(/try closing it again/i);
    expect((result as { message: string }).message).not.toMatch(/shortly/i);
  });

  it("is idempotent: a browser already gone is a browser stopped", async () => {
    provider.list = () => json({ items: [{ id: "bu-browser-1", status: "stopped" }] });
    const { mem, deps } = setup([], [sessionRow({ live_state: "none" })]);

    expect(await stopConversationBrowser(ENV, ME, deps)).toEqual({ kind: "ok" });
    expect(await stopConversationBrowser(ENV, ME, deps)).toEqual({ kind: "ok" });
    expect(calls().some((c) => c.startsWith("PATCH"))).toBe(false);
    expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "none" });
  });

  it("treats the provider's 404 on the stop as stopped", async () => {
    provider.list = () => json({ items: [{ id: "bu-browser-1", status: "active" }] });
    provider.stop = () => json({ detail: "not found" }, 404);
    const { mem, deps } = setup([], [sessionRow({ live_state: "human" })]);

    expect(await stopConversationBrowser(ENV, ME, deps)).toEqual({ kind: "ok" });
    expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "none" });
  });

  /**
   * A stop that fails has not saved the jar, so the row stays in the
   * person's hands with its clock standing: the sweep finds it again.
   */
  it("leaves human_since standing when the stop fails", async () => {
    provider.list = () => json({ items: [{ id: "bu-browser-1", status: "active" }] });
    provider.stop = () => json({ detail: "upstream" }, 500);
    const { mem, deps } = setup(
      [],
      [sessionRow({ live_state: "human", human_since: "2026-10-10T11:58:00.000Z" })],
    );

    const result = await stopConversationBrowser(ENV, ME, deps);

    expect(result).toMatchObject({ kind: "error", status: 502 });
    expect(mem.tables.browser_sessions[0]).toMatchObject({
      live_state: "human",
      human_since: "2026-10-10T11:58:00.000Z",
      // Still named, so the sweep finds the browser again.
      provider_browser_id: "bu-browser-1",
    });
  });

  it("answers 404 for somebody else's browser and stops nothing", async () => {
    const { deps } = setup();

    expect(await stopConversationBrowser(ENV, { ...ME, userId: "user-2" }, deps)).toMatchObject({
      kind: "error",
      status: 404,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
