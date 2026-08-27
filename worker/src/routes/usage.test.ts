import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { usage } from "./usage";

const USER_ID = "user-1";
const WORKSPACE_ID = "workspace-1";

type RpcResult = { data: unknown[] | null; error: { code?: string; message?: string } | null };

/**
 * Enough of the request-scoped client for `getActiveWorkspaceId` to resolve and
 * for the two RPCs to answer. Every table read here is one that helper makes.
 */
function fakeDb(rpcs: Record<string, RpcResult>) {
  const calls: string[] = [];
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
    async rpc(name: string) {
      calls.push(name);
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
  app.route("/", usage);
  return app;
}

const AGENT_ROW = {
  agent_id: "agent-1",
  agent_name: "GTM",
  agent_emoji: "📈",
  agent_model: "gpt-4o",
  message_count: 4,
  prompt_tokens: 1000,
  completion_tokens: 500,
  cached_tokens: 0,
  measured_prompt_tokens: 0,
};

describe("GET /usage/workspace", () => {
  it("returns the workspace's own figures, and nothing keyed to a person", async () => {
    const { db, calls } = fakeDb({
      workspace_usage_all: { data: [AGENT_ROW], error: null },
      workspace_usage_monthly: {
        data: [
          {
            month: "2026-08-01",
            message_count: 4,
            prompt_tokens: 1000,
            completion_tokens: 500,
            cached_tokens: 0,
          },
        ],
        error: null,
      },
    });

    const res = await appWithDb(db).request("/usage/workspace");
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.available).toBe(true);
    expect(calls).toContain("workspace_usage_all");
    // The per-caller function is the one that scopes to auth.uid(); reaching
    // for it here would answer a different question than the heading asks.
    expect(calls).not.toContain("workspace_usage");
    expect(JSON.stringify(body)).not.toContain("user_id");
  });

  // 0032 raises 42501 rather than returning no rows, precisely so this can be
  // told apart from a workspace that has never sent a message.
  it("turns the function's own refusal into a 403, not an empty result", async () => {
    const { db } = fakeDb({
      workspace_usage_all: { data: null, error: { code: "42501", message: "not an admin" } },
      workspace_usage_monthly: { data: [], error: null },
    });

    const res = await appWithDb(db).request("/usage/workspace");

    expect(res.status).toBe(403);
  });

  // CI does not apply migrations. Between deploying this and somebody pasting
  // 0032 into the SQL editor, the function genuinely is not there, and that is
  // a deployment state rather than a fault.
  it("reports a missing migration as unavailable rather than as a failure", async () => {
    for (const code of ["PGRST202", "42883"]) {
      const { db } = fakeDb({
        workspace_usage_all: { data: null, error: { code, message: "could not find function" } },
        workspace_usage_monthly: { data: [], error: null },
      });

      const res = await appWithDb(db).request("/usage/workspace");
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(200);
      expect(body.available).toBe(false);
      expect(body.agents).toEqual([]);
    }
  });

  it("still fails loudly on an error that is neither of those", async () => {
    const { db } = fakeDb({
      workspace_usage_all: { data: null, error: { code: "57014", message: "canceling statement" } },
      workspace_usage_monthly: { data: [], error: null },
    });

    const res = await appWithDb(db).request("/usage/workspace");

    expect(res.status).toBe(500);
  });

  it("prices agents but not months, because a reply does not record its model", async () => {
    const { db } = fakeDb({
      workspace_usage_all: { data: [AGENT_ROW], error: null },
      workspace_usage_monthly: {
        data: [
          {
            month: "2026-08-01",
            message_count: 4,
            prompt_tokens: 1000,
            completion_tokens: 500,
            cached_tokens: 0,
          },
        ],
        error: null,
      },
    });

    const res = await appWithDb(db).request("/usage/workspace");
    const body = (await res.json()) as {
      agents: { estCostUsd: number }[];
      months: Record<string, unknown>[];
      totals: { totalTokens: number };
    };

    expect(body.agents[0].estCostUsd).toBeGreaterThan(0);
    expect(body.totals.totalTokens).toBe(1500);
    expect(body.months[0]).not.toHaveProperty("estCostUsd");
    expect(body.months[0].totalTokens).toBe(1500);
  });
});
