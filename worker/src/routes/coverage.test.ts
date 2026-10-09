import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { coverage } from "./coverage";

const USER_ID = "user-1";
const WORKSPACE_ID = "workspace-1";

type RpcResult = { data: unknown[] | null; error: { code?: string; message?: string } | null };

type Role = "admin" | "member";

/**
 * Carried across separate `fakeDb()` calls within one test, because
 * `fakeDb()` itself is stateless and a fresh one is built per `request()` —
 * see `request` below. Two of the new tests below ("takes it back", "is
 * idempotent") make several calls in a row and expect the later ones to see
 * what the earlier ones wrote, the way a real connection would. `fakeDb`
 * mutates this object in place rather than owning its own copy of it.
 */
type SettingsState = { optedOut: boolean; lastWorkspaceUpdate: Record<string, unknown> | null };

/**
 * Enough of the request-scoped client for `getActiveWorkspaceId` to resolve and
 * for the two RPCs to answer, plus the arguments each was called with — the
 * window is the one thing this route decides on its own, so the tests have to
 * be able to see what it decided.
 *
 * Extended (not replaced) for "the switch" and "a member's own choice" below:
 * an optional second argument gives `workspaces` an UPDATE and
 * `coverage_opt_outs` a SELECT/UPSERT/DELETE, neither of which the original
 * `GET /coverage/workspace` tests above ever touch, so they are unaffected.
 *
 * `role` only ever changes what the `workspaces` UPDATE answers. That mirrors
 * the one thing RLS actually gates in this file's routes:
 * `workspaces_update_admin` is a USING clause, so a non-admin's UPDATE matches
 * zero rows rather than erroring — see the comment on `PATCH
 * /coverage/settings` in `coverage.ts`. `coverage_opt_outs`'s policies only
 * ever check `user_id = auth.uid()`, and this fake has no caller-mismatch case
 * to model, so its behaviour here does not vary with `role`.
 *
 * None of this is RLS. A fake does whatever it is told; what these tests can
 * prove is that each route reacts correctly to what the database told it, not
 * that the database was right to say it. The admin enforcement itself is
 * proved against a live database by `tests/rls/coverage-gaps.test.ts`, in its
 * describe block "who may turn the report on".
 */
function fakeDb(
  rpcs: Record<string, RpcResult>,
  opts: { role?: Role; state?: SettingsState } = {},
) {
  const role = opts.role ?? "admin";
  const state = opts.state;
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db = {
    from(table: string) {
      if (table === "workspaces" && state) {
        return {
          update: (values: Record<string, unknown>) => {
            state.lastWorkspaceUpdate = values;
            return {
              eq: () => ({
                select: async () => ({
                  data: role === "admin" ? [{ id: WORKSPACE_ID, ...values }] : [],
                  error: null,
                }),
              }),
            };
          },
        };
      }

      if (table === "coverage_opt_outs" && state) {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: state.optedOut ? { user_id: USER_ID } : null,
                  error: null,
                }),
              }),
            }),
          }),
          // An upsert IS an insert with a conflict target — the options object
          // is how PostgREST is asked for `ON CONFLICT DO NOTHING`, not a
          // detail this fake needs to branch on.
          upsert: async () => {
            state.optedOut = true;
            return { data: null, error: null };
          },
          delete: () => ({
            eq: () => ({
              eq: async () => {
                state.optedOut = false;
                return { data: null, error: null };
              },
            }),
          }),
        };
      }

      const single = async () =>
        table === "profiles"
          ? { data: { active_workspace_id: WORKSPACE_ID }, error: null }
          : { data: { workspace_id: WORKSPACE_ID }, error: null };
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: single,
        single,
      };
      return chain;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return rpcs[name] ?? { data: [], error: null };
    },
  };
  return { db, calls };
}

function appWithDb(db: unknown) {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: USER_ID, email: "a@example.com" } as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", coverage);
  return app;
}

const asAdmin: Role = "admin";
const asMember: Role = "member";

/**
 * Not a copy of the client — a request against a fresh app wired to a fresh
 * `fakeDb()`, except for `settingsState`, which is shared by reference. That
 * is what lets a test make several `request()` calls in a row ("PUT true,
 * then PUT false, then GET") and have the later ones see what the earlier
 * ones wrote.
 *
 * `settingsState` is declared and reset by each of the two `describe` blocks
 * below that use this — see their own `beforeEach`.
 */
function request(method: string, path: string, body: unknown, role: Role) {
  const { db } = fakeDb({}, { role, state: settingsState });
  return appWithDb(db).request(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** What the most recent `request()` call's UPDATE sent to `table`. */
function updated(table: "workspaces") {
  return table === "workspaces" ? settingsState.lastWorkspaceUpdate : null;
}

let settingsState: SettingsState = { optedOut: false, lastWorkspaceUpdate: null };

const TOTALS_ROW = {
  answers: 100,
  covered: 62,
  fallback: 31,
  ungrounded: 7,
  unrecorded: 12,
};

const AGENT_ROW = {
  agent_id: "agent-1",
  agent_name: "Handbook",
  agent_emoji: "📘",
  answers: 40,
  covered: 20,
  fallback: 18,
  ungrounded: 2,
};

function ok(overrides: Partial<Record<string, RpcResult>> = {}) {
  return fakeDb({
    workspace_coverage: { data: [TOTALS_ROW], error: null },
    workspace_coverage_agents: { data: [AGENT_ROW], error: null },
    ...overrides,
  });
}

describe("GET /coverage/workspace", () => {
  it("returns the four buckets and a per-agent breakdown", async () => {
    const { db } = ok();

    const res = await appWithDb(db).request("/coverage/workspace");
    const body = (await res.json()) as {
      available: boolean;
      days: number;
      totals: Record<string, number>;
      agents: Record<string, unknown>[];
    };

    expect(res.status).toBe(200);
    expect(body.available).toBe(true);
    expect(body.days).toBe(30);
    expect(body.totals).toEqual({
      answers: 100,
      covered: 62,
      fallback: 31,
      ungrounded: 7,
      unrecorded: 12,
    });
    expect(body.agents).toEqual([
      {
        agentId: "agent-1",
        name: "Handbook",
        emoji: "📘",
        answers: 40,
        covered: 20,
        fallback: 18,
        ungrounded: 2,
      },
    ]);
  });

  // The promise 0053 makes in its header, held to the wire rather than to the
  // SQL: neither function selects a user, so nothing keyed to a person can
  // reach a client through this route.
  it("says nothing about who asked", async () => {
    const { db } = ok();

    const res = await appWithDb(db).request("/coverage/workspace");
    const body = await res.text();

    expect(body).not.toContain("user_id");
    expect(body).not.toContain("userId");
  });

  it("counts a bigint that arrived as a string", async () => {
    const { db } = ok({
      workspace_coverage: {
        data: [{ ...TOTALS_ROW, answers: "100", covered: "62" }],
        error: null,
      },
    });

    const res = await appWithDb(db).request("/coverage/workspace");
    const body = (await res.json()) as { totals: { answers: number; covered: number } };

    expect(body.totals.answers).toBe(100);
    expect(body.totals.covered).toBe(62);
  });

  it("clamps the window rather than refusing it, and passes it to both functions", async () => {
    for (const [query, expected] of [
      ["?days=7", 7],
      ["?days=0", 1],
      ["?days=99999", 365],
      ["?days=banana", 30],
      ["", 30],
    ] as const) {
      const { db, calls } = ok();

      const res = await appWithDb(db).request(`/coverage/workspace${query}`);
      const body = (await res.json()) as { days: number };

      expect(res.status).toBe(200);
      expect(body.days).toBe(expected);
      expect(calls.map((c) => c.args.p_days)).toEqual([expected, expected]);
    }
  });

  // 0053 raises 42501 rather than returning no rows, precisely so this can be
  // told apart from a workspace nobody has asked anything in.
  it("turns the function's own refusal into a 403, not an empty result", async () => {
    const { db } = ok({
      workspace_coverage: { data: null, error: { code: "42501", message: "not an admin" } },
    });

    const res = await appWithDb(db).request("/coverage/workspace");

    expect(res.status).toBe(403);
  });

  // CI does not apply migrations. Between deploying this and somebody pasting
  // 0053 into the SQL editor the function genuinely is not there, and that is
  // a deployment state rather than a fault.
  it("reports a missing migration as unavailable rather than as a failure", async () => {
    for (const code of ["PGRST202", "42883"]) {
      const { db } = ok({
        workspace_coverage: { data: null, error: { code, message: "could not find function" } },
      });

      const res = await appWithDb(db).request("/coverage/workspace");
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body.available).toBe(false);
      expect(body.agents).toEqual([]);
    }
  });

  it("still fails loudly on an error that is neither of those", async () => {
    const { db } = ok({
      workspace_coverage: { data: null, error: { code: "57014", message: "canceling statement" } },
    });

    const res = await appWithDb(db).request("/coverage/workspace");

    expect(res.status).toBe(500);
  });

  // A workspace with no replies still gets a row of zeroes out of the
  // function; an empty array is the shape nothing should produce, and the
  // screen it feeds exists to be reassuring rather than to throw.
  it("answers with zeroes when the function returns no row at all", async () => {
    const { db } = ok({ workspace_coverage: { data: [], error: null } });

    const res = await appWithDb(db).request("/coverage/workspace");
    const body = (await res.json()) as { totals: Record<string, number> };

    expect(body.totals).toEqual({
      answers: 0,
      covered: 0,
      fallback: 0,
      ungrounded: 0,
      unrecorded: 0,
    });
  });
});

describe("the switch", () => {
  beforeEach(() => {
    settingsState = { optedOut: false, lastWorkspaceUpdate: null };
  });

  it("lets an admin turn the report on", async () => {
    const res = await request("PATCH", "/coverage/settings", { enabled: true }, asAdmin);
    expect(res.status).toBe(200);
    expect(updated("workspaces")).toMatchObject({ gap_report_enabled: true });
  });

  // This proves the route turns a zero-row UPDATE into a 403 — the fake
  // returns zero rows because `role` told it to, not because any policy ran.
  // Whether `workspaces_update_admin` actually refuses a non-admin is proved
  // against a live database by `tests/rls/coverage-gaps.test.ts`, in its
  // describe block "who may turn the report on".
  it("refuses a member who is not an admin", async () => {
    const res = await request("PATCH", "/coverage/settings", { enabled: true }, asMember);
    expect(res.status).toBe(403);
  });

  it("refuses a body that is not a boolean", async () => {
    const res = await request("PATCH", "/coverage/settings", { enabled: "yes" }, asAdmin);
    expect(res.status).toBe(400);
  });
});

describe("a member's own choice", () => {
  beforeEach(() => {
    settingsState = { optedOut: false, lastWorkspaceUpdate: null };
  });

  it("excludes them, and says so afterwards", async () => {
    expect(
      (await request("PUT", "/coverage/preference", { excluded: true }, asMember)).status,
    ).toBe(200);
    const res = await request("GET", "/coverage/preference", undefined, asMember);
    expect(await res.json()).toEqual({ excluded: true });
  });

  it("takes it back", async () => {
    await request("PUT", "/coverage/preference", { excluded: true }, asMember);
    await request("PUT", "/coverage/preference", { excluded: false }, asMember);
    const res = await request("GET", "/coverage/preference", undefined, asMember);
    expect(await res.json()).toEqual({ excluded: false });
  });

  it("is idempotent, so a double click is not a 409", async () => {
    await request("PUT", "/coverage/preference", { excluded: true }, asMember);
    const again = await request("PUT", "/coverage/preference", { excluded: true }, asMember);
    expect(again.status).toBe(200);
  });

  /**
   * A member does not need to be an admin for this, and must not need the
   * report to be on either — somebody should be able to opt out before it is
   * turned on, not only after.
   */
  it("works while the report is off", async () => {
    const res = await request("PUT", "/coverage/preference", { excluded: true }, asMember);
    expect(res.status).toBe(200);
  });
});
