import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { BATCH_SIZE, sweepAbandonedTakeovers, type SweepDeps } from "./sweep";
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
  profileRow?: { provider_profile_id: string } | null;
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
                  opts.profileRow === undefined ? { provider_profile_id: "p-1" } : opts.profileRow,
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
      { fn: "claim_due_browser_takeovers", args: { p_limit: BATCH_SIZE } },
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
