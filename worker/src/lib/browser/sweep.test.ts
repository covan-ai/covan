import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import {
  BATCH_SIZE,
  BROWSER_BATCH_SIZE,
  sweepAbandonedTakeovers,
  sweepConversationBrowsers,
  type SweepDeps,
} from "./sweep";
import { memoryDb } from "../../test-support/memory-db";
import { JAR_ATTEMPTS } from "./takeover";
import * as v4 from "./v4";
import * as profiles from "./profiles";

/**
 * The sweep exists for one thing: somebody closed the tab instead of pressing
 * done, and the sign-in they just performed is about to be thrown away because
 * only a stop saves the cookie jar. So these tests are mostly about the two
 * ways that can still go wrong — a stop the provider did not actually perform,
 * and a row marked finished when it was not.
 */

type Row = {
  id: string;
  user_id: string;
  profile_id: string;
  provider_session_id: string | null;
  status: string;
};

type Update = { table: string; patch: Record<string, unknown>; filters: [string, unknown][] };

/**
 * A database double that records what was asked of it.
 *
 * Deliberately records FILTERS as well as patches: the two conditional updates
 * in this file are the whole of its correctness, and a double that ignored
 * `.eq("status", "open")` would let a dropped guard pass.
 */
function fakeDb(opts: {
  claim?: { data: Row[] | null; error: { message: string } | null };
  profileRow?: { provider_profile_id: string; cookie_domains?: unknown } | null;
  updateError?: { code: string; message: string } | null;
}) {
  const updates: Update[] = [];
  const rpcCalls: { fn: string; args: unknown }[] = [];

  const builder = (table: string, patch: Record<string, unknown>) => {
    const filters: [string, unknown][] = [];
    const self = {
      eq(column: string, value: unknown) {
        filters.push([column, value]);
        return self;
      },
      then(resolve: (v: { error: unknown }) => void) {
        updates.push({ table, patch, filters });
        resolve({ error: opts.updateError ?? null });
      },
    };
    return self;
  };

  const db = {
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args });
      return Promise.resolve(opts.claim ?? { data: [], error: null });
    },
    from(table: string) {
      return {
        update: (patch: Record<string, unknown>) => builder(table, patch),
        select: (_columns: string) => ({
          eq: (_c: string, _v: unknown) => ({
            maybeSingle: () =>
              Promise.resolve({
                data:
                  opts.profileRow === undefined
                    ? { provider_profile_id: "p-1", cookie_domains: [] }
                    : opts.profileRow,
                error: null,
              }),
          }),
        }),
      };
    },
  };

  return { db: db as unknown as SupabaseClient, updates, rpcCalls };
}

const ENV = {
  BROWSER_USE_API_KEY: "bu_test",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
} as unknown as RoutineEnv;

const NO_KEY = { ...ENV, BROWSER_USE_API_KEY: undefined } as unknown as RoutineEnv;

function row(over: Partial<Row> = {}): Row {
  return {
    id: "t-1",
    user_id: "u-1",
    profile_id: "pr-1",
    provider_session_id: "s-1",
    status: "open",
    ...over,
  };
}

const now = () => new Date("2026-10-10T12:00:00.000Z");

function deps(db: SupabaseClient): Partial<SweepDeps> {
  return { db, now };
}

let stopBrowser: ReturnType<typeof vi.spyOn>;
let getProfile: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stopBrowser = vi
    .spyOn(profiles, "stopBrowser")
    .mockResolvedValue({ kind: "ok", value: { id: "s-1", status: "stopped" } });
  getProfile = vi
    .spyOn(profiles, "getProfile")
    .mockResolvedValue({ kind: "ok", value: { id: "p-1", cookieDomains: ["mail.example.com"] } });
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("an idle tick", () => {
  it("claims nothing and touches no provider", async () => {
    const { db, updates, rpcCalls } = fakeDb({ claim: { data: [], error: null } });
    const result = await sweepAbandonedTakeovers(ENV, deps(db));

    expect(result).toEqual({ claimed: 0, ok: 0, failed: 0 });
    expect(rpcCalls).toEqual([
      {
        fn: "claim_due_browser_takeovers",
        args: { p_limit: BATCH_SIZE, p_stale_after: "15 minutes" },
      },
    ]);
    expect(updates).toEqual([]);
    expect(stopBrowser).not.toHaveBeenCalled();
  });
});

describe("a Worker with no browser key", () => {
  it("warns and claims nothing, asked before the claim", async () => {
    const { db, rpcCalls } = fakeDb({});
    const result = await sweepAbandonedTakeovers(NO_KEY, deps(db));

    expect(result).toEqual({ claimed: 0, ok: 0, failed: 0 });
    // The point of the test: nothing was claimed. A claimed row with nobody
    // able to stop its browser is worse than an unclaimed one.
    expect(rpcCalls).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toContain("BROWSER_USE_API_KEY");
  });
});

describe("a claim that fails", () => {
  it("throws, so a broken tick is not a green one", async () => {
    const { db } = fakeDb({ claim: { data: null, error: { message: "no such function" } } });
    await expect(sweepAbandonedTakeovers(ENV, deps(db))).rejects.toThrow(
      "claim_due_browser_takeovers failed: no such function",
    );
  });
});

describe("an abandoned takeover", () => {
  it("is stopped at the provider and marked expired, with the jar read back", async () => {
    const { db, updates } = fakeDb({ claim: { data: [row()], error: null } });
    const result = await sweepAbandonedTakeovers(ENV, deps(db));

    expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });
    expect(stopBrowser).toHaveBeenCalledWith(ENV, "s-1", expect.anything());

    const settled = updates.find((u) => u.table === "browser_takeovers");
    expect(settled?.patch).toEqual({
      status: "expired",
      closed_at: "2026-10-10T12:00:00.000Z",
      provider_stopped_at: "2026-10-10T12:00:00.000Z",
      claimed_at: null,
    });
    // Conditional on `open`, so a close that won the row out from under this
    // sweep is not overwritten. closeTakeover does not read claimed_at.
    expect(settled?.filters).toEqual([
      ["id", "t-1"],
      ["status", "open"],
    ]);

    const jar = updates.find((u) => u.table === "browser_profiles");
    expect(jar?.patch).toEqual({
      cookie_domains: ["mail.example.com"],
      last_used_at: "2026-10-10T12:00:00.000Z",
    });
  });
});

/**
 * The claim's SECOND arm, which had no fixture at all and could not be settled.
 *
 * A row reaches it when the person DID press done and the provider refused the
 * stop at the time: `closed`, with `provider_stopped_at` still null. Writing
 * `expired` here would overwrite their own close; writing nothing — which is
 * what a guard on `status = 'open'` does — leaves the row claimable forever and
 * eventually starves the batch.
 */
describe("a close whose stop the provider refused at the time", () => {
  it("records only the stop confirmation, leaving the person's own close intact", async () => {
    const { db, updates } = fakeDb({
      claim: { data: [row({ status: "closed" })], error: null },
    });
    const result = await sweepAbandonedTakeovers(ENV, deps(db));

    expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });

    const settled = updates.find((u) => u.table === "browser_takeovers");
    // `closed` stays: they pressed done, and that is a different fact from
    // having walked away.
    expect(settled?.patch).toEqual({
      provider_stopped_at: "2026-10-10T12:00:00.000Z",
      claimed_at: null,
    });
    expect(settled?.filters).toEqual([
      ["id", "t-1"],
      ["status", "closed"],
    ]);
  });

  it("writes something, so the row cannot re-enter the claim set forever", async () => {
    const { db, updates } = fakeDb({
      claim: { data: [row({ status: "closed" })], error: null },
    });
    await sweepAbandonedTakeovers(ENV, deps(db));

    // The regression this pins: guarded on `status = 'open'`, the update
    // matched zero rows — no error, no failure count — and the row came back
    // on every tick for ever.
    const touched = updates.filter((u) => u.table === "browser_takeovers");
    expect(touched).toHaveLength(1);
    expect(touched[0].patch.provider_stopped_at).toBeTruthy();
    // And never `expired`, which has no arm in the claim predicate.
    expect(touched[0].patch.status).toBeUndefined();
  });
});

describe("a stop the provider did not perform", () => {
  it("releases the claim and writes no status, when the request errors", async () => {
    stopBrowser.mockResolvedValue({ kind: "error", status: 502, message: "bad gateway" });
    const { db, updates } = fakeDb({ claim: { data: [row()], error: null } });
    const result = await sweepAbandonedTakeovers(ENV, deps(db));

    expect(result).toEqual({ claimed: 1, ok: 0, failed: 1 });
    expect(updates).toEqual([
      { table: "browser_takeovers", patch: { claimed_at: null }, filters: [["id", "t-1"]] },
    ]);
    expect(getProfile).not.toHaveBeenCalled();
  });

  /**
   * The one that matters. A 200 with `status: "active"` is the provider saying
   * "I heard you", not "it is stopped" — and this is the last thing that will
   * ever look at this row, so believing the 200 would leave a browser running
   * to its own timeout with the jar unsaved and nothing to reclaim it.
   */
  it("releases the claim on a 200 that still reports active", async () => {
    stopBrowser.mockResolvedValue({ kind: "ok", value: { id: "s-1", status: "active" } });
    const { db, updates } = fakeDb({ claim: { data: [row()], error: null } });
    const result = await sweepAbandonedTakeovers(ENV, deps(db));

    expect(result).toEqual({ claimed: 1, ok: 0, failed: 1 });
    expect(updates).toEqual([
      { table: "browser_takeovers", patch: { claimed_at: null }, filters: [["id", "t-1"]] },
    ]);
    // Nothing was marked expired, so the predicate's first arm still sees it.
    expect(updates.some((u) => u.patch.status === "expired")).toBe(false);
  });
});

describe("a row that names no provider session", () => {
  it("is settled rather than left to be claimed forever", async () => {
    const { db, updates } = fakeDb({
      claim: { data: [row({ provider_session_id: null })], error: null },
    });
    const result = await sweepAbandonedTakeovers(ENV, deps(db));

    expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });
    expect(stopBrowser).not.toHaveBeenCalled();
    expect(updates[0]?.patch.status).toBe("expired");
  });
});

describe("one row blowing up", () => {
  it("does not strand the others", async () => {
    stopBrowser
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue({ kind: "ok", value: { id: "s-2", status: "stopped" } });
    const { db, updates } = fakeDb({
      claim: { data: [row({ id: "t-1" }), row({ id: "t-2" })], error: null },
    });

    const result = await sweepAbandonedTakeovers(ENV, deps(db));

    expect(result).toEqual({ claimed: 2, ok: 1, failed: 1 });
    expect(updates.some((u) => u.filters.some(([, v]) => v === "t-2"))).toBe(true);
  });
});

describe("a jar that cannot be read back", () => {
  it("still leaves the takeover settled, because the stop already happened", async () => {
    getProfile.mockResolvedValue({ kind: "error", status: 500, message: "boom" });
    const { db, updates } = fakeDb({ claim: { data: [row()], error: null } });
    const result = await sweepAbandonedTakeovers(ENV, deps(db));

    expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });
    expect(updates.find((u) => u.table === "browser_takeovers")?.patch.status).toBe("expired");
    expect(updates.some((u) => u.table === "browser_profiles")).toBe(false);
  });
});

describe("a Postgres error", () => {
  it("is logged as a code and a message, never the object", async () => {
    const { db } = fakeDb({
      claim: { data: [row()], error: null },
      updateError: { code: "23514", message: "violates check constraint" },
    });
    await sweepAbandonedTakeovers(ENV, deps(db));

    // A check violation's DETAIL is `Failing row contains (…)` — the whole row,
    // including provider_session_id, which is a live browser. See spec 4a.
    const logged: string = error.mock.calls.flat().map(JSON.stringify).join(" ");
    expect(logged).toContain("23514");
    // provider_session_id must never reach a log line.
    expect(logged).not.toContain("s-1");
  });
});

/**
 * The same lag `takeover.ts`'s `JAR_ATTEMPTS` is about, arriving where nobody
 * is waiting — so the answer is different.
 *
 * The provider writes the profile some seconds after reporting the browser
 * stopped (measured at 3.1s on 2026-10-09), and a cron tick must not be held
 * for that: this read is display-only, and the next close rewrites the column
 * anyway. But writing the empty list it reads too early is worse than leaving
 * the column alone — it replaces a correct list of somebody's sign-ins with
 * "none", so the settings screen says no sign-ins have been saved while the
 * jar at the provider still holds them, and the forget control reports nothing
 * to forget.
 *
 * A jar does not empty itself. The only thing that empties one is
 * `forgetProfile`, which deletes the row outright.
 */

/**
 * The same lag `takeover.ts`'s `JAR_ATTEMPTS` is about, arriving where nobody
 * is waiting — so the answer is different.
 *
 * The provider writes the profile some seconds after reporting the browser
 * stopped (3.1s, measured 2026-10-09), and a cron tick must not be held for
 * that: this read is display-only and the next close rewrites the column
 * anyway. But WRITING the empty list it read too early is worse than leaving
 * the column alone — it replaces a correct list of somebody's sign-ins with
 * "none", so the settings screen says nothing has been saved while the jar at
 * the provider still holds it, and the forget control reports nothing to
 * forget.
 *
 * A jar does not empty itself. The only thing that empties one is
 * `forgetProfile`, which deletes the row outright.
 */
describe("the jar read the sweep does not trust", () => {
  it("does not replace a list of sign-ins with an empty one", async () => {
    const { db, updates } = fakeDb({
      claim: { data: [row()], error: null },
      profileRow: { provider_profile_id: "p-1", cookie_domains: ["linkedin.com"] },
    });
    getProfile.mockResolvedValue({ kind: "ok", value: { id: "p-1", cookieDomains: [] } });

    await sweepAbandonedTakeovers(ENV, deps(db));

    expect(updates.some((u) => u.table === "browser_profiles")).toBe(false);
  });

  it("still writes an empty one when there was nothing there before", async () => {
    const { db, updates } = fakeDb({
      claim: { data: [row()], error: null },
      profileRow: { provider_profile_id: "p-1", cookie_domains: [] },
    });
    getProfile.mockResolvedValue({ kind: "ok", value: { id: "p-1", cookieDomains: [] } });

    await sweepAbandonedTakeovers(ENV, deps(db));

    const jar = updates.find((u) => u.table === "browser_profiles");
    expect(jar?.patch).toMatchObject({ cookie_domains: [] });
  });

  it("writes what the provider says when it says something", async () => {
    const { db, updates } = fakeDb({
      claim: { data: [row()], error: null },
      profileRow: { provider_profile_id: "p-1", cookie_domains: ["old.example"] },
    });
    getProfile.mockResolvedValue({
      kind: "ok",
      value: { id: "p-1", cookieDomains: ["linkedin.com", "old.example"] },
    });

    await sweepAbandonedTakeovers(ENV, deps(db));

    const jar = updates.find((u) => u.table === "browser_profiles");
    expect(jar?.patch).toMatchObject({ cookie_domains: ["linkedin.com", "old.example"] });
  });
});

// ---- the sweep of a browser nobody handed back -------------------------------

/**
 * `sweepConversationBrowsers`: the person took the controls and walked away. The
 * browser is running at the provider, billing, with the sign-in they performed
 * unsaved, and only a stop fixes both.
 *
 * The database is `memoryDb`, not the recording double above, because the
 * thing this sweep must get right is a CONDITION: every write is `where
 * live_state = 'human'`, so a person who pressed Done while the sweep was
 * stopping the browser is not overwritten. A double that recorded filters
 * without applying them would let the condition be dropped and still pass.
 */
describe("the sweep of a browser nobody handed back", () => {
  const HUMAN = "2026-10-10T11:40:00.000Z";
  /** The claim's own `claimed_at`, which only a settled row or a stale lease lets go of. */
  const LEASE = "2026-10-10T12:00:00.000Z";

  function session(over: Record<string, unknown> = {}) {
    return {
      id: "bs-1",
      user_id: "u-1",
      profile_id: "pr-1",
      live_state: "human",
      human_since: HUMAN,
      human_started_at: HUMAN,
      claimed_at: "2026-10-10T12:00:00.000Z",
      provider_session_id: "bu-session-1",
      provider_browser_id: "bu-browser-1",
      ...over,
    };
  }

  function setup(
    due: Record<string, unknown>[] = [session()],
    profile: Record<string, unknown> | null = {
      id: "pr-1",
      provider_profile_id: "bu-profile-1",
      cookie_domains: [],
    },
  ) {
    const mem = memoryDb({
      // What the claim function returned is also what the table holds: the RPC
      // is a fake of `update … set claimed_at = now() returning`.
      browser_sessions: due,
      browser_profiles: profile ? [profile] : [],
    });
    const rpcCalls: { fn: string; args: unknown }[] = [];
    const db = {
      from: (table: string) => mem.db.from(table),
      rpc: (fn: string, args: unknown) => {
        rpcCalls.push({ fn, args });
        return Promise.resolve({ data: due, error: null });
      },
    } as unknown as SupabaseClient;
    const sleep = vi.fn(async (_ms: number) => {});
    return { mem, db, rpcCalls, sleep, deps: { db, now, sleep } };
  }

  let browsersFor: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    browsersFor = vi
      .spyOn(v4, "browsersFor")
      .mockResolvedValue({ kind: "ok", value: [{ id: "bu-browser-1", status: "active" }] });
    stopBrowser.mockResolvedValue({ kind: "ok", value: { id: "bu-browser-1", status: "stopped" } });
  });

  it("claims with the human sweep's own batch and lease, and touches nothing when idle", async () => {
    const { deps, rpcCalls, mem } = setup([]);
    const result = await sweepConversationBrowsers(ENV, deps);

    expect(result).toEqual({ claimed: 0, ok: 0, failed: 0 });
    expect(rpcCalls).toEqual([
      {
        fn: "claim_due_browser_sessions",
        args: { p_limit: BROWSER_BATCH_SIZE, p_stale_after: "15 minutes" },
      },
    ]);
    expect(browsersFor).not.toHaveBeenCalled();
    expect(mem.tables.browser_sessions).toEqual([]);
  });

  it("claims nothing on a Worker with no browser key", async () => {
    const { deps, rpcCalls } = setup();
    const result = await sweepConversationBrowsers(NO_KEY, deps);

    expect(result).toEqual({ claimed: 0, ok: 0, failed: 0 });
    expect(rpcCalls).toEqual([]);
  });

  it("throws when the claim fails, so a broken tick is not a green one", async () => {
    const { deps } = setup();
    const db = {
      rpc: () => Promise.resolve({ data: null, error: { message: "no such function" } }),
    } as unknown as SupabaseClient;
    await expect(sweepConversationBrowsers(ENV, { ...deps, db })).rejects.toThrow(
      "claim_due_browser_sessions failed: no such function",
    );
  });

  it("stops the active browser, refreshes the jar, and settles the row to none", async () => {
    browsersFor.mockResolvedValue({
      kind: "ok",
      value: [
        { id: "bu-browser-0", status: "stopped" },
        { id: "bu-browser-1", status: "active" },
      ],
    });
    getProfile.mockResolvedValue({
      kind: "ok",
      value: { id: "bu-profile-1", cookieDomains: ["linkedin.com"] },
    });
    const { deps, mem } = setup();

    const result = await sweepConversationBrowsers(ENV, deps);

    expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });
    expect(browsersFor).toHaveBeenCalledWith(ENV, "bu-session-1", expect.anything());
    expect(stopBrowser).toHaveBeenCalledOnce();
    expect(stopBrowser).toHaveBeenCalledWith(ENV, "bu-browser-1", expect.anything());
    // The provider's profile id, resolved from OUR profile row by the service
    // role, as the takeover sweep does.
    expect(getProfile).toHaveBeenCalledWith(ENV, "bu-profile-1", expect.anything());
    expect(mem.tables.browser_profiles[0]).toMatchObject({
      cookie_domains: ["linkedin.com"],
      last_used_at: "2026-10-10T12:00:00.000Z",
    });
    expect(mem.tables.browser_sessions[0]).toMatchObject({
      live_state: "none",
      human_since: null,
      claimed_at: null,
    });
  });

  /**
   * The ordering that makes a half-finished sweep recoverable: the jar is read
   * back BEFORE the row lets go, so a worker that dies in the wait leaves the
   * row claimed and human, and the lease's expiry retries it (a stop of an
   * already-stopped browser is a no-op) rather than losing the refresh.
   */
  it("lets go of the row only after the jar has been read back", async () => {
    const { deps, mem } = setup();
    let rowWhenJarRead: unknown;
    getProfile.mockImplementation(async () => {
      rowWhenJarRead = { ...mem.tables.browser_sessions[0] };
      return { kind: "ok", value: { id: "bu-profile-1", cookieDomains: ["a.example"] } };
    });

    await sweepConversationBrowsers(ENV, deps);

    expect(rowWhenJarRead).toMatchObject({ live_state: "human", human_since: HUMAN });
  });

  describe("a stop that did not happen", () => {
    it("keeps human_since and the lease when the request errors, so the row is retried only when the lease goes stale", async () => {
      stopBrowser.mockResolvedValue({ kind: "error", status: 502, message: "bad gateway" });
      const { deps, mem } = setup();

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(result).toEqual({ claimed: 1, ok: 0, failed: 1 });
      expect(mem.tables.browser_sessions[0]).toMatchObject({
        live_state: "human",
        human_since: HUMAN,
        claimed_at: LEASE,
      });
      expect(getProfile).not.toHaveBeenCalled();
      expect(mem.tables.browser_profiles[0].cookie_domains).toEqual([]);
    });

    it("treats a 200 that still reports active as not stopped", async () => {
      stopBrowser.mockResolvedValue({
        kind: "ok",
        value: { id: "bu-browser-1", status: "active" },
      });
      const { deps, mem } = setup();

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(result).toEqual({ claimed: 1, ok: 0, failed: 1 });
      expect(mem.tables.browser_sessions[0]).toMatchObject({
        live_state: "human",
        human_since: HUMAN,
        claimed_at: LEASE,
      });
    });

    it("keeps the lease when the provider cannot list the session's browsers and none is stored", async () => {
      browsersFor.mockResolvedValue({ kind: "error", status: 500, message: "boom" });
      const { deps, mem } = setup([session({ provider_browser_id: null })]);

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(result).toEqual({ claimed: 1, ok: 0, failed: 1 });
      expect(stopBrowser).not.toHaveBeenCalled();
      expect(mem.tables.browser_sessions[0]).toMatchObject({
        live_state: "human",
        human_since: HUMAN,
        claimed_at: LEASE,
      });
    });

    it("falls back to the stored browser when the list fails", async () => {
      browsersFor.mockResolvedValue({ kind: "error", status: 500, message: "boom" });
      const { deps, mem } = setup();

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(result.ok).toBe(1);
      expect(stopBrowser).toHaveBeenCalledWith(ENV, "bu-browser-1", expect.anything());
      expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "none" });
    });
  });

  /**
   * A failed stop must not hand the row straight back to the claim: this stage
   * short-circuits the tick whenever it claims anything, so a stop that keeps
   * failing would otherwise starve the browser poll and the connection sync
   * for as long as the browser lives. The lease is what spaces the retries.
   */
  it("does not touch a row whose stop failed, so the lease spaces the retry", async () => {
    stopBrowser.mockResolvedValue({ kind: "error", status: 502, message: "bad gateway" });
    const { deps, mem } = setup();
    const before = { ...mem.tables.browser_sessions[0] };

    await sweepConversationBrowsers(ENV, deps);

    expect(mem.tables.browser_sessions[0]).toEqual(before);
  });

  describe("a browser past the provider's lifetime", () => {
    // Four hours and a minute before the fixed clock.
    const OLD = "2026-10-10T07:59:00.000Z";

    it("settles to none without calling stop, the provider's timeout having ended it", async () => {
      getProfile.mockResolvedValue({
        kind: "ok",
        value: { id: "bu-profile-1", cookieDomains: ["linkedin.com"] },
      });
      const { deps, mem } = setup([session({ human_started_at: OLD })]);

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });
      expect(browsersFor).not.toHaveBeenCalled();
      expect(stopBrowser).not.toHaveBeenCalled();
      expect(mem.tables.browser_profiles[0].cookie_domains).toEqual(["linkedin.com"]);
      expect(mem.tables.browser_sessions[0]).toMatchObject({
        live_state: "none",
        human_since: null,
        claimed_at: null,
      });
    });

    it("reads the jar once, without waiting", async () => {
      getProfile.mockResolvedValue({ kind: "ok", value: { id: "p", cookieDomains: [] } });
      const { deps, sleep } = setup([session({ human_started_at: OLD })]);

      await sweepConversationBrowsers(ENV, deps);

      expect(getProfile).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("still settles when the jar cannot be read", async () => {
      getProfile.mockResolvedValue({ kind: "error", status: 500, message: "boom" });
      const { deps, mem } = setup([session({ human_started_at: OLD })]);

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(result.ok).toBe(1);
      expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "none" });
    });

    it("does not overwrite a row handed back meanwhile", async () => {
      const { deps, mem } = setup([session({ human_started_at: OLD })]);
      const BACK = {
        live_state: "agent",
        human_since: null,
        claimed_at: "2026-10-10T12:00:09.000Z",
      };
      getProfile.mockImplementation(async () => {
        Object.assign(mem.tables.browser_sessions[0], BACK);
        return { kind: "ok", value: { id: "p", cookieDomains: [] } };
      });

      await sweepConversationBrowsers(ENV, deps);

      expect(mem.tables.browser_sessions[0]).toMatchObject(BACK);
    });

    /**
     * Ruling R21: the open tab bumps `human_since` once a minute, so it says
     * when the tab went quiet, not when the person took the browser. The
     * provider's four hours count from the take-over, `human_started_at`.
     */
    it("counts the four hours from the take-over, not from the tab's last heartbeat", async () => {
      const { deps, mem } = setup([
        session({ human_since: "2026-10-10T11:49:00.000Z", human_started_at: OLD }),
      ]);

      await sweepConversationBrowsers(ENV, deps);

      expect(stopBrowser).not.toHaveBeenCalled();
      expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "none" });
    });

    it("still stops a browser whose heartbeat is old but whose take-over is recent", async () => {
      const { deps } = setup([session({ human_since: OLD, human_started_at: HUMAN })]);

      await sweepConversationBrowsers(ENV, deps);

      expect(stopBrowser).toHaveBeenCalledOnce();
    });

    it("clears both clocks when it settles", async () => {
      const { deps, mem } = setup([session({ human_started_at: OLD })]);

      await sweepConversationBrowsers(ENV, deps);

      expect(mem.tables.browser_sessions[0]).toMatchObject({
        human_since: null,
        human_started_at: null,
      });
    });

    it("tries the stop at exactly four hours: the bound is past, not at", async () => {
      const { deps, mem } = setup([session({ human_started_at: "2026-10-10T08:00:00.000Z" })]);

      await sweepConversationBrowsers(ENV, deps);

      expect(stopBrowser).toHaveBeenCalledOnce();
      expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "none" });
    });
  });

  describe("no active browser", () => {
    it("is a browser already stopped: nothing to stop, the profile still refreshed, the row settled", async () => {
      browsersFor.mockResolvedValue({
        kind: "ok",
        value: [{ id: "bu-browser-1", status: "stopped" }],
      });
      getProfile.mockResolvedValue({
        kind: "ok",
        value: { id: "bu-profile-1", cookieDomains: ["mail.example.com"] },
      });
      const { deps, mem } = setup();

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });
      expect(stopBrowser).not.toHaveBeenCalled();
      expect(mem.tables.browser_profiles[0].cookie_domains).toEqual(["mail.example.com"]);
      expect(mem.tables.browser_sessions[0]).toMatchObject({
        live_state: "none",
        human_since: null,
        claimed_at: null,
      });
    });

    it("settles a row that names no provider session, with nothing to stop or read", async () => {
      const { deps, mem } = setup([
        session({ provider_session_id: null, provider_browser_id: null }),
      ]);

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });
      expect(browsersFor).not.toHaveBeenCalled();
      expect(stopBrowser).not.toHaveBeenCalled();
      expect(mem.tables.browser_sessions[0]).toMatchObject({
        live_state: "none",
        claimed_at: null,
      });
    });

    it("settles a row with no profile without asking the provider for a jar", async () => {
      const { deps, mem } = setup([session({ profile_id: null })]);

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(result.ok).toBe(1);
      expect(stopBrowser).toHaveBeenCalledOnce();
      expect(getProfile).not.toHaveBeenCalled();
      expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "none" });
    });
  });

  /**
   * The person pressed Done (or took the browser back and the agent is typing)
   * between the claim and the write. Every write here is conditional on
   * `live_state = 'human'`, so none of it lands on a row that has moved on.
   */
  describe("a row handed back while the sweep was stopping it", () => {
    const BACK = {
      live_state: "agent",
      human_since: null,
      claimed_at: "2026-10-10T12:00:09.000Z",
    };

    it("is not overwritten on success", async () => {
      const { deps, mem } = setup();
      stopBrowser.mockImplementation(async () => {
        Object.assign(mem.tables.browser_sessions[0], BACK);
        return { kind: "ok", value: { id: "bu-browser-1", status: "stopped" } };
      });

      await sweepConversationBrowsers(ENV, deps);

      expect(mem.tables.browser_sessions[0]).toMatchObject(BACK);
    });

    it("is not overwritten on a failed stop either", async () => {
      const { deps, mem } = setup();
      stopBrowser.mockImplementation(async () => {
        Object.assign(mem.tables.browser_sessions[0], BACK);
        return { kind: "error", status: 500, message: "boom" };
      });

      const result = await sweepConversationBrowsers(ENV, deps);

      // A failure, still: the stop did not happen. But the lease the hand-back
      // owns is not the sweep's to clear.
      expect(result.failed).toBe(1);
      expect(mem.tables.browser_sessions[0]).toMatchObject(BACK);
    });
  });

  /**
   * The jar-write lag `takeover.ts`'s `JAR_ATTEMPTS` waits out: the provider
   * writes the profile about three seconds after the browser reports stopped,
   * so an empty read straight after the stop is usually "not yet". The human
   * sweep waits as the takeover close does, because a Done that never saw the
   * sign-in is the whole failure this feature exists to prevent.
   */
  describe("the jar the provider writes a few seconds late", () => {
    it("waits for a non-empty read, a second at a time", async () => {
      getProfile
        .mockResolvedValueOnce({ kind: "ok", value: { id: "p", cookieDomains: [] } })
        .mockResolvedValueOnce({ kind: "ok", value: { id: "p", cookieDomains: [] } })
        .mockResolvedValue({ kind: "ok", value: { id: "p", cookieDomains: ["linkedin.com"] } });
      const { deps, mem, sleep } = setup();

      await sweepConversationBrowsers(ENV, deps);

      expect(getProfile).toHaveBeenCalledTimes(3);
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(1_000);
      expect(mem.tables.browser_profiles[0].cookie_domains).toEqual(["linkedin.com"]);
    });

    it("stops asking after JAR_ATTEMPTS, and does not sleep after the last read", async () => {
      getProfile.mockResolvedValue({ kind: "ok", value: { id: "p", cookieDomains: [] } });
      const { deps, mem, sleep } = setup();

      await sweepConversationBrowsers(ENV, deps);

      expect(getProfile).toHaveBeenCalledTimes(JAR_ATTEMPTS);
      expect(sleep).toHaveBeenCalledTimes(JAR_ATTEMPTS - 1);
      // Nothing was there before, so the empty answer is written truthfully.
      expect(mem.tables.browser_profiles[0].cookie_domains).toEqual([]);
      expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "none" });
    });

    it("never replaces a stored list with an empty read", async () => {
      getProfile.mockResolvedValue({ kind: "ok", value: { id: "p", cookieDomains: [] } });
      const { deps, mem } = setup([session()], {
        id: "pr-1",
        provider_profile_id: "bu-profile-1",
        cookie_domains: ["old.example"],
      });

      await sweepConversationBrowsers(ENV, deps);

      expect(mem.tables.browser_profiles[0].cookie_domains).toEqual(["old.example"]);
      expect(mem.tables.browser_sessions[0]).toMatchObject({ live_state: "none" });
    });

    it("still settles the row when the jar cannot be read at all, the stop having happened", async () => {
      getProfile.mockResolvedValue({ kind: "error", status: 500, message: "boom" });
      const { deps, mem, sleep } = setup();

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });
      expect(sleep).not.toHaveBeenCalled();
      expect(mem.tables.browser_sessions[0]).toMatchObject({
        live_state: "none",
        claimed_at: null,
      });
    });
  });

  it("does not let one blown-up row strand the others", async () => {
    stopBrowser
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValue({ kind: "ok", value: { id: "bu-browser-1", status: "stopped" } });
    const { deps, mem } = setup([
      session({ id: "bs-1" }),
      session({ id: "bs-2", provider_session_id: "bu-session-2" }),
    ]);

    const result = await sweepConversationBrowsers(ENV, deps);

    expect(result).toEqual({ claimed: 2, ok: 1, failed: 1 });
    const byId = Object.fromEntries(mem.tables.browser_sessions.map((r) => [r.id, r]));
    expect(byId["bs-2"]).toMatchObject({ live_state: "none" });
    // The thrown one keeps its lease, which is what expires into a retry.
    expect(byId["bs-1"]).toMatchObject({ live_state: "human", human_since: HUMAN });
  });

  it("logs no provider id and no row", async () => {
    stopBrowser.mockResolvedValue({ kind: "error", status: 500, message: "boom" });
    const { deps } = setup();

    await sweepConversationBrowsers(ENV, deps);

    const logged = [...error.mock.calls, ...warn.mock.calls].flat().map(String).join(" ");
    expect(logged).not.toContain("bu-session-1");
    expect(logged).not.toContain("bu-browser-1");
  });

  /**
   * Ruling R20: a browser nobody is using. The last run ended, nobody took
   * over, and the browser is still open at the provider — billing until its
   * own idle cleanup, with whatever the run's pages set in its cookies not yet
   * saved to the profile. Ten minutes after the last run the sweep stops it,
   * reads the jar back, and clears `provider_browser_id`: the row's own record
   * that its browser is stopped, which is also what tells the panel there is
   * no browser to show.
   */
  describe("a browser nobody is using", () => {
    // Eleven minutes before the fixed clock.
    const LAST_RUN = "2026-10-10T11:49:00.000Z";

    function idle(over: Record<string, unknown> = {}) {
      return session({ live_state: "none", human_since: null, last_run_at: LAST_RUN, ...over });
    }

    it("is claimed by the same call, in the same batch, as the browsers in somebody's hands", async () => {
      const { deps, rpcCalls } = setup([idle(), session({ id: "bs-2" })]);

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(rpcCalls).toEqual([
        {
          fn: "claim_due_browser_sessions",
          args: { p_limit: BROWSER_BATCH_SIZE, p_stale_after: "15 minutes" },
        },
      ]);
      expect(result).toEqual({ claimed: 2, ok: 2, failed: 0 });
    });

    it("stops it, refreshes the jar, and clears the browser it named", async () => {
      getProfile.mockResolvedValue({
        kind: "ok",
        value: { id: "bu-profile-1", cookieDomains: ["linkedin.com"] },
      });
      const { deps, mem } = setup([idle()]);

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });
      expect(browsersFor).toHaveBeenCalledWith(ENV, "bu-session-1", expect.anything());
      expect(stopBrowser).toHaveBeenCalledWith(ENV, "bu-browser-1", expect.anything());
      expect(mem.tables.browser_profiles[0]).toMatchObject({ cookie_domains: ["linkedin.com"] });
      expect(mem.tables.browser_sessions[0]).toMatchObject({
        live_state: "none",
        provider_browser_id: null,
        claimed_at: null,
        // The agent session stays: a follow-up continues it, and the provider
        // gives it a new browser (`browser.reattached`).
        provider_session_id: "bu-session-1",
        last_run_at: LAST_RUN,
      });
    });

    it("keeps the lease and the browser it named when the stop fails, so the lease spaces the retry", async () => {
      stopBrowser.mockResolvedValue({ kind: "error", status: 502, message: "bad gateway" });
      const { deps, mem } = setup([idle()]);
      const before = { ...mem.tables.browser_sessions[0] };

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(result).toEqual({ claimed: 1, ok: 0, failed: 1 });
      expect(mem.tables.browser_sessions[0]).toEqual(before);
      expect(getProfile).not.toHaveBeenCalled();
    });

    it("gives up on the stop four hours after the last run, and still clears the marker", async () => {
      getProfile.mockResolvedValue({
        kind: "ok",
        value: { id: "p", cookieDomains: ["a.example"] },
      });
      const { deps, mem, sleep } = setup([idle({ last_run_at: "2026-10-10T07:59:00.000Z" })]);

      const result = await sweepConversationBrowsers(ENV, deps);

      expect(result).toEqual({ claimed: 1, ok: 1, failed: 0 });
      expect(browsersFor).not.toHaveBeenCalled();
      expect(stopBrowser).not.toHaveBeenCalled();
      expect(getProfile).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
      expect(mem.tables.browser_sessions[0]).toMatchObject({
        provider_browser_id: null,
        claimed_at: null,
      });
    });

    /**
     * A `browse` that started between the claim and the write took the
     * browser: `last_run_at` moved and `live_state` is `agent`. The marker it
     * names is the new run's browser now, and is not the sweep's to clear.
     */
    it("does not clear the browser of a run that started meanwhile", async () => {
      const { deps, mem } = setup([idle()]);
      const AGAIN = { live_state: "agent", last_run_at: "2026-10-10T12:00:05.000Z" };
      stopBrowser.mockImplementation(async () => {
        Object.assign(mem.tables.browser_sessions[0], AGAIN);
        return { kind: "ok", value: { id: "bu-browser-1", status: "stopped" } };
      });

      await sweepConversationBrowsers(ENV, deps);

      expect(mem.tables.browser_sessions[0]).toMatchObject({
        ...AGAIN,
        provider_browser_id: "bu-browser-1",
      });
    });

    it("never writes live_state on a browser nobody was using", async () => {
      const { deps, mem } = setup([idle()]);

      await sweepConversationBrowsers(ENV, deps);

      const writes = mem.callsTo("browser_sessions").filter((c) => c.op === "update");
      expect(writes).toHaveLength(1);
      expect(writes[0].values).toEqual({ provider_browser_id: null, claimed_at: null });
      expect(writes[0].filters).toEqual(
        expect.arrayContaining([
          { column: "live_state", value: "none", kind: "eq" },
          { column: "last_run_at", value: LAST_RUN, kind: "eq" },
        ]),
      );
    });
  });

  /**
   * The marker is the same for both arms: a browser the sweep has seen stopped
   * is a browser the row no longer names, so the panel's `browserReady` stops
   * saying there is one to show.
   */
  it("clears the browser a human-mode row named once its stop is confirmed", async () => {
    const { deps, mem } = setup();

    await sweepConversationBrowsers(ENV, deps);

    expect(mem.tables.browser_sessions[0]).toMatchObject({
      live_state: "none",
      provider_browser_id: null,
    });
  });

  it("leaves the takeover sweep's claim alone", async () => {
    const { db, rpcCalls } = fakeDb({ claim: { data: [], error: null } });
    await sweepAbandonedTakeovers(ENV, deps(db));

    expect(rpcCalls.map((c) => c.fn)).toEqual(["claim_due_browser_takeovers"]);
  });
});
