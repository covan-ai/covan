import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { fakeDb, type Filter, type QueryContext } from "../../test-support/fake-db";
import { ensureBrowserSession, recordRunStart, releaseBrowserSession } from "./sessions";

const ENV = {} as RoutineEnv;
const NOW = new Date("2026-10-10T12:00:00.000Z");

type Row = Record<string, unknown>;

function at(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

/**
 * `eq`, `is` and `in` only, and anything else throws: the `is("provider_session_id",
 * null)` on the claim's fill and on the hand-back is the whole of what stops
 * one request overwriting another's browser, and the `in("status", …)` on the
 * in-flight read is what tells a running task from a settled one — so a double
 * that shrugged at a filter would let the module stop sending it and still pass.
 */
function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.kind === "eq") return row[f.column] === f.value;
    if (f.kind === "neq") return row[f.column] !== f.value;
    if (f.kind === "is") return (row[f.column] ?? null) === f.value;
    if (f.kind === "in") return (f.value as unknown[]).includes(row[f.column]);
    throw new Error(`sessions.test: unexpected ${f.kind} on ${f.column}`);
  });
}

/** Every database call, in order, because insert-first is correct only by its sequence. */
const log: string[] = [];

function store(seed: Row[] = [], tasks: Row[] = []) {
  const rows = [...seed];
  const state = {
    /** The other tab's insert landing between our read and our own insert. */
    loseInsertRace: null as Row | null,
    /** The in-flight read failing. */
    tasksError: null as { message: string; code?: string } | null,
  };
  let ids = 0;
  const service = fakeDb({
    tables: {
      browser_tasks: {
        select: (ctx: QueryContext) => {
          log.push("select browser_tasks");
          if (state.tasksError) return { data: null, error: state.tasksError };
          const found = tasks.filter((r) => matches(r, ctx.filters)).slice(0, ctx.limit);
          return { data: found, error: null };
        },
      },
      browser_sessions: {
        select: (ctx: QueryContext) => {
          log.push("select browser_sessions");
          const found = rows.filter((r) => matches(r, ctx.filters));
          return { data: ctx.single ? (found[0] ?? null) : found, error: null };
        },
        insert: (ctx: QueryContext) => {
          log.push("insert browser_sessions");
          const values = ctx.values ?? {};
          // `on conflict (chat_session_id, user_id) do nothing ... returning`
          // answers an empty representation when it did nothing, which is how
          // the loser of the race learns it lost.
          if (state.loseInsertRace) {
            rows.push({ id: "bs-other", ...values, ...state.loseInsertRace });
            state.loseInsertRace = null;
            return { data: null, error: null };
          }
          if (
            rows.some(
              (r) => r.chat_session_id === values.chat_session_id && r.user_id === values.user_id,
            )
          ) {
            return { data: null, error: null };
          }
          const row = {
            id: `bs-${++ids}`,
            provider_session_id: null,
            live_state: "none",
            last_run_at: null,
            created_at: NOW.toISOString(),
            ...values,
          };
          rows.push(row);
          return { data: ctx.single ? row : [row], error: null };
        },
        update: (ctx: QueryContext) => {
          log.push("update browser_sessions");
          const hit = rows.filter((r) => matches(r, ctx.filters));
          for (const r of hit) Object.assign(r, ctx.values);
          return { data: ctx.single ? (hit[0] ?? null) : hit, error: null };
        },
        delete: (ctx: QueryContext) => {
          log.push("delete browser_sessions");
          for (const r of rows.filter((row) => matches(row, ctx.filters))) {
            rows.splice(rows.indexOf(r), 1);
          }
          return { data: null, error: null };
        },
      },
    },
  });
  return {
    rows,
    state,
    calls: service.calls,
    deps: { db: service.db as unknown as SupabaseClient, now: () => NOW },
  };
}

function sessionRow(over: Row = {}): Row {
  return {
    id: "bs-1",
    workspace_id: "ws-1",
    agent_id: "agent-1",
    user_id: "user-1",
    chat_session_id: "chat-1",
    profile_id: null,
    provider_session_id: "bu-session-1",
    live_state: "none",
    last_run_at: at(-30),
    created_at: at(-60),
    ...over,
  };
}

/** A row nobody is driving and no run is using: the ordinary answer. */
function ref(id: string, providerSessionId: string | null, profileId: string | null = null) {
  return { id, providerSessionId, liveState: "none", runInFlight: false, profileId };
}

const WHO = {
  workspaceId: "ws-1",
  agentId: "agent-1",
  userId: "user-1",
  chatSessionId: "chat-1",
  profileId: "prof-1",
};

let spoken: unknown[][];
let spies: { mockRestore: () => void }[];

beforeEach(() => {
  log.length = 0;
  spoken = [];
  spies = (["log", "warn", "error"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      spoken.push(args);
    }),
  );
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe("ensureBrowserSession", () => {
  it("claims the row for a conversation's first browse, naming no provider session yet", async () => {
    const s = store();

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    // The claim names the jar it was opened with, and answers it, so the run
    // that opens the browser knows which profile that browser will carry.
    expect(result).toEqual({ kind: "ok", value: ref("bs-1", null, "prof-1") });
    expect(log).toEqual(["select browser_sessions", "insert browser_sessions"]);
    // Everything the panel and the sweep later read off the row, from the
    // resolved context and nowhere else.
    expect(s.rows[0]).toMatchObject({
      workspace_id: "ws-1",
      agent_id: "agent-1",
      user_id: "user-1",
      chat_session_id: "chat-1",
      profile_id: "prof-1",
      provider_session_id: null,
    });
  });

  it("answers the provider session a follow-up in the same conversation continues", async () => {
    const s = store([sessionRow()]);

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    expect(result).toEqual({
      kind: "ok",
      value: ref("bs-1", "bu-session-1"),
    });
    // No insert at all on the ordinary follow-up; one read for a run in flight.
    expect(log).toEqual(["select browser_sessions", "select browser_tasks"]);
  });

  it("answers the profile an existing browser was opened with, for the follow-up to compare", async () => {
    const s = store([sessionRow({ profile_id: "prof-1" })]);

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    expect(result).toEqual({ kind: "ok", value: ref("bs-1", "bu-session-1", "prof-1") });
  });

  it("answers no profile for a browser that was opened without one, whatever the person has now", async () => {
    const s = store([sessionRow({ profile_id: null })]);

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    expect(result).toEqual({ kind: "ok", value: ref("bs-1", "bu-session-1", null) });
  });

  it("reads the row by conversation AND person, so a colleague in a shared chat gets a browser of their own", async () => {
    const s = store([sessionRow({ user_id: "user-2" })]);

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    expect(result).toEqual({ kind: "ok", value: ref("bs-1", null, "prof-1") });
    expect(s.rows).toHaveLength(2);
    const read = s.calls.find((c) => c.op === "select");
    expect(read?.filters).toEqual(
      expect.arrayContaining([
        { column: "chat_session_id", value: "chat-1", kind: "eq" },
        { column: "user_id", value: "user-1", kind: "eq" },
      ]),
    );
  });

  it("re-reads after losing the insert race, and joins the browser the winner opened", async () => {
    const s = store();
    s.state.loseInsertRace = { provider_session_id: "bu-theirs", created_at: at(-1) };

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    expect(result).toEqual({
      kind: "ok",
      value: ref("bs-other", "bu-theirs", "prof-1"),
    });
    expect(log).toEqual([
      "select browser_sessions",
      "insert browser_sessions",
      "select browser_sessions",
      "select browser_tasks",
    ]);
  });

  /**
   * The case the unique exists for. The winner holds the row and is between
   * its claim and the provider's answer; a loser that opened a session of its
   * own would leave a running browser nothing in this database could name.
   */
  it("refuses, rather than opening a second browser, while the winner is still opening one", async () => {
    const s = store();
    s.state.loseInsertRace = { provider_session_id: null, created_at: NOW.toISOString() };

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    expect(result).toMatchObject({ kind: "error", status: 409 });
  });

  it("leaves a claim that is still being opened alone", async () => {
    const s = store([sessionRow({ provider_session_id: null, created_at: at(-0.5) })]);

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    expect(result).toMatchObject({ kind: "error", status: 409 });
  });

  /**
   * A request that died between its claim and its first run leaves a row
   * naming no session forever. Read only as "somebody is busy" it would lock
   * this conversation out of the browser for good.
   */
  it("takes over a claim an earlier request abandoned", async () => {
    const s = store([sessionRow({ provider_session_id: null, created_at: at(-5) })]);

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    expect(result).toEqual({ kind: "ok", value: ref("bs-1", null) });
    expect(log).toEqual(["select browser_sessions", "select browser_tasks"]);
  });

  /**
   * Ruling R13. `browse` refuses, before the provider and before the meter,
   * while the person holds the browser or a run of it has not settled — so
   * this answers both facts and leaves the deciding to the tool.
   */
  it("says when the person has the controls", async () => {
    const s = store([sessionRow({ live_state: "human" })]);

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    expect(result).toMatchObject({ kind: "ok", value: { liveState: "human" } });
  });

  it("says when a v4 run of this browser has not settled yet", async () => {
    const s = store(
      [sessionRow()],
      [
        { id: "bt-old", browser_session_id: "bs-1", api_version: "v4", status: "finished" },
        { id: "bt-live", browser_session_id: "bs-1", api_version: "v4", status: "running" },
      ],
    );

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    expect(result).toMatchObject({ kind: "ok", value: { runInFlight: true } });
    const read = s.calls.find((c) => c.table === "browser_tasks");
    expect(read?.filters).toEqual(
      expect.arrayContaining([
        { column: "browser_session_id", value: "bs-1", kind: "eq" },
        { column: "api_version", value: "v4", kind: "eq" },
        { column: "status", value: ["queued", "running"], kind: "in" },
      ]),
    );
  });

  it("counts a queued run as in flight too", async () => {
    const s = store(
      [sessionRow()],
      [{ id: "bt-1", browser_session_id: "bs-1", api_version: "v4", status: "queued" }],
    );

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    expect(result).toMatchObject({ kind: "ok", value: { runInFlight: true } });
  });

  it("does not count settled runs, or another browser's", async () => {
    const s = store(
      [sessionRow()],
      [
        { id: "bt-1", browser_session_id: "bs-1", api_version: "v4", status: "finished" },
        { id: "bt-2", browser_session_id: "bs-9", api_version: "v4", status: "running" },
      ],
    );

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    expect(result).toEqual({ kind: "ok", value: ref("bs-1", "bu-session-1") });
  });

  it("refuses rather than guessing when the in-flight read fails", async () => {
    const s = store([sessionRow()]);
    s.state.tasksError = { message: "boom", code: "XX000" };

    const result = await ensureBrowserSession(ENV, WHO, s.deps);

    expect(result).toMatchObject({ kind: "error", status: 500 });
  });

  it("answers an error, and says nothing of the row, when the database refuses", async () => {
    const service = fakeDb({
      tables: {
        browser_sessions: {
          select: () => ({ data: null, error: null }),
          insert: () => ({
            data: null,
            error: { message: "boom", code: "23502", details: "Failing row contains (secret)" } as {
              message: string;
              code?: string;
            },
          }),
        },
      },
    });

    const result = await ensureBrowserSession(ENV, WHO, {
      db: service.db as unknown as SupabaseClient,
      now: () => NOW,
    });

    expect(result).toMatchObject({ kind: "error", status: 500 });
    expect(JSON.stringify(spoken)).not.toContain("Failing row");
  });
});

describe("recordRunStart", () => {
  it("records the session a first run opened, hands the controls to the agent and stamps the run", async () => {
    const s = store([sessionRow({ provider_session_id: null, last_run_at: null })]);

    await recordRunStart(
      ENV,
      { browserSessionId: "bs-1", providerSessionId: "bu-session-new" },
      s.deps,
    );

    expect(s.rows[0]).toMatchObject({
      provider_session_id: "bu-session-new",
      live_state: "agent",
      last_run_at: NOW.toISOString(),
    });
  });

  it("never replaces the session a row already names", async () => {
    const s = store([sessionRow({ provider_session_id: "bu-first" })]);

    // A loser of the stale-claim race arrives with a session of its own.
    await recordRunStart(ENV, { browserSessionId: "bs-1", providerSessionId: "bu-second" }, s.deps);

    expect(s.rows[0]).toMatchObject({
      provider_session_id: "bu-first",
      live_state: "agent",
      last_run_at: NOW.toISOString(),
    });
  });

  it("on a follow-up writes only who has the controls, when the run started, and where its events begin", async () => {
    const s = store([sessionRow({ events_cursor: 41 })]);

    await recordRunStart(ENV, { browserSessionId: "bs-1" }, s.deps);

    expect(s.rows[0]).toMatchObject({
      provider_session_id: "bu-session-1",
      live_state: "agent",
      last_run_at: NOW.toISOString(),
      events_cursor: 0,
    });
    const update = s.calls.find((c) => c.op === "update");
    expect(update?.values).toEqual({
      live_state: "agent",
      last_run_at: NOW.toISOString(),
      events_cursor: 0,
    });
  });

  /**
   * Ruling R19: the first `browse` provisions the person's jar AFTER the row
   * was claimed (the refusals are read off the row, and nothing is spent on a
   * refusal), so the claim named no profile. The run carries the jar, and the
   * sweep reads `profile_id` to refresh it after a stop — so the run's start
   * is where the row learns it.
   */
  it("records the jar a first run carries, in the same write", async () => {
    const s = store([
      sessionRow({ provider_session_id: null, last_run_at: null, profile_id: null }),
    ]);

    await recordRunStart(
      ENV,
      { browserSessionId: "bs-1", providerSessionId: "bu-session-new", profileId: "bp-1" },
      s.deps,
    );

    expect(s.rows[0]).toMatchObject({ provider_session_id: "bu-session-new", profile_id: "bp-1" });
    expect(s.calls.filter((c) => c.op === "update")).toHaveLength(1);
  });

  it("records the jar a follow-up carries, and leaves the column alone when it carries none", async () => {
    const s = store([sessionRow({ profile_id: null })]);

    await recordRunStart(ENV, { browserSessionId: "bs-1", profileId: "bp-1" }, s.deps);
    expect(s.rows[0].profile_id).toBe("bp-1");

    await recordRunStart(ENV, { browserSessionId: "bs-1" }, s.deps);
    expect(s.rows[0].profile_id).toBe("bp-1");
  });

  /**
   * `human` is the person holding the controls (Task 1.5). A run recorded in
   * the window between `browse`'s refusal check and this write must not take
   * the browser out of their hands; the run's answer still arrives, and the
   * panel stays theirs.
   */
  it("never takes the controls from the person", async () => {
    const s = store([sessionRow({ live_state: "human" })]);

    await recordRunStart(ENV, { browserSessionId: "bs-1" }, s.deps);

    expect(s.rows[0].live_state).toBe("human");
    const update = s.calls.find((c) => c.op === "update");
    expect(update?.filters).toContainEqual({ column: "live_state", value: "human", kind: "neq" });
  });

  it("never logs a provider id", async () => {
    const service = fakeDb({
      tables: {
        browser_sessions: {
          update: () => ({ data: null, error: { message: "boom", code: "XX000" } }),
        },
      },
    });

    await recordRunStart(
      ENV,
      { browserSessionId: "bs-1", providerSessionId: "bu-session-secret" },
      { db: service.db as unknown as SupabaseClient, now: () => NOW },
    );

    expect(spoken.length).toBeGreaterThan(0);
    expect(JSON.stringify(spoken)).not.toContain("bu-session-secret");
  });
});

describe("releaseBrowserSession", () => {
  it("hands back a claim whose first run never started, so the next browse is not told to wait", async () => {
    const s = store([sessionRow({ provider_session_id: null, created_at: NOW.toISOString() })]);

    await releaseBrowserSession(ENV, "bs-1", s.deps);

    expect(s.rows).toEqual([]);
  });

  it("never deletes a row that names a browser", async () => {
    const s = store([sessionRow()]);

    await releaseBrowserSession(ENV, "bs-1", s.deps);

    // A browser the database no longer names is one nothing ever stops.
    expect(s.rows).toHaveLength(1);
  });
});
