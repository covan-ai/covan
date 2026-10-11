import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { memoryDb, type Row } from "../../test-support/memory-db";
import { eventText, pollConversationBrowser } from "./live";
import { pollDueBrowserTasks, type BrowserTaskRow, type FinishedTask } from "./poller";
import { V4_BASE } from "./v4";

/**
 * The open tab's clock. `fetch` is mocked and `v4.ts` is real, so what is
 * asserted is what would cross the wire and what the provider's own body would
 * have put in a row — the URL scrub included.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const ENV = { BROWSER_USE_API_KEY: "bu_test" } as RoutineEnv;
const NOW = new Date("2026-10-10T12:00:00.000Z");
const FAKE_LIVE = "https://live.browser-use.example/v/abc?token=live-secret";
const FAKE_CDP = "wss://cdp.browser-use.example/devtools/browser/cdp-secret";

function taskRow(over: Row = {}): Row {
  return {
    id: "bt-1",
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
    provider_session_id: "bu-session-1",
    provider_browser_id: null,
    events_cursor: 3,
    ...over,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type Provider = {
  status: string | (() => string);
  events?: unknown;
  summary?: unknown;
  browsers?: () => Response;
  statusCode?: number;
};

let provider: Provider;

function route(url: string): Response {
  const path = url.slice(V4_BASE.length);
  if (/^\/runs\/[^/]+\/status$/.test(path)) {
    if (provider.statusCode) return json({ detail: "nope" }, provider.statusCode);
    const status = typeof provider.status === "function" ? provider.status() : provider.status;
    return json({ status });
  }
  if (/^\/runs\/[^/]+\/events\?/.test(path)) {
    return json(provider.events ?? { events: [], nextAfter: null, hasMore: false });
  }
  if (/^\/runs\/[^/?]+$/.test(path)) return json(provider.summary ?? {});
  if (path.startsWith("/browsers?agentSessionId=")) {
    if (provider.browsers) return provider.browsers();
    return json({ items: [{ id: "bu-browser-7", status: "active", liveUrl: FAKE_LIVE }] });
  }
  throw new Error(`unexpected provider call ${url}`);
}

const deliver = vi.fn(
  async (
    _row: BrowserTaskRow,
    _outcome: FinishedTask,
    _env: RoutineEnv,
    _db: SupabaseClient,
  ): Promise<void> => {},
);

function setup(tasks: Row[] = [taskRow()], sessions: Row[] = [sessionRow()]) {
  const mem = memoryDb({ browser_tasks: tasks, browser_sessions: sessions });
  const deps = { db: mem.db as unknown as SupabaseClient, now: () => NOW, deliver };
  return { mem, deps };
}

const calledUrls = () => fetchMock.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => route(url));
  deliver.mockReset();
  provider = { status: "running" };
  // The provider-error paths log on purpose; the suite output stays readable.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a run still going", () => {
  it("drains the run's events from the stored cursor, and advances it", async () => {
    provider.events = {
      events: [
        {
          id: 4,
          ts: "2026-10-10T11:59:58Z",
          type: "agent.step",
          data: { summary: "opened the page" },
        },
        {
          id: 5,
          ts: "2026-10-10T11:59:59Z",
          type: "agent.step",
          data: { summary: "read the table" },
        },
      ],
      nextAfter: 5,
      hasMore: false,
    };
    const { mem, deps } = setup();

    const live = await pollConversationBrowser(
      ENV,
      { chatSessionId: "chat-1", userId: "user-1" },
      deps,
    );

    expect(calledUrls()).toEqual([
      `${V4_BASE}/runs/run-1/status`,
      `${V4_BASE}/runs/run-1/events?after=3`,
    ]);
    expect(mem.tables.browser_sessions[0].events_cursor).toBe(5);
    // Compare-and-set: a run that started since (recordRunStart resets the
    // cursor) is not overwritten by a poll that read the old one.
    const write = mem.callsTo("browser_sessions").find((c) => c.op === "update");
    expect(write?.filters).toContainEqual({ column: "events_cursor", value: 3, kind: "eq" });
    expect(live.events).toEqual([
      { ts: "2026-10-10T11:59:58Z", type: "agent.step", text: "opened the page" },
      { ts: "2026-10-10T11:59:59Z", type: "agent.step", text: "read the table" },
    ]);
    expect(live.delivered).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("takes the cursor from the last event's id when the provider names none", async () => {
    provider.events = {
      events: [{ id: 9, ts: "t", type: "agent.step", data: {} }],
      hasMore: false,
    };
    const { mem, deps } = setup();
    await pollConversationBrowser(ENV, { chatSessionId: "chat-1", userId: "user-1" }, deps);
    expect(mem.tables.browser_sessions[0].events_cursor).toBe(9);
  });

  it("never writes a cursor that is not a number", async () => {
    provider.events = {
      events: [{ id: "not-a-number", ts: "t", type: "agent.step", data: { note: "x" } }],
      hasMore: false,
    };
    const { mem, deps } = setup();
    await pollConversationBrowser(ENV, { chatSessionId: "chat-1", userId: "user-1" }, deps);
    expect(mem.tables.browser_sessions[0].events_cursor).toBe(3);
    for (const call of mem.callsTo("browser_sessions")) {
      expect(Number.isNaN(call.values?.events_cursor)).toBe(false);
    }
  });

  it("records the browser from browser.ready, and no URL anywhere", async () => {
    provider.events = {
      events: [
        {
          id: 4,
          ts: "2026-10-10T11:59:58Z",
          type: "browser.ready",
          data: { browser_session_id: "bu-browser-9", live_view_url: FAKE_LIVE, cdp_url: FAKE_CDP },
        },
      ],
      nextAfter: 4,
      hasMore: false,
    };
    const { mem, deps } = setup();

    const live = await pollConversationBrowser(
      ENV,
      { chatSessionId: "chat-1", userId: "user-1" },
      deps,
    );

    expect(mem.tables.browser_sessions[0].provider_browser_id).toBe("bu-browser-9");
    expect(live.session?.browserReady).toBe(true);

    const everything = JSON.stringify([mem.tables, mem.calls, live]);
    expect(everything).not.toContain("live-secret");
    expect(everything).not.toContain("cdp-secret");
    expect(live.events).toHaveLength(1);
    expect(live.events[0].type).toBe("browser.ready");
    expect(live.events[0].text).not.toContain(FAKE_LIVE);
    // The browser id is a provider id: granted to no client role, so it is not
    // the line the panel shows either.
    expect(JSON.stringify(live)).not.toContain("bu-browser-9");
  });

  it("follows the browser to a new id on browser.reattached", async () => {
    provider.events = {
      events: [
        {
          id: 4,
          ts: "t",
          type: "browser.reattached",
          data: { browser_session_id: "bu-browser-10" },
        },
      ],
      nextAfter: 4,
      hasMore: false,
    };
    const { mem, deps } = setup([taskRow()], [sessionRow({ provider_browser_id: "bu-browser-9" })]);
    await pollConversationBrowser(ENV, { chatSessionId: "chat-1", userId: "user-1" }, deps);
    expect(mem.tables.browser_sessions[0].provider_browser_id).toBe("bu-browser-10");
  });

  it("shows the last eight events, and renders a type it has never seen", async () => {
    provider.events = {
      events: Array.from({ length: 12 }, (_, i) => ({
        id: i + 4,
        ts: `t${i + 4}`,
        type: i === 11 ? "something.new" : "agent.step",
        data: i === 11 ? { count: 3, words: "y".repeat(300) } : { summary: `step ${i + 4}` },
      })),
      nextAfter: 15,
      hasMore: false,
    };
    const { deps } = setup();
    const live = await pollConversationBrowser(
      ENV,
      { chatSessionId: "chat-1", userId: "user-1" },
      deps,
    );
    expect(live.events).toHaveLength(8);
    expect(live.events[0].ts).toBe("t8");
    expect(live.events[7].type).toBe("something.new");
    expect(live.events[7].text.length).toBeLessThanOrEqual(120);
    expect(live.events[7].text.startsWith("yyy")).toBe(true);
  });

  it("writes nothing to the browser when there was nothing new", async () => {
    const { mem, deps } = setup();
    await pollConversationBrowser(ENV, { chatSessionId: "chat-1", userId: "user-1" }, deps);
    expect(mem.callsTo("browser_sessions").filter((c) => c.op === "update")).toEqual([]);
  });

  it("leaves a provider error for the cron to retry", async () => {
    provider.statusCode = 500;
    const { mem, deps } = setup();
    const live = await pollConversationBrowser(
      ENV,
      { chatSessionId: "chat-1", userId: "user-1" },
      deps,
    );
    expect(live.delivered).toBe(false);
    expect(mem.tables.browser_tasks[0].status).toBe("running");
    expect(calledUrls()).toEqual([`${V4_BASE}/runs/run-1/status`]);
  });
});

describe("a run that has ended", () => {
  it("settles it inline and says so", async () => {
    provider.status = "completed";
    provider.summary = {
      id: "run-1",
      status: "completed",
      result: '{"status":"login_required","host":"linkedin.com"}',
      output: null,
      totalCostUsd: "0.09",
      sessionId: "bu-session-1",
    };
    const { mem, deps } = setup();

    const live = await pollConversationBrowser(
      ENV,
      { chatSessionId: "chat-1", userId: "user-1" },
      deps,
    );

    expect(live.delivered).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][1].reported).toEqual({
      status: "login_required",
      host: "linkedin.com",
      answer: null,
    });
    expect(mem.tables.browser_tasks[0]).toMatchObject({ status: "failed", cost_usd: 0.09 });
    // R4: the agent let go, and the response says so without a second read.
    expect(mem.tables.browser_sessions[0].live_state).toBe("none");
    expect(live.session?.liveState).toBe("none");
    // The run ended before any poll had named its browser, so the settle asks
    // the provider for it once, for the idle sweep's marker (ruling R20).
    expect(calledUrls()).toEqual([
      `${V4_BASE}/runs/run-1/status`,
      `${V4_BASE}/runs/run-1`,
      `${V4_BASE}/browsers?agentSessionId=bu-session-1`,
    ]);
    expect(mem.tables.browser_sessions[0].provider_browser_id).toBe("bu-browser-7");
  });

  it("says the browser is ready when the settle itself just named it", async () => {
    provider.status = "completed";
    provider.summary = {
      id: "run-1",
      status: "completed",
      result: '{"status":"login_required","host":"linkedin.com"}',
      output: null,
    };
    const { mem, deps } = setup();

    const live = await pollConversationBrowser(
      ENV,
      { chatSessionId: "chat-1", userId: "user-1" },
      deps,
    );

    // The session was read BEFORE the settle, naming no browser; the settle
    // then recorded one. The response must say what the row says now, or the
    // sign-in prompt (gated on `browserReady`) stays hidden until a refocus.
    expect(mem.tables.browser_sessions[0].provider_browser_id).toBe("bu-browser-7");
    expect(live.session?.browserReady).toBe(true);
    // And the provider's id is still nowhere in the response.
    expect(JSON.stringify(live)).not.toContain("bu-browser-7");
  });

  it("says the browser is not ready when the settle could not name one", async () => {
    provider.status = "completed";
    provider.summary = { id: "run-1", status: "completed", result: "done", output: null };
    provider.browsers = () => json({ items: [] });
    const { mem, deps } = setup();

    const live = await pollConversationBrowser(
      ENV,
      { chatSessionId: "chat-1", userId: "user-1" },
      deps,
    );

    expect(mem.tables.browser_sessions[0].provider_browser_id).toBeNull();
    expect(live.session?.browserReady).toBe(false);
  });

  it("does not ask for the browser again when a poll already named it", async () => {
    provider.status = "completed";
    provider.summary = { id: "run-1", status: "completed", result: "done", output: null };
    const { deps } = setup([taskRow()], [sessionRow({ provider_browser_id: "bu-browser-1" })]);

    await pollConversationBrowser(ENV, { chatSessionId: "chat-1", userId: "user-1" }, deps);

    expect(calledUrls()).toEqual([`${V4_BASE}/runs/run-1/status`, `${V4_BASE}/runs/run-1`]);
  });

  it("does not deliver twice when the open tab and the cron settle the same run together", async () => {
    provider.status = "completed";
    provider.summary = {
      id: "run-1",
      status: "completed",
      result: "Starter $29, Pro $99",
      output: null,
      totalCostUsd: "0.09",
      sessionId: "bu-session-1",
    };
    const { mem, deps } = setup();
    const cronDb = {
      ...mem.db,
      // What `claim_due_browser_tasks` would hand the cron: the same row.
      rpc: async () => ({ data: [{ ...mem.tables.browser_tasks[0] }], error: null }),
    } as unknown as SupabaseClient;

    const [, tick] = await Promise.all([
      pollConversationBrowser(ENV, { chatSessionId: "chat-1", userId: "user-1" }, deps),
      pollDueBrowserTasks(ENV, { db: cronDb, now: () => NOW, finish: deliver }),
      pollConversationBrowser(ENV, { chatSessionId: "chat-1", userId: "user-1" }, deps),
    ]);

    expect(tick.claimed).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(mem.tables.browser_tasks[0].status).toBe("finished");
  });
});

/**
 * Ruling R21: human mode lasts while the tab is open. The sweep stops a
 * browser ten minutes past `human_since`, and a person still signing in — a
 * slow 2FA, an email code — would otherwise lose the browser under their
 * hands at minute ten. So the open tab's poll is the heartbeat: about once a
 * minute it moves `human_since` to now, and the sweep's ten minutes count from
 * the tab going quiet.
 */
describe("the tab that keeps a person's browser", () => {
  const poll = (deps: ReturnType<typeof setup>["deps"]) =>
    pollConversationBrowser(ENV, { chatSessionId: "chat-1", userId: "user-1" }, deps);

  it("moves human_since to now once it is more than a minute old", async () => {
    const { mem, deps } = setup(
      [],
      [sessionRow({ live_state: "human", human_since: "2026-10-10T11:58:59.000Z" })],
    );

    const live = await poll(deps);

    expect(mem.tables.browser_sessions[0].human_since).toBe(NOW.toISOString());
    expect(live.session?.humanSince).toBe(NOW.getTime());
  });

  it("writes nothing while the clock is less than a minute old", async () => {
    const { mem, deps } = setup(
      [],
      [sessionRow({ live_state: "human", human_since: "2026-10-10T11:59:01.000Z" })],
    );

    await poll(deps);

    expect(mem.callsTo("browser_sessions").filter((c) => c.op === "update")).toEqual([]);
  });

  it.each(["agent", "none"])("never touches the clock of a browser in %s mode", async (state) => {
    const { mem, deps } = setup(
      [],
      [sessionRow({ live_state: state, human_since: "2026-10-10T11:00:00.000Z" })],
    );

    await poll(deps);

    expect(mem.callsTo("browser_sessions").filter((c) => c.op === "update")).toEqual([]);
  });

  /**
   * Conditional on the row still being in human hands with the clock this
   * poll read: a Done that landed meanwhile has moved the row to `agent`, and
   * a second tab that already bumped it has moved the clock — neither is
   * overwritten, and two open tabs make one write a minute between them.
   */
  it("bumps with a compare-and-set on what it read", async () => {
    const OLD = "2026-10-10T11:58:00.000Z";
    const { mem, deps } = setup([], [sessionRow({ live_state: "human", human_since: OLD })]);

    await poll(deps);

    const bump = mem.callsTo("browser_sessions").find((c) => c.op === "update");
    expect(bump?.values).toEqual({ human_since: NOW.toISOString() });
    expect(bump?.filters).toEqual(
      expect.arrayContaining([
        { column: "id", value: "bs-1", kind: "eq" },
        { column: "user_id", value: "user-1", kind: "eq" },
        { column: "live_state", value: "human", kind: "eq" },
        { column: "human_since", value: OLD, kind: "eq" },
      ]),
    );
  });

  it("answers the clock as it stands when another tab bumped it first", async () => {
    const { mem, deps } = setup(
      [],
      [sessionRow({ live_state: "human", human_since: "2026-10-10T11:58:00.000Z" })],
    );
    let read = false;
    const db = {
      from: (table: string) => {
        const chain = mem.db.from(table);
        // The other tab's bump lands between this poll's read and its write.
        if (table === "browser_sessions" && read) {
          mem.tables.browser_sessions[0].human_since = "2026-10-10T11:59:50.000Z";
        }
        if (table === "browser_sessions") read = true;
        return chain;
      },
    } as unknown as SupabaseClient;

    const live = await poll({ ...deps, db });

    expect(mem.tables.browser_sessions[0].human_since).toBe("2026-10-10T11:59:50.000Z");
    expect(live.session?.humanSince).toBe(Date.parse("2026-10-10T11:58:00.000Z"));
  });
});

describe("whose rows", () => {
  it("polls only the caller's own running v4 run in this conversation", async () => {
    const { mem, deps } = setup([taskRow({ user_id: "user-2" })]);
    const live = await pollConversationBrowser(
      ENV,
      { chatSessionId: "chat-1", userId: "user-1" },
      deps,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(live.delivered).toBe(false);
    const read = mem.callsTo("browser_tasks")[0];
    expect(read.filters).toEqual(
      expect.arrayContaining([
        { column: "session_id", value: "chat-1", kind: "eq" },
        { column: "user_id", value: "user-1", kind: "eq" },
        { column: "api_version", value: "v4", kind: "eq" },
        { column: "status", value: ["queued", "running"], kind: "in" },
      ]),
    );
  });

  it("leaves a v2 task to the cron, which drains it", async () => {
    const { deps } = setup([taskRow({ api_version: "v2" })]);
    await pollConversationBrowser(ENV, { chatSessionId: "chat-1", userId: "user-1" }, deps);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("answers the panel's state with no provider id in it", async () => {
    const { deps } = setup(
      [],
      [
        sessionRow({
          live_state: "human",
          human_since: "2026-10-10T11:59:30.000Z",
          provider_browser_id: "bu-browser-9",
        }),
      ],
    );
    const live = await pollConversationBrowser(
      ENV,
      { chatSessionId: "chat-1", userId: "user-1" },
      deps,
    );
    expect(live).toEqual({
      session: {
        id: "bs-1",
        liveState: "human",
        humanSince: Date.parse("2026-10-10T11:59:30.000Z"),
        browserReady: true,
      },
      events: [],
      delivered: false,
    });
    expect(JSON.stringify(live)).not.toMatch(/bu-browser|bu-session/);
  });

  it("answers no browser when the conversation has none yet", async () => {
    const { deps } = setup([], []);
    const live = await pollConversationBrowser(
      ENV,
      { chatSessionId: "chat-1", userId: "user-1" },
      deps,
    );
    expect(live).toEqual({ session: null, events: [], delivered: false });
  });

  it("calls the provider not at all on a deployment with no key", async () => {
    const { deps } = setup();
    await pollConversationBrowser(
      {} as RoutineEnv,
      { chatSessionId: "chat-1", userId: "user-1" },
      deps,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("eventText", () => {
  it("is the first text field, cut to 120 characters", () => {
    expect(eventText({ n: 1, a: "first", b: "second" })).toBe("first");
    const long = eventText({ a: "z".repeat(500) });
    expect(long.length).toBeLessThanOrEqual(120);
  });

  it("skips ids and bare URLs, so neither a provider id nor a live view can become the line", () => {
    expect(eventText({ browser_session_id: "bu-browser-9", sessionId: "bu-s" })).toBe("");
    expect(eventText({ live: FAKE_LIVE, cdp: FAKE_CDP, note: "clicked Pricing" })).toBe(
      "clicked Pricing",
    );
  });

  it("is empty, not absent, when there is nothing to say", () => {
    expect(eventText({})).toBe("");
    expect(eventText({ nested: { text: "deep" }, list: ["x"] })).toBe("");
  });
});
