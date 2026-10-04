import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { usage } from "./usage";
import { estimateCostUsd } from "../lib/pricing";

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
    // `GET /usage` asks what the caller may still spend before it reads a row.
    // An unmetered install answers `limit: null`, which is what this is.
    c.set("entitlements", {
      snapshot: async () => ({ used: 0, limit: null, resetsAt: null }),
    } as never);
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

  it("prices a month, now that a reply records which model answered it", async () => {
    // This test used to assert the opposite — `not.toHaveProperty("estCostUsd")`
    // — and the reason was real: `messages` recorded no model, so a month could
    // only be priced by assuming every reply in it came from whatever the agent
    // is set to today. `0065` added the column, #206 started writing it, and
    // covan#208 is that nothing read it. Now something does.
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
            by_model: [
              {
                model: "claude-opus-5",
                promptTokens: 1000,
                completionTokens: 500,
                cachedTokens: 0,
                cacheWriteTokens: 0,
              },
            ],
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
    expect(body.months[0].totalTokens).toBe(1500);
    expect(body.months[0].estCostUsd).toBe(estimateCostUsd("claude-opus-5", 1000, 500, 0, 0));
  });
});

/**
 * What a reply cost is a question about the model that answered it.
 *
 * covan#208. `usage.ts` priced every reply with `resolveModel(r.agent_model)` —
 * the agent's model TODAY, joined through `chat_sessions.agent_id` — so an agent
 * whose model changed mid-week moved its whole history onto the new price list.
 * `0065`'s own header names the shape it produces: a gpt-5 agent carrying 19,704
 * `cache_write_tokens`, a number OpenAI does not report.
 *
 * The fix is not optional-with-a-fallback by taste: 361 production rows predate
 * the column, and they can only ever be priced by the agent's model.
 */
describe("pricing by the model that answered", () => {
  const SPLIT_AGENT = {
    ...AGENT_ROW,
    agent_model: "gpt-4.1-mini",
    message_count: 6,
    prompt_tokens: 101000,
    completion_tokens: 10500,
    cached_tokens: 0,
    cache_write_tokens: 0,
    by_model: [
      {
        model: "claude-opus-5",
        promptTokens: 100000,
        completionTokens: 10000,
        cachedTokens: 0,
        cacheWriteTokens: 0,
      },
      {
        model: "gpt-4.1-mini",
        promptTokens: 1000,
        completionTokens: 500,
        cachedTokens: 0,
        cacheWriteTokens: 0,
      },
    ],
  };

  it("sums the models that actually answered, rather than pricing the lot at today's", async () => {
    const { db } = fakeDb({ workspace_usage: { data: [SPLIT_AGENT], error: null } });

    const res = await appWithDb(db).request("/usage");
    const body = (await res.json()) as { agents: { estCostUsd: number; model: string }[] };

    const expected =
      estimateCostUsd("claude-opus-5", 100000, 10000, 0, 0) +
      estimateCostUsd("gpt-4.1-mini", 1000, 500, 0, 0);
    expect(body.agents[0].estCostUsd).toBeCloseTo(expected, 10);
    // And nowhere near what the old reading made of it.
    expect(body.agents[0].estCostUsd).toBeGreaterThan(
      estimateCostUsd("gpt-4.1-mini", 101000, 10500, 0, 0) * 5,
    );
  });

  it("still shows the model the agent is set to, which is not the same question", async () => {
    // What it will answer with next, beside what the answers so far cost. The
    // two disagreeing is the fact, not a glitch to paper over.
    const { db } = fakeDb({ workspace_usage: { data: [SPLIT_AGENT], error: null } });
    const res = await appWithDb(db).request("/usage");
    const body = (await res.json()) as { agents: { model: string }[] };
    expect(body.agents[0].model).toBe("gpt-4.1-mini");
  });

  it("prices a reply that predates the column by the agent's model", async () => {
    // 361 rows in production. A null here is not a missing model, it is a reply
    // written before anything recorded one.
    const { db } = fakeDb({
      workspace_usage: {
        data: [
          {
            ...AGENT_ROW,
            agent_model: "claude-sonnet-5",
            by_model: [
              {
                model: null,
                promptTokens: 1000,
                completionTokens: 500,
                cachedTokens: 0,
                cacheWriteTokens: 0,
              },
            ],
          },
        ],
        error: null,
      },
    });

    const res = await appWithDb(db).request("/usage");
    const body = (await res.json()) as { agents: { estCostUsd: number }[] };
    expect(body.agents[0].estCostUsd).toBe(estimateCostUsd("claude-sonnet-5", 1000, 500, 0, 0));
  });

  it("prices an Anthropic reply at Anthropic's rates", async () => {
    // The second bug in the same expression, and the larger one by money.
    // `resolveModel` was called with no env, so `anthropicEnabled` was false and
    // every Claude id became the OpenAI default before it was priced. In the
    // week to 2026-10-04 that was 64 of 66 turns: Sonnet 5 bills $10/M output
    // against gpt-4.1's $8, Opus 5 bills $25, and a cached Anthropic token is
    // $0.20 against $0.50. The cost column understated every one of them.
    const { db } = fakeDb({
      workspace_usage: {
        data: [
          {
            ...AGENT_ROW,
            agent_model: "claude-opus-5",
            prompt_tokens: 100000,
            completion_tokens: 10000,
            cached_tokens: 80000,
            cache_write_tokens: 0,
            by_model: [
              {
                model: "claude-opus-5",
                promptTokens: 100000,
                completionTokens: 10000,
                cachedTokens: 80000,
                cacheWriteTokens: 0,
              },
            ],
          },
        ],
        error: null,
      },
    });

    const res = await appWithDb(db).request("/usage");
    const body = (await res.json()) as { agents: { estCostUsd: number }[] };

    expect(body.agents[0].estCostUsd).toBeCloseTo(
      estimateCostUsd("claude-opus-5", 100000, 10000, 80000, 0),
      10,
    );
    // And not what it used to say, which was the OpenAI default's price.
    expect(body.agents[0].estCostUsd).not.toBeCloseTo(
      estimateCostUsd("gpt-4.1", 100000, 10000, 80000, 0),
      4,
    );
  });

  it("names the model this deployment will actually answer with", async () => {
    // `resolveModel`'s own rule, which it could not apply without an env: a
    // Claude pick on an install with no Anthropic key answers with the default,
    // and the screen should say so rather than promise Claude.
    const row = { ...AGENT_ROW, agent_model: "claude-opus-5" };
    const withKey = await appWithDb(
      fakeDb({ workspace_usage: { data: [row], error: null } }).db,
    ).request("/usage", undefined, { ANTHROPIC_API_KEY: "sk-ant-test" });
    const withoutKey = await appWithDb(
      fakeDb({ workspace_usage: { data: [row], error: null } }).db,
    ).request("/usage", undefined, {});

    expect(((await withKey.json()) as { agents: { model: string }[] }).agents[0].model).toBe(
      "claude-opus-5",
    );
    expect(((await withoutKey.json()) as { agents: { model: string }[] }).agents[0].model).not.toBe(
      "claude-opus-5",
    );
  });

  it("prices the old way against a database the migration has not reached", async () => {
    // CI never applies migrations, so the API is deployed against a schema
    // without `by_model` for as long as it takes somebody to apply it. The
    // figure degrades to exactly what it was before this change rather than to
    // zero, which would read as "this agent was free".
    const { db } = fakeDb({ workspace_usage: { data: [AGENT_ROW], error: null } });

    const res = await appWithDb(db).request("/usage");
    const body = (await res.json()) as { agents: { estCostUsd: number }[] };
    expect(body.agents[0].estCostUsd).toBe(estimateCostUsd("gpt-4o", 1000, 500, 0, 0));
  });

  it("says nothing about a month it cannot price yet", async () => {
    // Zero would be a claim. An absent field is the truth, and the screen
    // already renders months without a cost.
    const { db } = fakeDb({
      workspace_usage_all: { data: [AGENT_ROW], error: null },
      workspace_usage_monthly: {
        data: [{ month: "2026-08-01", message_count: 0, prompt_tokens: 0, completion_tokens: 0 }],
        error: null,
      },
    });

    const res = await appWithDb(db).request("/usage/workspace");
    const body = (await res.json()) as { months: Record<string, unknown>[] };
    expect(body.months[0]).not.toHaveProperty("estCostUsd");
  });
});
