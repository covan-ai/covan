import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { usage } from "./usage";
import { estimateCostUsd } from "../lib/pricing";
import {
  activeWorkspaceTables,
  fakeDb as strictDb,
  type QueryContext,
  type TableHandlers,
} from "../test-support/fake-db";

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

function appWithDb(
  db: unknown,
  snapshot: () => Promise<unknown> = async () => ({ metered: false }),
  quote?: (usd: number) => number,
) {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: USER_ID, email: "a@example.com" } as never);
    c.set("db", db as never);
    // `GET /usage` asks what the workspace has left. An unmetered install
    // answers `metered: false`, which is the default here, and quotes nothing.
    c.set("entitlements", { snapshot, ...(quote ? { quote } : {}) } as never);
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
    // 183 of production's 254 assistant replies. A null here is not a missing
    // model, it is a reply written before anything recorded one.
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

const METERED = {
  metered: true,
  balance: 412.5,
  granted: 500,
  spent: 87.5,
  unlimited: false,
  replies: 40,
};

describe("GET /usage credits", () => {
  it("reports nothing to show on an unmetered install", async () => {
    const { db } = fakeDb({});
    const res = await appWithDb(db).request("/usage");
    expect(((await res.json()) as { credits: unknown }).credits).toEqual({ metered: false });
  });

  it("reports the active workspace's balance on a metered one", async () => {
    const { db } = fakeDb({});
    let asked: string | undefined;
    const app = appWithDb(db, async (...args: unknown[]) => {
      asked = args[0] as string;
      return METERED;
    });
    const res = await app.request("/usage");
    expect(((await res.json()) as { credits: unknown }).credits).toEqual(METERED);
    expect(asked).toBe(WORKSPACE_ID);
  });

  it("shows nothing rather than a zero when the balance cannot be read", async () => {
    const { db } = fakeDb({});
    const app = appWithDb(db, async () => {
      throw new Error("ledger down");
    });
    const res = await app.request("/usage");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { credits: unknown }).credits).toEqual({ metered: false });
  });
});

describe("GET /usage/credits/ledger", () => {
  const ROW = {
    id: 7,
    created_at: "2026-10-12T10:00:00Z",
    kind: "completion",
    model: "claude-sonnet-5",
    purpose: "reply",
    delta_micro: -2_500_000,
    balance_after: 497_500_000,
    note: null,
    session_id: null,
    routine_run_id: null,
  };

  /** The ledger and the rows a charge is described by, every read recorded. */
  function ledgerDb(rows: unknown[], extra: Record<string, unknown[]> = {}) {
    const reads: QueryContext[] = [];
    const table = (name: string) => ({
      select: (ctx: QueryContext) => {
        reads.push(ctx);
        if (name !== "credit_ledger") return { data: extra[name] ?? [], error: null };
        const before = ctx.filters.find((f) => f.kind === "lt")?.value as number | undefined;
        const kept = (rows as Array<{ id: number }>).filter((r) => !before || r.id < before);
        return { data: kept.slice(0, ctx.limit), error: null };
      },
    });
    const active = activeWorkspaceTables(USER_ID, WORKSPACE_ID);
    const tables: Record<string, TableHandlers> = {
      ...active,
      ...Object.fromEntries(
        ["credit_ledger", "chat_sessions", "routine_runs", "routines", "agents"].map((n) => [
          n,
          table(n),
        ]),
      ),
      // One table, two reads: the active workspace (single) and the names.
      profiles: {
        select: (ctx) => (ctx.single ? active.profiles.select() : table("profiles").select(ctx)),
      },
    };
    const { db } = strictDb({ tables });
    return { db, reads };
  }

  it("answers an empty list on an unmetered install without reading anything", async () => {
    const { db, reads } = ledgerDb([]);
    const res = await appWithDb(db).request("/usage/credits/ledger");
    expect(await res.json()).toEqual({ entries: [], hasMore: false });
    expect(reads.filter((r) => r.table === "credit_ledger")).toEqual([]);
  });

  it("returns the rows in credits, and never asks who caused them", async () => {
    const { db, reads } = ledgerDb([ROW]);
    const res = await appWithDb(db, async () => METERED).request("/usage/credits/ledger");
    expect(await res.json()).toEqual({
      entries: [
        {
          id: 7,
          at: "2026-10-12T10:00:00Z",
          kind: "completion",
          model: "claude-sonnet-5",
          purpose: "reply",
          credits: -2.5,
          balanceAfter: 497.5,
          note: null,
          sessionId: null,
        },
      ],
      hasMore: false,
    });
    // `user_id` is withheld by its column grant (cloud 0002); asking would fail.
    expect(reads.find((r) => r.table === "credit_ledger")?.columns).not.toMatch(/user_id/);
  });

  it("names the thread, its agent and who started it, and a routine's charge as the routine's", async () => {
    const { db } = ledgerDb(
      [
        { ...ROW, id: 9, session_id: "s1" },
        { ...ROW, id: 8, routine_run_id: "run-1" },
        { ...ROW, id: 7, session_id: "s-private" },
      ],
      {
        chat_sessions: [
          {
            id: "s1",
            title: "Refund for order 1042",
            agent_id: "a1",
            user_id: "u1",
            routine_id: null,
          },
        ],
        routine_runs: [{ id: "run-1", routine_id: "r1" }],
        routines: [{ id: "r1", name: "Weekly competitor brief", agent_id: "a2" }],
        agents: [
          { id: "a1", name: "Support", avatar: "headset" },
          { id: "a2", name: "Research", avatar: "owl" },
        ],
        profiles: [{ id: "u1", name: "Mina Kaya" }],
      },
    );
    const res = await appWithDb(db, async () => METERED).request("/usage/credits/ledger");
    const { entries } = (await res.json()) as { entries: Array<Record<string, unknown>> };

    expect(entries[0]).toMatchObject({
      sessionTitle: "Refund for order 1042",
      agentName: "Support",
      by: { kind: "person", name: "Mina Kaya" },
    });
    expect(entries[1]).toMatchObject({
      routineId: "r1",
      routineName: "Weekly competitor brief",
      agentName: "Research",
      by: { kind: "routine" },
    });
    // A thread the admin's policies hide stays unnamed; its amount stays.
    expect(entries[2]).not.toHaveProperty("sessionTitle");
    expect(entries[2]).not.toHaveProperty("by");
    expect(entries[2].credits).toBe(-2.5);
  });

  it("pages by id and says whether there is more", async () => {
    const rows = [5, 4, 3, 2, 1].map((id) => ({ ...ROW, id }));
    const { db } = ledgerDb(rows);
    const app = appWithDb(db, async () => METERED);

    const first = (await (await app.request("/usage/credits/ledger?limit=2")).json()) as {
      entries: Array<{ id: number }>;
      hasMore: boolean;
    };
    expect(first.entries.map((e) => e.id)).toEqual([5, 4]);
    expect(first.hasMore).toBe(true);

    const last = (await (await app.request("/usage/credits/ledger?limit=2&before=2")).json()) as {
      entries: Array<{ id: number }>;
      hasMore: boolean;
    };
    expect(last.entries.map((e) => e.id)).toEqual([1]);
    expect(last.hasMore).toBe(false);
  });

  it("exports CSV with the thread's title and nothing a spreadsheet would run", async () => {
    const { db } = ledgerDb([{ ...ROW, session_id: "s1" }], {
      chat_sessions: [
        { id: "s1", title: "=HYPERLINK(1)", agent_id: "a1", user_id: "u1", routine_id: null },
      ],
      agents: [{ id: "a1", name: "Support", avatar: null }],
      profiles: [{ id: "u1", name: "Mina Kaya" }],
    });
    const res = await appWithDb(db, async () => METERED).request(
      "/usage/credits/ledger?format=csv",
    );
    expect(res.headers.get("Content-Type")).toMatch(/text\/csv/);
    expect(res.headers.get("Content-Disposition")).toMatch(/attachment; filename="covan-credits-/);
    const text = await res.text();
    expect(text.split("\r\n")[0]).toBe(
      "When,Kind,Purpose,Entry,Agent,By,Model,Credits,Balance after",
    );
    expect(text).toContain("'=HYPERLINK(1),Support,Mina Kaya,claude-sonnet-5,-2.5,497.5");
  });

  it("has no CSV where there is no ledger", async () => {
    const { db } = ledgerDb([]);
    const res = await appWithDb(db).request("/usage/credits/ledger?format=csv");
    expect(res.status).toBe(404);
  });
});

describe("GET /usage/credits/month", () => {
  function monthDb(rows: unknown[] | { code: string; message: string }) {
    const { db } = strictDb({
      tables: {
        ...activeWorkspaceTables(USER_ID, WORKSPACE_ID),
        agents: {
          select: () => ({
            data: [
              { id: "a1", name: "Support", avatar: "headset" },
              { id: "a2", name: "Research", avatar: "owl" },
            ],
            error: null,
          }),
        },
      },
      rpc: {
        workspace_spend_daily: () =>
          Array.isArray(rows) ? { data: rows, error: null } : { data: null, error: rows },
      },
    });
    return db;
  }
  const spend = (day: string, agent: string, prompt: number) => ({
    day,
    agent_id: agent,
    model: "gpt-4o",
    prompt_tokens: prompt,
    completion_tokens: 0,
    cached_tokens: 0,
    cache_write_tokens: 0,
  });

  it("sums this month by agent, largest first, and leaves last month out", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-22T12:00:00Z"), toFake: ["Date"] });
    try {
      const db = monthDb([
        spend("2026-09-30", "a1", 9_000_000),
        spend("2026-10-02", "a1", 1_000_000),
        spend("2026-10-21", "a2", 2_000_000),
      ]);
      const res = await appWithDb(
        db,
        async () => METERED,
        (usd) => usd * 100,
      ).request("/usage/credits/month");
      const body = (await res.json()) as {
        unit: string;
        since: string;
        spent: number;
        byAgent: Array<{ agentId: string; name: string; amount: number }>;
      };
      expect(body.unit).toBe("credits");
      expect(body.since).toBe("2026-10-01");
      expect(body.byAgent.map((a) => a.name)).toEqual(["Research", "Support"]);
      expect(body.byAgent[0].amount).toBe(body.byAgent[1].amount * 2);
      expect(body.spent).toBe(body.byAgent[0].amount + body.byAgent[1].amount);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is an admin's: the function's refusal is a 403", async () => {
    const db = monthDb({ code: "42501", message: "admins only" });
    const res = await appWithDb(db).request("/usage/credits/month");
    expect(res.status).toBe(403);
  });
});

describe("the same estimate in credits, where there are credits", () => {
  const MONTH = {
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
  };
  const metered = async () => ({
    metered: true,
    balance: 400,
    granted: 500,
    spent: 100,
    unlimited: false,
    replies: 12,
  });
  const quote = (usd: number) => usd * 1200;

  it("puts estCredits beside estCostUsd on agents, totals and months when the entitlements quote", async () => {
    const { db } = fakeDb({
      workspace_usage: { data: [AGENT_ROW], error: null },
      workspace_usage_all: { data: [AGENT_ROW], error: null },
      workspace_usage_monthly: { data: [MONTH], error: null },
    });
    const app = appWithDb(db, metered, quote);

    const mine = (await (await app.request("/usage")).json()) as {
      agents: { estCostUsd: number; estCredits: number }[];
      totals: { estCostUsd: number; estCredits: number };
    };
    expect(mine.agents[0].estCredits).toBeCloseTo(mine.agents[0].estCostUsd * 1200, 10);
    expect(mine.totals.estCredits).toBeCloseTo(mine.totals.estCostUsd * 1200, 10);

    const all = (await (await app.request("/usage/workspace")).json()) as {
      months: { estCostUsd: number; estCredits: number }[];
    };
    expect(all.months[0].estCredits).toBeCloseTo(all.months[0].estCostUsd * 1200, 10);
  });

  it("sends no credits figure at all where nothing can quote one", async () => {
    // A self-hosted install: dollars are the only unit it has, and a credits
    // field it invented would be a claim about a price book it does not own.
    const { db } = fakeDb({
      workspace_usage: { data: [AGENT_ROW], error: null },
      workspace_usage_all: { data: [AGENT_ROW], error: null },
      workspace_usage_monthly: { data: [MONTH], error: null },
    });
    const app = appWithDb(db);

    const mine = (await (await app.request("/usage")).json()) as Record<string, unknown>;
    expect((mine.agents as Record<string, unknown>[])[0]).not.toHaveProperty("estCredits");
    expect(mine.totals).not.toHaveProperty("estCredits");

    const all = (await (await app.request("/usage/workspace")).json()) as Record<string, unknown>;
    expect((all.months as Record<string, unknown>[])[0]).not.toHaveProperty("estCredits");
  });
});
