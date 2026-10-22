import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { activeWorkspaceTables, fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { agentsNow, home, lastDays, shapeActivity, shapeSpend } from "./home";
import type { InboxItemDTO } from "./inbox";

/**
 * Home's one read. Who may see each figure is decided by the functions it
 * calls (0122–0124, held in tests/rls/home.test.ts); this holds what the route
 * makes of them — the agents' "working on", the spend priced and bucketed, the
 * feed folded — and that a member gets no money and no people.
 */

const USER = { id: "11111111-1111-4111-8111-111111111111", email: "mina@acme.test" };
const WS = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-22T12:00:00Z");

const item = (over: Partial<InboxItemDTO> = {}): InboxItemDTO => ({
  sessionId: "s1",
  agentId: "research",
  title: "Weekly competitor brief",
  kind: "chat",
  visibility: "private",
  ownerId: USER.id,
  ownerName: "Mina",
  sharedBy: null,
  preview: null,
  unread: false,
  unreadCount: 0,
  needsYou: null,
  running: null,
  lastActivityAt: 1,
  ...over,
});

describe("agentsNow", () => {
  const agents = [
    { id: "research", name: "Research", avatar: "owl", created_at: "" },
    { id: "support", name: "Support", avatar: null, created_at: "" },
    { id: "finance", name: "Finance", avatar: "bear", created_at: "" },
    { id: "sales", name: "Sales ops", avatar: "fox", created_at: "" },
  ];

  it("puts a running turn first, then what waits on you, then a routine mid-run, then the last thing", () => {
    const running = item({
      running: { stepsDone: 3, lastTool: "read_pages", note: "Reading 6 pages", since: 5 },
    });
    const asked = item({
      sessionId: "s2",
      agentId: "support",
      title: "Refund policy for EU orders",
      needsYou: { kind: "question", summary: "Draft it?", since: 7 },
    });
    const last = item({ sessionId: "s3", agentId: "finance", title: "Invoice mismatch" });

    const out = agentsNow(
      agents,
      [running, asked, last],
      [asked],
      [{ agent_id: "sales", name: "Pipeline snapshot", claimed_at: "2026-10-22T11:50:00Z" }],
      new Map([["research", 11]]),
      null,
      NOW.getTime(),
    );

    expect(out.map((a) => [a.name, a.status, a.workingOn?.kind, a.workingOn?.title])).toEqual([
      ["Research", "running", "running", "Weekly competitor brief"],
      ["Support", "needs_you", "question", "Refund policy for EU orders"],
      ["Finance", "idle", "last", "Invoice mismatch"],
      ["Sales ops", "running", "running", "Pipeline snapshot"],
    ]);
    expect(out[0]).toMatchObject({ avatar: "owl", threadsWindow: 11, workingOn: { stepsDone: 3 } });
    expect(out[1]!.avatar).toBeNull();
    // No spend for anybody who may not see money.
    expect("spendWindow" in out[0]!).toBe(false);
  });

  it("does not count a routine claimed long ago as running", () => {
    const [sales] = agentsNow(
      [{ id: "sales", name: "Sales ops", avatar: null, created_at: "" }],
      [],
      [],
      [{ agent_id: "sales", name: "Pipeline snapshot", claimed_at: "2026-10-22T10:00:00Z" }],
      new Map(),
      null,
      NOW.getTime(),
    );
    expect(sales!.status).toBe("idle");
    expect(sales!.workingOn).toBeNull();
  });
});

describe("shapeSpend", () => {
  it("prices each day per agent, fills the quiet days, and splits this week from the last", () => {
    const rows = [
      {
        day: "2026-10-22",
        agent_id: "research",
        model: "gpt-4.1",
        prompt_tokens: 1_000_000,
        completion_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
      {
        day: "2026-10-10",
        agent_id: "support",
        model: "gpt-4.1",
        prompt_tokens: 500_000,
        completion_tokens: 0,
        cached_tokens: 0,
        cache_write_tokens: 0,
      },
    ];
    const out = shapeSpend(rows, (usd) => usd * 400, 7, NOW);

    expect(out.unit).toBe("credits");
    expect(out.daily).toHaveLength(14);
    expect(out.daily[0]!.day).toBe("2026-10-09");
    expect(out.daily.at(-1)!.day).toBe("2026-10-22");
    expect(out.daily.at(-1)!.byAgent.research).toBeGreaterThan(0);
    expect(out.window).toBe(out.daily.at(-1)!.total);
    expect(out.previousWindow).toBeGreaterThan(0);
    expect(out.byAgent.map((a) => a.agentId)).toEqual(["research"]);
  });

  it("answers in dollars where nothing can quote credits", () => {
    expect(shapeSpend([], null, 7, NOW).unit).toBe("usd");
  });

  it("names the fourteen days ending today", () => {
    expect(lastDays(3, NOW)).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
  });
});

describe("shapeActivity", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "e1",
    action: "document.added",
    actor_id: "elif",
    actor_name: "Elif",
    actor_avatar: null,
    agent_id: null,
    agent_name: null,
    agent_avatar: null,
    subject_type: "document",
    subject_id: "d1",
    subject_label: "a.pdf",
    detail: { bundle_id: "b1", bundle_name: "Contracts" },
    created_at: "2026-10-22T07:00:00Z",
    ...over,
  });

  it("folds files one person added to one folder within the hour into one row", () => {
    const out = shapeActivity([
      row({ id: "e1", created_at: "2026-10-22T07:30:00Z" }),
      row({ id: "e2", created_at: "2026-10-22T07:20:00Z" }),
      row({ id: "e3", created_at: "2026-10-22T07:10:00Z" }),
      row({ id: "e4", detail: { bundle_id: "b2" }, created_at: "2026-10-22T07:05:00Z" }),
    ]);
    expect(out.map((e) => [e.id, e.count])).toEqual([
      ["e1", 3],
      ["e4", 1],
    ]);
    expect(out[0]!.actor).toEqual({ kind: "person", id: "elif", name: "Elif", avatar: null });
  });

  it("makes the agent the actor of its routine's run", () => {
    const [run] = shapeActivity([
      row({
        action: "routine.run_finished",
        actor_id: null,
        actor_name: null,
        agent_id: "support",
        agent_name: "Support",
        agent_avatar: "headset",
        subject_type: "routine",
        subject_label: "Daily support digest",
      }),
    ]);
    expect(run!.actor).toEqual({
      kind: "agent",
      id: "support",
      name: "Support",
      avatar: "headset",
    });
  });
});

describe("GET /home/overview", () => {
  function appWith(role: "admin" | "member") {
    const spec: FakeDbSpec = {
      tables: {
        ...activeWorkspaceTables(USER.id, WS),
        profiles: {
          select: (ctx) =>
            ctx.columns?.includes("timezone")
              ? { data: { name: "Mina Kaya", timezone: "Europe/Istanbul" }, error: null }
              : { data: { active_workspace_id: WS }, error: null },
        },
        workspace_members: {
          select: (ctx) =>
            ctx.columns === "role"
              ? { data: { role }, error: null }
              : { data: { workspace_id: WS }, error: null },
        },
        workspaces: { select: () => ({ data: { name: "Acme" }, error: null }) },
        agents: {
          select: () => ({
            data: [{ id: "research", name: "Research", avatar: "owl", created_at: "" }],
            error: null,
          }),
        },
        routines: { select: () => ({ data: [], error: null }) },
      },
      rpc: {
        home_counts: () => ({
          data: [
            {
              threads_window: 48,
              threads_previous: 36,
              runs_total: 14,
              runs_done: 13,
              runs_failed: 1,
            },
          ],
          error: null,
        }),
        home_agent_threads: () => ({ data: [{ agent_id: "research", threads: 11 }], error: null }),
        inbox_rows: () => ({ data: [], error: null }),
        workspace_activity: () => ({ data: [], error: null }),
        workspace_spend_daily: () =>
          role === "admin"
            ? { data: [], error: null }
            : { data: null, error: { code: "42501", message: "admins only" } },
        workspace_threads_by_member: () =>
          role === "admin"
            ? {
                data: [{ user_id: USER.id, name: "Mina Kaya", avatar_url: null, threads: 14 }],
                error: null,
              }
            : { data: null, error: { code: "42501", message: "admins only" } },
      },
    };
    const { db } = fakeDb(spec);
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("user", USER as never);
      c.set("db", db as never);
      c.set("entitlements", { snapshot: async () => ({ metered: false }) } as never);
      await next();
    });
    app.route("/", home);
    return app;
  }

  it("gives an admin the money and the people", async () => {
    const body = (await (await appWith("admin").request("/home/overview")).json()) as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      user: { name: "Mina Kaya", timezone: "Europe/Istanbul" },
      workspace: { name: "Acme" },
      isAdmin: true,
      threads: { window: 48, previous: 36 },
      routineRuns: { total: 14, done: 13, failed: 1 },
      team: [{ userId: USER.id, threads: 14 }],
    });
    expect(body.spend).toMatchObject({ unit: "usd", window: 0 });
    expect(body.credits).toBeUndefined();
  });

  it("gives a member neither", async () => {
    const body = (await (await appWith("member").request("/home/overview")).json()) as Record<
      string,
      unknown
    >;
    expect(body.isAdmin).toBe(false);
    expect(body.spend).toBeUndefined();
    expect(body.team).toBeUndefined();
    expect(body.agents).toEqual([
      expect.objectContaining({ name: "Research", threadsWindow: 11, status: "idle" }),
    ]);
  });
});
