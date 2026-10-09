import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import type { BrowserResult, CreatedTask } from "./client";
import type { BrowserHeadroom, BrowserStatus, ProviderBrowser, ProviderProfile } from "./profiles";
import {
  fakeDb,
  type Filter,
  type QueryContext,
  type TableHandlers,
} from "../../test-support/fake-db";

/**
 * Every call this module makes, in order — the provider's and the database's
 * in one list.
 *
 * `purge.test.ts` makes the same choice for the same reason: closing a
 * takeover is correct or incorrect entirely by its sequence. Whether the row
 * was claimed before the provider was asked to stop, and whether the stop was
 * confirmed before the task ran again, are not visible in the final state —
 * only in the order the steps happened.
 */
const log: string[] = [];

/**
 * Typed with their real signatures, `http-request.test.ts`'s rule: a bare
 * `vi.fn()` infers a no-argument procedure, and `mock.calls[0][1]` on one is
 * an element of an empty tuple.
 */
const accountHeadroom = vi.fn(
  async (
    _env: unknown,
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<BrowserHeadroom>> => ({
    kind: "ok",
    value: { active: 1, limit: 10 },
  }),
);
const createProfile = vi.fn(
  async (
    _env: unknown,
    _input: { name?: string; userId?: string },
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<ProviderProfile>> => ({
    kind: "ok",
    value: { id: "bu-profile", cookieDomains: [] },
  }),
);
const getProfile = vi.fn(
  async (
    _env: unknown,
    _id: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<ProviderProfile>> => ({
    kind: "ok",
    value: { id: "bu-profile", cookieDomains: ["mail.google.com"] },
  }),
);
const deleteProfile = vi.fn(
  async (
    _env: unknown,
    _id: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<null>> => ({ kind: "ok", value: null }),
);
const createBrowser = vi.fn(
  async (
    _env: unknown,
    _input: { profileId: string; proxyCountryCode?: string | null },
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<ProviderBrowser>> => ({
    kind: "ok",
    value: { id: "bu-session", status: "active", liveUrl: LIVE_URL, timeoutAt: null },
  }),
);
const browserState = vi.fn(
  async (
    _env: unknown,
    _id: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<BrowserStatus>> => ({
    kind: "ok",
    value: { id: "bu-session", status: "stopped" },
  }),
);
const stopBrowser = vi.fn(
  async (
    _env: unknown,
    _id: string,
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<BrowserStatus>> => ({
    kind: "ok",
    value: { id: "bu-session", status: "stopped" },
  }),
);
const createTask = vi.fn(
  async (
    _env: unknown,
    _input: { task: string; profileId?: string; proxyCountryCode?: string | null },
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<CreatedTask>> => ({
    kind: "ok",
    value: { id: "bu-task-2", sessionId: "bu-run-2" },
  }),
);
const recordBrowserTask = vi.fn(
  async (
    _env: RoutineEnv,
    _input: {
      workspaceId: string;
      agentId: string;
      userId: string;
      sessionId: string;
      providerTaskId: string;
      task: string;
      retryOf?: string;
    },
  ): Promise<string | null> => "bt-2",
);

vi.mock("./profiles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./profiles")>();
  return {
    ...actual,
    accountHeadroom: (env: unknown, opts?: { signal?: AbortSignal }) => {
      log.push("provider accountHeadroom");
      return accountHeadroom(env, opts);
    },
    createProfile: (
      env: unknown,
      input: { name?: string; userId?: string },
      opts?: { signal?: AbortSignal },
    ) => {
      log.push("provider createProfile");
      return createProfile(env, input, opts);
    },
    getProfile: (env: unknown, id: string, opts?: { signal?: AbortSignal }) => {
      log.push("provider getProfile");
      return getProfile(env, id, opts);
    },
    deleteProfile: (env: unknown, id: string, opts?: { signal?: AbortSignal }) => {
      log.push("provider deleteProfile");
      return deleteProfile(env, id, opts);
    },
    createBrowser: (
      env: unknown,
      input: { profileId: string; proxyCountryCode?: string | null },
      opts?: { signal?: AbortSignal },
    ) => {
      log.push("provider createBrowser");
      return createBrowser(env, input, opts);
    },
    browserState: (env: unknown, id: string, opts?: { signal?: AbortSignal }) => {
      log.push("provider browserState");
      return browserState(env, id, opts);
    },
    stopBrowser: (env: unknown, id: string, opts?: { signal?: AbortSignal }) => {
      log.push("provider stopBrowser");
      return stopBrowser(env, id, opts);
    },
  };
});

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return {
    ...actual,
    createTask: (
      env: unknown,
      input: { task: string; profileId?: string; proxyCountryCode?: string | null },
      opts?: { signal?: AbortSignal },
    ) => {
      log.push("provider createTask");
      return createTask(env, input, opts);
    },
  };
});

vi.mock("./tasks", () => ({
  recordBrowserTask: (env: RoutineEnv, input: Parameters<typeof recordBrowserTask>[1]) => {
    log.push("record browser_task");
    return recordBrowserTask(env, input);
  },
}));

import {
  TAKEOVER_EXPIRY_MINUTES,
  closeTakeover,
  ensureProfile,
  openTakeover,
  profileFor,
  forgetProfile,
  retryBrowserTask,
  type RetryableTask,
} from "./takeover";
import { TAKEOVER_PROVIDER_MINUTES } from "./profiles";

const ENV = { BROWSER_USE_API_KEY: "bu_test" } as RoutineEnv;
const NOW = new Date("2026-10-09T12:00:00.000Z");
/** Stands in for the one string browser-use tells us to treat as a credential. */
const LIVE_URL = "https://live.browser-use.com/this-is-a-credential";

type Row = Record<string, unknown>;

function at(minutes: number): string {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

/**
 * Only `eq` is modelled, and anything else throws rather than being ignored:
 * a filter this double shrugged at is a filter the module could silently stop
 * sending — and the one that matters is `.eq("status", "open")` on the close,
 * which is the whole defence against a double-click.
 */
function matchesFilters(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.kind !== "eq") throw new Error(`takeover.test: unexpected ${f.kind} on ${f.column}`);
    return row[f.column] === f.value;
  });
}

/**
 * Two clients, and keeping them apart is an assertion rather than scaffolding.
 *
 * `test-support/fake-db` throws on a table it was given no handler for, so the
 * service-role double serves only the two tables no client role may write, and
 * the caller's double serves only `browser_tasks`. A close that re-read the
 * original task through the service client — losing §2's whole reason for the
 * `workspace_id` column — would throw here instead of passing.
 */
function store(seed: { takeovers?: Row[]; profiles?: Row[]; tasks?: Row[] } = {}) {
  const takeovers = [...(seed.takeovers ?? [])];
  const profiles = [...(seed.profiles ?? [])];
  const tasks = [...(seed.tasks ?? [])];
  const state = {
    /** The other device's insert landing between our read and our own insert. */
    loseProfileInsertRace: null as Row | null,
    /** The other request's FILL landing while our provider call is in flight. */
    fillRaceWinner: null as string | null,
    takeoverInsertError: null as { message: string; code?: string; details?: string } | null,
  };
  let ids = 0;

  const read = (name: string, rows: Row[]) => (ctx: QueryContext) => {
    log.push(`select ${name}`);
    const found = rows.filter((r) => matchesFilters(r, ctx.filters));
    return { data: ctx.single ? (found[0] ?? null) : found, error: null };
  };
  const write = (name: string, rows: Row[]) => (ctx: QueryContext) => {
    log.push(`update ${name}`);
    const hit = rows.filter((r) => matchesFilters(r, ctx.filters));
    for (const r of hit) Object.assign(r, ctx.values);
    return { data: ctx.single ? (hit[0] ?? null) : hit, error: null };
  };
  const remove = (name: string, rows: Row[]) => (ctx: QueryContext) => {
    log.push(`delete ${name}`);
    for (const r of rows.filter((row) => matchesFilters(row, ctx.filters))) {
      rows.splice(rows.indexOf(r), 1);
    }
    return { data: null, error: null };
  };

  const service = fakeDb({
    tables: {
      browser_profiles: {
        select: read("browser_profiles", profiles),
        insert: (ctx) => {
          log.push("insert browser_profiles");
          const values = ctx.values ?? {};
          // `on conflict (user_id) do nothing ... returning` answers an empty
          // representation when it did nothing, which is how the loser of the
          // race learns it lost.
          if (state.loseProfileInsertRace) {
            profiles.push({
              id: "prof-other",
              user_id: values.user_id,
              ...state.loseProfileInsertRace,
            });
            state.loseProfileInsertRace = null;
            return { data: null, error: null };
          }
          if (profiles.some((r) => r.user_id === values.user_id)) {
            return { data: null, error: null };
          }
          const row = { id: `prof-${++ids}`, ...values };
          profiles.push(row);
          return { data: ctx.single ? row : [row], error: null };
        },
        // The fill is narrowed to `provider_profile_id = ''`, so a winner that
        // landed first makes it match nothing — which is how the loser finds
        // out it lost. Applied here, before the filters are evaluated, which
        // is the real write arriving second.
        update: (ctx: QueryContext) => {
          if (state.fillRaceWinner) {
            const winner = state.fillRaceWinner;
            state.fillRaceWinner = null;
            for (const r of profiles) {
              if (r.provider_profile_id === "") r.provider_profile_id = winner;
            }
          }
          return write("browser_profiles", profiles)(ctx);
        },
        delete: remove("browser_profiles", profiles),
      },
      browser_takeovers: {
        select: read("browser_takeovers", takeovers),
        insert: (ctx) => {
          log.push("insert browser_takeovers");
          if (state.takeoverInsertError) {
            return { data: null, error: state.takeoverInsertError };
          }
          const row = { id: `to-${++ids}`, ...ctx.values };
          takeovers.push(row);
          return { data: ctx.single ? row : [row], error: null };
        },
        update: write("browser_takeovers", takeovers),
      } satisfies TableHandlers,
    },
  });

  const caller = fakeDb({
    tables: { browser_tasks: { select: read("caller browser_tasks", tasks) } },
  });

  return {
    db: service.db as unknown as SupabaseClient,
    callerDb: caller.db as unknown as SupabaseClient,
    takeovers,
    profiles,
    tasks,
    state,
    deps: {
      db: service.db as unknown as SupabaseClient,
      now: () => NOW,
      sleep,
    },
  };
}

const sleep = vi.fn(async (_ms: number): Promise<void> => {});

function profileRow(over: Row = {}): Row {
  return {
    id: "prof-1",
    user_id: "user-1",
    provider_profile_id: "bu-profile",
    cookie_domains: ["mail.google.com"],
    proxy_country_code: null,
    created_at: NOW.toISOString(),
    ...over,
  };
}

function openRow(over: Row = {}): Row {
  return {
    id: "to-1",
    user_id: "user-1",
    workspace_id: "ws-1",
    profile_id: "prof-1",
    browser_task_id: "bt-1",
    provider_session_id: "bu-old-session",
    status: "open",
    expires_at: at(5),
    created_at: NOW.toISOString(),
    ...over,
  };
}

function taskRow(over: Row = {}): Row {
  return {
    id: "bt-1",
    workspace_id: "ws-1",
    agent_id: "agent-1",
    user_id: "user-1",
    session_id: "sess-1",
    task: "download last month's invoice",
    retry_of: null,
    ...over,
  };
}

/** Everything this module said out loud, so a test can prove what it did not say. */
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

  for (const fn of [
    accountHeadroom,
    createProfile,
    getProfile,
    deleteProfile,
    createBrowser,
    browserState,
    stopBrowser,
    createTask,
    recordBrowserTask,
    sleep,
  ]) {
    fn.mockReset();
  }
  accountHeadroom.mockResolvedValue({ kind: "ok", value: { active: 1, limit: 10 } });
  createProfile.mockResolvedValue({ kind: "ok", value: { id: "bu-profile", cookieDomains: [] } });
  getProfile.mockResolvedValue({
    kind: "ok",
    value: { id: "bu-profile", cookieDomains: ["mail.google.com"] },
  });
  deleteProfile.mockResolvedValue({ kind: "ok", value: null });
  createBrowser.mockResolvedValue({
    kind: "ok",
    value: { id: "bu-session", status: "active", liveUrl: LIVE_URL, timeoutAt: null },
  });
  browserState.mockResolvedValue({ kind: "ok", value: { id: "bu-session", status: "stopped" } });
  stopBrowser.mockResolvedValue({ kind: "ok", value: { id: "bu-session", status: "stopped" } });
  createTask.mockResolvedValue({ kind: "ok", value: { id: "bu-task-2", sessionId: "bu-run-2" } });
  recordBrowserTask.mockResolvedValue("bt-2");
  sleep.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const spy of spies) spy.mockRestore();
});

describe("profileFor", () => {
  it("answers the jar this person already has", async () => {
    const s = store({ profiles: [profileRow()] });
    await expect(profileFor(ENV, "user-1", s.deps)).resolves.toEqual({
      id: "prof-1",
      providerProfileId: "bu-profile",
      proxyCountryCode: null,
    });
  });

  it("answers null for a row still being created, rather than naming a jar that does not exist", async () => {
    const s = store({ profiles: [profileRow({ provider_profile_id: "" })] });
    await expect(profileFor(ENV, "user-1", s.deps)).resolves.toBeNull();
  });
});

describe("ensureProfile", () => {
  it("inserts the Covan row FIRST and only calls the provider when the insert won", async () => {
    const s = store();

    const result = await ensureProfile(ENV, "user-1", { label: "Covan takeover" }, s.deps);

    expect(result).toEqual({
      kind: "ok",
      value: { id: "prof-1", providerProfileId: "bu-profile", proxyCountryCode: null },
    });
    // The order is the whole point: the provider is called after the unique
    // index has been won, never before.
    expect(log).toEqual([
      "select browser_profiles",
      "insert browser_profiles",
      "provider createProfile",
      "update browser_profiles",
    ]);
    expect(s.profiles[0].provider_profile_id).toBe("bu-profile");
    expect(createProfile.mock.calls[0][1]).toEqual({ name: "Covan takeover", userId: "user-1" });
    // Pinned on creation, which is the only moment it may be written.
    expect(s.profiles[0].proxy_country_code).toBeNull();
  });

  it("treats a unique-violation as 're-read', and calls the provider zero times", async () => {
    const s = store();
    s.state.loseProfileInsertRace = { provider_profile_id: "bu-other", proxy_country_code: "de" };

    const result = await ensureProfile(ENV, "user-1", { label: "Covan takeover" }, s.deps);

    expect(result).toEqual({
      kind: "ok",
      value: { id: "prof-other", providerProfileId: "bu-other", proxyCountryCode: "de" },
    });
    // The orphan this avoids is permanent: a profile at browser-use that
    // nothing in this database can name and that counts against the limit.
    expect(createProfile).not.toHaveBeenCalled();
    expect(log).toEqual([
      "select browser_profiles",
      "insert browser_profiles",
      "select browser_profiles",
    ]);
  });

  it("maps the provider's 402 to a sentence, never its body", async () => {
    const s = store();
    createProfile.mockResolvedValue({
      kind: "error",
      status: 402,
      message: '402 Payment Required\n{"detail":"Profile limit exceeded"}',
    });

    const result = await ensureProfile(ENV, "user-1", { label: "Covan takeover" }, s.deps);

    expect(result.kind).toBe("error");
    const message = (result as { message: string }).message;
    expect(message).not.toContain("Profile limit exceeded");
    expect(message).not.toContain("402 Payment Required");
    expect(message.length).toBeGreaterThan(30);
    // And the claimed row is handed back, or this person could never try again.
    expect(s.profiles).toEqual([]);
  });

  /**
   * The third state, and the one a first draft reads as one of the other two.
   *
   * A request that died between winning the unique index and filling the row
   * in leaves `provider_profile_id` at `''` forever. Read as "no profile" it
   * is a permanent dead row — every later attempt conflicts, re-reads the
   * same `''`, and never reaches the provider — and no amount of retrying
   * from a screen clears it. So an abandoned claim is finished off rather
   * than worked around.
   */
  it("finishes a claim an earlier attempt abandoned, rather than leaving a dead row", async () => {
    const s = store({
      profiles: [profileRow({ provider_profile_id: "", created_at: at(-5) })],
    });

    const result = await ensureProfile(ENV, "user-1", { label: "Covan takeover" }, s.deps);

    expect(result).toEqual({
      kind: "ok",
      value: { id: "prof-1", providerProfileId: "bu-profile", proxyCountryCode: null },
    });
    expect(createProfile).toHaveBeenCalledTimes(1);
    expect(s.profiles[0].provider_profile_id).toBe("bu-profile");
    // No second claim: the row it finishes is the one already there.
    expect(log).toEqual([
      "select browser_profiles",
      "provider createProfile",
      "update browser_profiles",
    ]);
  });

  it("leaves a claim somebody is still provisioning alone", async () => {
    const s = store({ profiles: [profileRow({ provider_profile_id: "" })] });

    const result = await ensureProfile(ENV, "user-1", { label: "Covan takeover" }, s.deps);

    // Finishing a request that is still in flight would make the second
    // profile the insert-first order exists to prevent.
    expect(result).toMatchObject({ kind: "error", status: 409 });
    expect(createProfile).not.toHaveBeenCalled();
    expect(s.profiles[0].provider_profile_id).toBe("");
  });

  it("takes over a claim it lost to a request that then died", async () => {
    const s = store();
    s.state.loseProfileInsertRace = { provider_profile_id: "", created_at: at(-5) };

    const result = await ensureProfile(ENV, "user-1", { label: "Covan takeover" }, s.deps);

    expect(result).toMatchObject({ kind: "ok", value: { providerProfileId: "bu-profile" } });
    expect(createProfile).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      "select browser_profiles",
      "insert browser_profiles",
      "select browser_profiles",
      "provider createProfile",
      "update browser_profiles",
    ]);
  });

  /**
   * Spec §1's "pinned once and reused forever", which nothing wrote before
   * this round: cookies are bound to the egress they were set from, so the
   * column is the only record of where a jar was filled.
   */
  it("pins the egress the jar was created through", async () => {
    const s = store();

    const result = await ensureProfile(
      ENV,
      "user-1",
      { label: "Covan takeover", proxyCountryCode: "de" },
      s.deps,
    );

    expect(result).toMatchObject({ kind: "ok", value: { proxyCountryCode: "de" } });
    expect(s.profiles[0].proxy_country_code).toBe("de");
  });

  it("never re-pins the egress of a jar that already exists", async () => {
    const s = store({ profiles: [profileRow({ proxy_country_code: "de" })] });

    const result = await ensureProfile(
      ENV,
      "user-1",
      { label: "Covan takeover", proxyCountryCode: "nl" },
      s.deps,
    );

    // Signing in through Germany and running the next task through the
    // Netherlands is what invalidates the session, silently, one task later.
    expect(result).toMatchObject({ kind: "ok", value: { proxyCountryCode: "de" } });
    expect(s.profiles[0].proxy_country_code).toBe("de");
    expect(createProfile).not.toHaveBeenCalled();
  });

  /**
   * Two requests can both find one abandoned claim stale, and both arrive here
   * with a profile of their own. The loser must not overwrite the winner's id:
   * its own jar would then be recorded nowhere, and the person would sign in
   * to a browser rented against it and be told the jar came back empty.
   */
  it("hands the race to the first filler and deletes its own orphan", async () => {
    const s = store({
      profiles: [profileRow({ provider_profile_id: "", created_at: at(-5) })],
    });
    createProfile.mockResolvedValue({ kind: "ok", value: { id: "bu-ours", cookieDomains: [] } });
    // The winner fills the row while our own create is in flight.
    s.state.fillRaceWinner = "bu-theirs";

    const result = await ensureProfile(ENV, "user-1", { label: "Covan takeover" }, s.deps);

    expect(result).toMatchObject({ kind: "ok", value: { providerProfileId: "bu-theirs" } });
    expect(s.profiles[0].provider_profile_id).toBe("bu-theirs");
    expect(deleteProfile.mock.calls[0][1]).toBe("bu-ours");
  });

  /**
   * `/profiles/` and `/profiles/{id}` are different endpoints, and
   * `sessionSettings.profileId: ""` is whatever the provider makes of it. An
   * id that is not an id must never be written down, because every later
   * caller would hand it straight back to the provider.
   */
  it("refuses to record a profile the provider named with nothing", async () => {
    const s = store();
    createProfile.mockResolvedValue({ kind: "ok", value: { id: "", cookieDomains: [] } });

    const result = await ensureProfile(ENV, "user-1", { label: "Covan takeover" }, s.deps);

    expect(result).toMatchObject({ kind: "error" });
    expect(s.profiles).toEqual([]);
    expect(getProfile).not.toHaveBeenCalled();
    expect(createBrowser).not.toHaveBeenCalled();
  });
});

describe("openTakeover", () => {
  const input = { userId: "user-1", workspaceId: "ws-1", browserTaskId: "bt-1", label: "Covan" };

  it("refuses when the shared pool has fewer than 2 free slots, before creating anything", async () => {
    const s = store();
    // The boundary §3b names: refuse at `active >= limit - 2`, so eight of ten
    // is already a refusal. Nine would pass under `>` as well and prove less.
    accountHeadroom.mockResolvedValue({ kind: "ok", value: { active: 8, limit: 10 } });

    const result = await openTakeover(ENV, input, s.deps);

    expect(result).toEqual({
      kind: "error",
      status: 429,
      message: expect.stringContaining("busy"),
    });
    // The two slots held back are somebody else's `browse` already in flight.
    expect(createProfile).not.toHaveBeenCalled();
    expect(createBrowser).not.toHaveBeenCalled();
    expect(s.takeovers).toEqual([]);
  });

  it("proceeds with exactly two slots free, which are the two it keeps back", async () => {
    const s = store({ profiles: [profileRow()] });
    accountHeadroom.mockResolvedValue({ kind: "ok", value: { active: 7, limit: 10 } });

    await expect(openTakeover(ENV, input, s.deps)).resolves.toMatchObject({ kind: "ok" });
  });

  it("refuses with 409 when the caller has an open takeover still inside its window", async () => {
    const s = store({ takeovers: [openRow({ expires_at: at(5) })], profiles: [profileRow()] });

    const result = await openTakeover(ENV, input, s.deps);

    expect(result).toEqual({ kind: "error", status: 409, message: expect.any(String) });
    expect(createBrowser).not.toHaveBeenCalled();
    expect(stopBrowser).not.toHaveBeenCalled();
    expect(s.takeovers[0].status).toBe("open");
  });

  it("closes a stale open takeover and proceeds, rather than refusing", async () => {
    const s = store({ takeovers: [openRow({ expires_at: at(-1) })], profiles: [profileRow()] });

    const result = await openTakeover(ENV, input, s.deps);

    expect(result).toMatchObject({ kind: "ok" });
    // Stopped, because a stop is the only thing that saves whatever state the
    // abandoned browser collected — and it frees the pool slot.
    expect(stopBrowser.mock.calls[0][1]).toBe("bu-old-session");
    expect(s.takeovers[0]).toMatchObject({
      status: "closed",
      closed_at: NOW.toISOString(),
      provider_stopped_at: NOW.toISOString(),
    });
    expect(s.takeovers).toHaveLength(2);
    // The stop is what saved whatever was in that jar, so this path records it
    // the same way the route's close and Task 4's sweep do.
    expect(getProfile.mock.calls[0][1]).toBe("bu-profile");
    expect(s.profiles[0].last_used_at).toBe(NOW.toISOString());
  });

  it("leaves a stale takeover's provider_stopped_at null when the stop is refused", async () => {
    const s = store({ takeovers: [openRow({ expires_at: at(-1) })], profiles: [profileRow()] });
    stopBrowser.mockResolvedValue({ kind: "error", status: 502, message: "502 Bad Gateway" });

    const result = await openTakeover(ENV, input, s.deps);

    // The person is not locked out, and the sweep's `closed` + no
    // provider_stopped_at arm is what reclaims the browser.
    expect(result).toMatchObject({ kind: "ok" });
    expect(s.takeovers[0].status).toBe("closed");
    expect(s.takeovers[0].provider_stopped_at ?? null).toBeNull();
  });

  /**
   * The branch that put a browser outside both of the sweep's claim arms.
   *
   * `PATCH {"action":"stop"}` can answer 200 with `status: "active"` — the
   * reason the route's close has a settle loop at all. Recording
   * `provider_stopped_at` on that answer leaves a row that is neither `open`
   * nor missing its timestamp, so nothing ever reclaims it: the browser runs
   * to its fifteen-minute timeout holding a pool slot, and the abandoned jar
   * this path exists to save is lost.
   */
  it("does not record a stale takeover's stop the provider only accepted", async () => {
    const s = store({ takeovers: [openRow({ expires_at: at(-1) })], profiles: [profileRow()] });
    stopBrowser.mockResolvedValue({
      kind: "ok",
      value: { id: "bu-old-session", status: "active" },
    });

    const result = await openTakeover(ENV, input, s.deps);

    expect(result).toMatchObject({ kind: "ok" });
    expect(s.takeovers[0].status).toBe("closed");
    expect(s.takeovers[0].provider_stopped_at ?? null).toBeNull();
    // And nothing was recorded off the back of it either.
    expect(getProfile).not.toHaveBeenCalled();
  });

  /**
   * §4a's second named path, arriving by the database's door. PostgREST hands
   * Postgres' DETAIL back as `details`, and a CHECK violation's detail is
   * `Failing row contains (…)` — the whole row, `provider_session_id` and all.
   * `expires_at > created_at` is reachable on clock skew between this Worker
   * and the database.
   */
  it("never logs a database error object, which would carry the row", async () => {
    const s = store({ profiles: [profileRow()] });
    s.state.takeoverInsertError = {
      code: "23514",
      message: 'new row violates check constraint "browser_takeovers_window_forward"',
      details: "Failing row contains (…, bu-session, open, …).",
    };

    const result = await openTakeover(ENV, input, s.deps);

    expect(result).toMatchObject({ kind: "error", status: 500 });
    expect(JSON.stringify(spoken)).not.toContain("Failing row contains");
    expect(JSON.stringify(spoken)).not.toContain("bu-session");
    // The code and the constraint name survive, because they are what an
    // operator needs and neither quotes the row.
    expect(JSON.stringify(spoken)).toContain("23514");
    expect(JSON.stringify(spoken)).toContain("browser_takeovers_window_forward");
  });

  it("returns liveUrl without writing it to any row", async () => {
    const s = store({ profiles: [profileRow()] });

    const result = await openTakeover(ENV, input, s.deps);

    expect(result).toMatchObject({ kind: "ok", liveUrl: LIVE_URL });
    // browser-use, verbatim: "Treat the URL as a credential: anyone with it
    // can interact with the active browser." So it lives in this one return
    // value and nowhere else — not in a row, not in a log line.
    expect(JSON.stringify(s.takeovers)).not.toContain(LIVE_URL);
    expect(JSON.stringify(s.profiles)).not.toContain(LIVE_URL);
    expect(JSON.stringify(spoken)).not.toContain(LIVE_URL);
  });

  it("writes expires_at at TAKEOVER_EXPIRY_MINUTES, strictly inside the provider's window", async () => {
    const s = store({ profiles: [profileRow()] });

    const result = await openTakeover(ENV, input, s.deps);

    // The gap is the only time the sweep has to stop a session cleanly, and a
    // stop is the only thing that saves the jar. Equal values would give it
    // none, which the database deliberately does not check: the constraint
    // compares expires_at to created_at and no more, so this invariant is
    // this module's to hold.
    expect(TAKEOVER_EXPIRY_MINUTES).toBeLessThan(TAKEOVER_PROVIDER_MINUTES);
    expect(s.takeovers[0].expires_at).toBe(at(TAKEOVER_EXPIRY_MINUTES));
    expect(result).toMatchObject({ expiresAt: at(TAKEOVER_EXPIRY_MINUTES) });
  });

  it("records the browser against the caller's own ids, and no provider id reaches the caller", async () => {
    const s = store({ profiles: [profileRow()] });

    const result = await openTakeover(ENV, input, s.deps);

    expect(s.takeovers[0]).toMatchObject({
      user_id: "user-1",
      workspace_id: "ws-1",
      profile_id: "prof-1",
      browser_task_id: "bt-1",
      provider_session_id: "bu-session",
      status: "open",
    });
    expect(JSON.stringify(result)).not.toContain("bu-session");
    expect(JSON.stringify(result)).not.toContain("bu-profile");
  });

  it("stops the browser it just rented when the row cannot be written", async () => {
    const s = store({ profiles: [profileRow()] });
    s.state.takeoverInsertError = { message: "duplicate key value", code: "23505" };

    const result = await openTakeover(ENV, input, s.deps);

    // Nothing left in this database could name that browser, so it would hold
    // a pool slot for fifteen minutes with nobody able to stop it.
    expect(result).toMatchObject({ kind: "error", status: 409 });
    expect(stopBrowser.mock.calls[0][1]).toBe("bu-session");
  });

  it("answers a 429 from the provider as the shared pool being full", async () => {
    const s = store({ profiles: [profileRow()] });
    createBrowser.mockResolvedValue({ kind: "error", status: 429, message: "429 Too Many" });

    const result = await openTakeover(ENV, input, s.deps);

    expect(result).toMatchObject({ kind: "error", status: 429 });
    expect((result as { message: string }).message).toContain("busy");
    expect(s.takeovers).toEqual([]);
  });
});

describe("closeTakeover", () => {
  function seeded() {
    return store({
      takeovers: [openRow()],
      profiles: [profileRow()],
      tasks: [taskRow()],
    });
  }

  it("flips the status as the claim and runs the sequence once for two concurrent calls", async () => {
    const s = seeded();

    const [first, second] = await Promise.all([
      closeTakeover(ENV, { takeoverId: "to-1", userId: "user-1", callerDb: s.callerDb }, s.deps),
      closeTakeover(ENV, { takeoverId: "to-1", userId: "user-1", callerDb: s.callerDb }, s.deps),
    ]);

    const outcomes = [first.kind, second.kind].sort();
    expect(outcomes).toEqual(["error", "ok"]);
    const refused = first.kind === "error" ? first : (second as { status: number });
    expect(refused.status).toBe(409);
    // A double-click would otherwise put two assistant messages, minutes
    // apart, into one conversation answering one question.
    expect(stopBrowser).toHaveBeenCalledTimes(1);
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(recordBrowserTask).toHaveBeenCalledTimes(1);
  });

  /**
   * The id comes out of a URL path and this client answers to no policy, so
   * the `user_id` clause on the claim is the authorization — not the fact that
   * a uuid is hard to guess. Without it, one signed-in person could stop
   * another's browser mid-login, destroying the sign-in in progress and
   * starting a re-run nobody asked for or paid for.
   */
  it("claims nothing for somebody else's takeover, and answers as if it were closed", async () => {
    const s = seeded();

    const result = await closeTakeover(
      ENV,
      { takeoverId: "to-1", userId: "user-2", callerDb: s.callerDb },
      s.deps,
    );

    expect(result).toEqual({
      kind: "error",
      status: 409,
      message: "that takeover is already closed",
    });
    expect(s.takeovers[0].status).toBe("open");
    expect(s.takeovers[0].closed_at ?? null).toBeNull();
    expect(stopBrowser).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
  });

  it("does not re-run when the original task is no longer readable by the caller", async () => {
    const s = store({ takeovers: [openRow()], profiles: [profileRow()], tasks: [] });

    const result = await closeTakeover(
      ENV,
      { takeoverId: "to-1", userId: "user-1", callerDb: s.callerDb },
      s.deps,
    );

    expect(result).toMatchObject({ kind: "error", status: 404 });
    expect(createTask).not.toHaveBeenCalled();
    expect(recordBrowserTask).not.toHaveBeenCalled();
    /**
     * But the browser IS stopped and the jar IS saved, which is where this
     * departs from spec §6: losing access to the workspace is a reason not to
     * re-run a task into a room they have left, and no reason at all to leave
     * their own browser running and billing until the sweep reaches it.
     */
    expect(s.takeovers[0].status).toBe("closed");
    expect(s.takeovers[0].provider_stopped_at).toBe(NOW.toISOString());
    expect(stopBrowser).toHaveBeenCalledTimes(1);
    expect(s.profiles[0].cookie_domains).toEqual(["mail.google.com"]);
  });

  it("waits for the provider to report stopped before re-running", async () => {
    const s = seeded();
    stopBrowser.mockResolvedValue({
      kind: "ok",
      value: { id: "bu-old-session", status: "active" },
    });
    browserState
      .mockResolvedValueOnce({ kind: "ok", value: { id: "bu-old-session", status: "active" } })
      .mockResolvedValue({ kind: "ok", value: { id: "bu-old-session", status: "stopped" } });

    const result = await closeTakeover(
      ENV,
      { takeoverId: "to-1", userId: "user-1", callerDb: s.callerDb },
      s.deps,
    );

    expect(result).toMatchObject({ kind: "ok", retriedTaskId: "bt-2" });
    // A 200 on the stop is not a promise that persistence finished, and
    // re-running early produces the one failure a person cannot interpret:
    // they sign in, press done, and are told the page asked them to sign in.
    expect(log).toEqual([
      "update browser_takeovers",
      "provider stopBrowser",
      "provider browserState",
      "provider browserState",
      // The profile is read before the stop is recorded: `provider_stopped_at`
      // is what takes a row out of the sweep's sight, so a failed read must
      // leave the null behind rather than a row nothing revisits.
      "select browser_profiles",
      "update browser_takeovers",
      "provider getProfile",
      "update browser_profiles",
      "select caller browser_tasks",
      "provider createTask",
      "record browser_task",
    ]);
    expect(sleep).toHaveBeenCalled();
  });

  it("reports that the sign-in didn't stick, and does not re-run, when cookie_domains is still empty", async () => {
    const s = seeded();
    getProfile.mockResolvedValue({ kind: "ok", value: { id: "bu-profile", cookieDomains: [] } });

    const result = await closeTakeover(
      ENV,
      { takeoverId: "to-1", userId: "user-1", callerDb: s.callerDb },
      s.deps,
    );

    expect(result).toMatchObject({ kind: "ok", retriedTaskId: null });
    expect((result as { message: string }).message).toContain("didn't stick");
    // The retry is not burnt, because there is nothing new to try with.
    expect(createTask).not.toHaveBeenCalled();
    expect(s.profiles[0].cookie_domains).toEqual([]);
  });

  it("marks the row closed even when the provider refuses the stop, leaving provider_stopped_at null", async () => {
    const s = seeded();
    stopBrowser.mockResolvedValue({ kind: "error", status: 502, message: "502 Bad Gateway" });

    const result = await closeTakeover(
      ENV,
      { takeoverId: "to-1", userId: "user-1", callerDb: s.callerDb },
      s.deps,
    );

    // Closed regardless: leaving the row open would make the one-open index
    // lock the person out of their own account until the next cron tick.
    expect(s.takeovers[0]).toMatchObject({ status: "closed", closed_at: NOW.toISOString() });
    // And NOT stopped — the null is what makes the sweep retry the stop, so
    // the browser stops billing and the jar still gets saved.
    expect(s.takeovers[0].provider_stopped_at ?? null).toBeNull();
    expect(result).toMatchObject({ kind: "error" });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("never asks the provider about an empty profile id", async () => {
    const s = store({
      takeovers: [openRow()],
      profiles: [profileRow({ provider_profile_id: "" })],
      tasks: [taskRow()],
    });

    const result = await closeTakeover(
      ENV,
      { takeoverId: "to-1", userId: "user-1", callerDb: s.callerDb },
      s.deps,
    );

    // A read of `/profiles/` is not a read of one jar, so a half-made row
    // stops the close rather than being handed on.
    expect(result).toMatchObject({ kind: "error", status: 500 });
    expect(getProfile).not.toHaveBeenCalled();
    expect(createTask).not.toHaveBeenCalled();
    // The browser was stopped — that happened first and is what saved whatever
    // jar there is — but `provider_stopped_at` is deliberately NOT written,
    // because a row carrying it matches no sweep arm and this one still needs
    // revisiting.
    expect(stopBrowser).toHaveBeenCalledTimes(1);
    expect(s.takeovers[0].provider_stopped_at ?? null).toBeNull();
  });

  it("closes a takeover that was opened against no task at all", async () => {
    const s = store({ takeovers: [openRow({ browser_task_id: null })], profiles: [profileRow()] });

    const result = await closeTakeover(
      ENV,
      { takeoverId: "to-1", userId: "user-1", callerDb: s.callerDb },
      s.deps,
    );

    expect(result).toMatchObject({ kind: "ok", retriedTaskId: null });
    expect(stopBrowser).toHaveBeenCalledTimes(1);
    expect(createTask).not.toHaveBeenCalled();
    expect(s.profiles[0].cookie_domains).toEqual(["mail.google.com"]);
  });
});

describe("retryBrowserTask", () => {
  const original: RetryableTask = {
    id: "bt-1",
    workspace_id: "ws-1",
    agent_id: "agent-1",
    user_id: "user-1",
    session_id: "sess-1",
    task: "download last month's invoice",
    retry_of: null,
  };

  it("writes a new row with retry_of set to the original, copying workspace/agent/user/session/task", async () => {
    const id = await retryBrowserTask(ENV, original, "bu-profile", "de");

    expect(id).toBe("bt-2");
    expect(createTask.mock.calls[0][1]).toEqual({
      task: "download last month's invoice",
      profileId: "bu-profile",
      proxyCountryCode: "de",
    });
    expect(recordBrowserTask.mock.calls[0][1]).toEqual({
      workspaceId: "ws-1",
      agentId: "agent-1",
      userId: "user-1",
      sessionId: "sess-1",
      providerTaskId: "bu-task-2",
      task: "download last month's invoice",
      retryOf: "bt-1",
    });
  });

  /**
   * One retry per original, ever: a second login wall is a conversation, not
   * another free attempt. Beneath the unique `browser_tasks_retry_of_idx` and
   * Task 5's offerable predicate, both of which say the same — three, because
   * what it bounds is the operator's money on a path that consults no
   * allowance.
   */
  it("refuses a retry of a retry, before spending anything", async () => {
    const chained: RetryableTask = { ...original, id: "bt-2", retry_of: "bt-1" };

    await expect(retryBrowserTask(ENV, chained, "bu-profile", null)).resolves.toBeNull();
    expect(createTask).not.toHaveBeenCalled();
    expect(recordBrowserTask).not.toHaveBeenCalled();
  });

  it("answers null when the provider will not take the re-run", async () => {
    createTask.mockResolvedValue({ kind: "error", status: 429, message: "429 Too Many" });

    await expect(retryBrowserTask(ENV, original, "bu-profile", null)).resolves.toBeNull();
    expect(recordBrowserTask).not.toHaveBeenCalled();
  });

  /**
   * Asserted against the source rather than a mock, because the invariant is
   * that nothing in this file ever reaches for the allowance — not that one
   * path happens to miss it. The free re-run is the point: `browse` charged
   * `BROWSER_TASK_TOKENS` once already, and a login wall is not something the
   * person did wrong.
   */
  /**
   * The structural half of the log-leak defence, asserted against the source
   * because the invariant is that NO site logs a database error object — not
   * that the three that could carry a `provider_session_id` remember to use
   * `problem()`. §4a asks for exactly this: *"Both close structurally rather
   * than by discipline."*
   */
  it("logs no database error object anywhere in the file", () => {
    const source = readFileSync(`${process.cwd()}/src/lib/browser/takeover.ts`, "utf8");
    const logged = [...source.matchAll(/console\.(?:error|warn|log)\(([\s\S]*?)\);/g)];
    expect(logged.length).toBeGreaterThan(10);
    for (const [, args] of logged) {
      // With `problem(...)` wrappers and message strings taken out, no
      // identifier naming an error may be left: that is the whole rule.
      const bare = args.replace(/problem\([^)]*\)/g, "").replace(/"(?:[^"\\]|\\.)*"/g, "");
      expect(bare, args).not.toMatch(/[eE]rror\b/);
    }
  });

  it("never calls spend, affordable or entitlements", () => {
    const source = readFileSync(`${process.cwd()}/src/lib/browser/takeover.ts`, "utf8");
    expect(source).not.toMatch(/\bspend\s*\(/);
    expect(source).not.toMatch(/\baffordable\s*\(/);
    // The import rather than the word, so the file can still argue in prose
    // about the allowance it deliberately never asks.
    expect(source).not.toMatch(/^\s*import[^\n]*entitlements/m);
  });
});

/**
 * Forgetting, which is the half of the promise the account screen makes.
 *
 * Deleting on account closure was already there, and it is not the same
 * right: a person who wants Covan to stop holding a login must not have to
 * close their account to get it. What makes the order load-bearing here is
 * that the Covan row is the only thing in existence that names the jar —
 * `provider_profile_id` is withheld from every client role (0077) and
 * browser-use has no "list by Covan user" — so a row deleted before the
 * provider confirmed leaves a bag of live session cookies nothing can ever
 * name again.
 */
describe("forgetProfile", () => {
  it("deletes at the provider BEFORE the row, because the row is the only name the jar has", async () => {
    const s = store({ profiles: [profileRow()] });
    const r = await forgetProfile(ENV, "user-1", s.deps);

    expect(r).toEqual({ kind: "ok", forgotten: ["mail.google.com"] });
    expect(log).toEqual([
      "select browser_takeovers",
      "select browser_profiles",
      "provider deleteProfile",
      "delete browser_profiles",
    ]);
    expect(s.profiles).toEqual([]);
  });

  it("keeps the row when the provider refuses, so the jar still has a name", async () => {
    deleteProfile.mockResolvedValue({ kind: "error", status: 500, message: "500 upstream" });
    const s = store({ profiles: [profileRow()] });
    const r = await forgetProfile(ENV, "user-1", s.deps);

    expect(r.kind).toBe("error");
    expect(log).not.toContain("delete browser_profiles");
    expect(s.profiles).toHaveLength(1);
  });

  /**
   * The retry path. A first attempt that deleted at the provider and then
   * failed to delete the row leaves a row naming a jar that is gone; asking
   * again must finish the job rather than refuse forever on the provider's
   * entirely correct 404.
   */
  it("treats a provider 404 as already forgotten and still clears the row", async () => {
    deleteProfile.mockResolvedValue({ kind: "error", status: 404, message: "404 Not Found" });
    const s = store({ profiles: [profileRow()] });
    const r = await forgetProfile(ENV, "user-1", s.deps);

    expect(r.kind).toBe("ok");
    expect(s.profiles).toEqual([]);
  });

  /**
   * A browser is running on that jar right now, and stopping it is what saves
   * the jar — so deleting underneath it would destroy a sign-in the person is
   * part-way through, and `closeTakeover` would then be refreshing
   * `cookie_domains` on a row that no longer exists.
   */
  it("refuses while a takeover is open, rather than pulling the jar out from under it", async () => {
    const s = store({ takeovers: [openRow()], profiles: [profileRow()] });
    const r = await forgetProfile(ENV, "user-1", s.deps);

    expect(r).toMatchObject({ kind: "error", status: 409 });
    expect(log).not.toContain("provider deleteProfile");
    expect(s.profiles).toHaveLength(1);
  });

  it("ignores a takeover that has already lapsed, which is not a running browser", async () => {
    const s = store({ takeovers: [openRow({ expires_at: at(-1) })], profiles: [profileRow()] });
    await expect(forgetProfile(ENV, "user-1", s.deps)).resolves.toMatchObject({ kind: "ok" });
  });

  it("answers ok with nothing forgotten when there is no jar", async () => {
    const s = store();
    await expect(forgetProfile(ENV, "user-1", s.deps)).resolves.toEqual({
      kind: "ok",
      forgotten: [],
    });
    expect(log).not.toContain("provider deleteProfile");
  });

  /** A half-made row names no jar, so there is nothing to ask the provider about. */
  it("clears a half-made row without calling the provider", async () => {
    const s = store({ profiles: [profileRow({ provider_profile_id: "" })] });
    await expect(forgetProfile(ENV, "user-1", s.deps)).resolves.toMatchObject({ kind: "ok" });
    expect(log).not.toContain("provider deleteProfile");
    expect(s.profiles).toEqual([]);
  });

  /**
   * The same rule every other id-keyed mutation in this file follows: this
   * client answers to no policy, so the owner is in the predicate rather than
   * beside it.
   */
  it("scopes both the read and the delete to the caller", async () => {
    const s = store({ profiles: [profileRow({ user_id: "someone-else" })] });
    await expect(forgetProfile(ENV, "user-1", s.deps)).resolves.toEqual({
      kind: "ok",
      forgotten: [],
    });
    expect(s.profiles).toHaveLength(1);
  });
});
