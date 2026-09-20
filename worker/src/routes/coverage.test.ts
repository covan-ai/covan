import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { coverage } from "./coverage";

const USER_ID = "user-1";
const WORKSPACE_ID = "workspace-1";

type RpcResult = { data: unknown[] | null; error: { code?: string; message?: string } | null };

/**
 * Enough of the request-scoped client for `getActiveWorkspaceId` to resolve and
 * for the two RPCs to answer, plus the arguments each was called with — the
 * window is the one thing this route decides on its own, so the tests have to
 * be able to see what it decided.
 */
function fakeDb(rpcs: Record<string, RpcResult>) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db = {
    from(table: string) {
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
