import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { activeWorkspaceTables, fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { estimateCostUsd } from "../lib/pricing";

/**
 * The editor's and the list's numbers (0130): what a run costs, what the
 * week's runs came to, where a run goes after its primary, and a test run.
 * The run itself is stubbed at the dispatcher; `executor.test.ts` holds what
 * a test leaves alone.
 */
const dispatch = vi.hoisted(() => ({ runTestRoutine: vi.fn() }));
vi.mock("../lib/routines/dispatcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/routines/dispatcher")>()),
  runTestRoutine: dispatch.runTestRoutine,
}));

const { routines, costRange, runsInThirtyDays, runningSince, runCostUsd } =
  await import("./routines");

const USER = { id: "user-1", email: "ada@acme.test" };
const WORKSPACE_ID = "workspace-1";
const ROUTINE_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const PRIMARY = "33333333-3333-4333-8333-333333333333";
const EXTRA = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";

/** Credits at a hundred to the dollar, so a price reads back as a whole number. */
const credits = {
  check: async () => ({ allowed: true, balance: 100 }),
  quote: (usd: number) => usd * 100,
};

function appWith(spec: FakeDbSpec = {}, entitlements: unknown = credits) {
  const { db, calls } = fakeDb({
    ...spec,
    tables: { ...activeWorkspaceTables(USER.id, WORKSPACE_ID), ...(spec.tables ?? {}) },
  });
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    c.set("entitlements", entitlements as never);
    await next();
  });
  app.route("/", routines);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(
      path,
      {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      },
      {} as never,
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { call, calls };
}

beforeEach(() => {
  dispatch.runTestRoutine.mockReset();
});

describe("pricing a run", () => {
  it("prices the prompt and completion apart, and an old total as read", () => {
    const split = {
      model: "gpt-4o-mini",
      tokens: 1200,
      prompt_tokens: 1000,
      completion_tokens: 200,
    };
    expect(runCostUsd(split)).toBeCloseTo(estimateCostUsd("gpt-4o-mini", 1000, 200));
    expect(runCostUsd({ model: "gpt-4o-mini", tokens: 1200 })).toBeCloseTo(
      estimateCostUsd("gpt-4o-mini", 1200, 0),
    );
    // Repriced at the model the editor picked.
    expect(runCostUsd(split, "gpt-4.1")).toBeCloseTo(estimateCostUsd("gpt-4.1", 1000, 200));
  });

  it("gives the middle half of four or more runs, and the ends of fewer", () => {
    expect(costRange([])).toBeNull();
    expect(costRange([3, 1])).toEqual({ low: 1, high: 3 });
    expect(costRange([10, 1, 4, 2, 8, 6, 3, 5])).toEqual({ low: 3, high: 8 });
  });

  it("counts a weekly schedule four or five times a month", () => {
    const n = runsInThirtyDays("30 8 * * 1", "Europe/Istanbul", new Date("2026-10-22T00:00:00Z"));
    expect(n).toBeGreaterThanOrEqual(4);
    expect(n).toBeLessThanOrEqual(5);
    expect(runsInThirtyDays("*/5 * * * *", "UTC", new Date("2026-10-22T00:00:00Z"))).toBe(999);
  });
});

describe("what is running", () => {
  const now = Date.parse("2026-10-22T10:00:00Z");
  it("is a fresh claim or a run waiting on the browser, and not a stale claim", () => {
    expect(runningSince({ claimed_at: "2026-10-22T09:50:00Z" }, undefined, now)).toBe(
      Date.parse("2026-10-22T09:50:00Z"),
    );
    expect(runningSince({ claimed_at: "2026-10-22T08:00:00Z" }, undefined, now)).toBeNull();
    expect(runningSince({}, { status: "waiting", started_at: "2026-10-22T09:00:00Z" }, now)).toBe(
      Date.parse("2026-10-22T09:00:00Z"),
    );
    expect(runningSince({}, { status: "ok", started_at: "2026-10-22T09:00:00Z" }, now)).toBeNull();
  });
});

const ROUTINE_ROW = {
  id: ROUTINE_ID,
  agent_id: AGENT_ID,
  user_id: USER.id,
  workspace_id: WORKSPACE_ID,
  name: "Daily support digest",
  visibility: "shared",
  source_kind: "none",
  source_config: {},
  instruction: "Summarise",
  delivery_channel_id: PRIMARY,
  schedule_cron: "0 9 * * *",
  timezone: "UTC",
  status: "paused",
  paused_reason: null,
  paused_by: "user-2",
  paused_at: "2026-10-08T09:00:00Z",
  deliver_inbox: true,
  model: "gpt-4o-mini",
  reasoning_effort: "low",
  channels: [{ delivery_channel_id: EXTRA }],
  claimed_at: null,
  next_run_at: null,
  last_run_at: "2026-10-22T09:00:00Z",
  created_at: "2026-09-01T09:00:00Z",
};

describe("GET /routines", () => {
  it("says who made it, who paused it, its other channels and its last run", async () => {
    const { call } = appWith({
      tables: {
        routines: { select: () => ({ data: [ROUTINE_ROW], error: null }) },
        profiles: {
          select: () => ({
            data: [
              { id: USER.id, name: "Ada" },
              { id: "user-2", name: "Deniz" },
            ],
            error: null,
          }),
        },
      },
      rpc: {
        routine_last_runs: () => ({
          data: [
            {
              routine_id: ROUTINE_ID,
              id: "run-1",
              status: "ok",
              started_at: "2026-10-22T09:00:00Z",
              finished_at: "2026-10-22T09:02:00Z",
              session_id: "session-1",
            },
          ],
          error: null,
        }),
      },
    });
    const res = await call("GET", "/routines");
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({
      ownerName: "Ada",
      pausedBy: "user-2",
      pausedByName: "Deniz",
      deliverInbox: true,
      model: "gpt-4o-mini",
      reasoningEffort: "low",
      channelIds: [EXTRA],
      lastRun: { id: "run-1", status: "ok", sessionId: "session-1" },
      runningSince: null,
    });
  });
});

describe("GET /routines/stats", () => {
  it("adds the window up and prices it in credits", async () => {
    const { call } = appWith({
      rpc: {
        routine_run_totals: () => ({
          data: [
            {
              status: "ok",
              model: "gpt-4o-mini",
              runs: 13,
              prompt_tokens: 1_000_000,
              completion_tokens: 0,
              cached_tokens: 0,
              unsplit_tokens: 0,
            },
            {
              status: "failed",
              model: null,
              runs: 1,
              prompt_tokens: 0,
              completion_tokens: 0,
              cached_tokens: 0,
              unsplit_tokens: 0,
            },
          ],
          error: null,
        }),
      },
    });
    const res = await call("GET", "/routines/stats?days=7");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      days: 7,
      runs: 14,
      done: 13,
      failed: 1,
      skipped: 0,
      cost: Math.round(estimateCostUsd("gpt-4o-mini", 1_000_000, 0) * 100),
      unit: "credits",
    });
  });

  it("speaks dollars where the deployment sells nothing", async () => {
    const { call } = appWith(
      { rpc: { routine_run_totals: () => ({ data: [], error: null }) } },
      { check: credits.check },
    );
    const res = await call("GET", "/routines/stats");
    expect(res.body).toMatchObject({ runs: 0, cost: 0, unit: "usd" });
  });
});

describe("GET /routines/estimate", () => {
  const run = (routineId: string) => ({
    routine_id: routineId,
    model: "gpt-4o-mini",
    tokens: 120_000,
    prompt_tokens: 100_000,
    completion_tokens: 20_000,
    cached_tokens: 0,
  });

  it("is based on the agent's routine with the most delivered runs", async () => {
    const { call } = appWith({
      tables: {
        routines: {
          select: () => ({
            data: [
              { id: ROUTINE_ID, name: "Daily support digest" },
              { id: OTHER, name: "Weekly themes" },
            ],
            error: null,
          }),
        },
        routine_runs: {
          select: () => ({ data: [run(ROUTINE_ID), run(ROUTINE_ID), run(OTHER)], error: null }),
        },
      },
    });
    const res = await call(
      "GET",
      `/routines/estimate?agentId=${AGENT_ID}&cron=${encodeURIComponent("30 8 * * 1")}&timezone=UTC`,
    );
    expect(res.status).toBe(200);
    const each = Math.round(estimateCostUsd("gpt-4o-mini", 100_000, 20_000) * 100);
    expect(res.body).toMatchObject({
      low: Math.max(1, each),
      high: Math.max(1, each),
      unit: "credits",
      basedOn: { kind: "routine", routineId: ROUTINE_ID, name: "Daily support digest" },
    });
    expect(res.body.runsPerMonth).toBeGreaterThanOrEqual(4);
  });

  it("prefers the routine being edited, and falls back to the agent's replies", async () => {
    const { call } = appWith({
      tables: {
        routines: { select: () => ({ data: [], error: null }) },
        messages: {
          select: () => ({
            data: [{ model: "gpt-4o-mini", prompt_tokens: 50_000, completion_tokens: 5_000 }],
            error: null,
          }),
        },
      },
    });
    const res = await call("GET", `/routines/estimate?agentId=${AGENT_ID}`);
    expect(res.body).toMatchObject({ basedOn: { kind: "replies" }, runsPerMonth: null });
    expect(res.body.low).toBeGreaterThanOrEqual(1);
  });

  it("says nothing it cannot back", async () => {
    const { call } = appWith({
      tables: {
        routines: { select: () => ({ data: [], error: null }) },
        messages: { select: () => ({ data: [], error: null }) },
      },
    });
    const res = await call("GET", `/routines/estimate?agentId=${AGENT_ID}`);
    expect(res.body).toEqual({
      low: null,
      high: null,
      unit: "credits",
      runsPerMonth: null,
      basedOn: null,
    });
  });
});

describe("PUT /routines/:id/channels", () => {
  it("adds what is new, takes off what is gone, and never lists the primary", async () => {
    const { call, calls } = appWith({
      tables: {
        routines: {
          select: () => ({
            data: { id: ROUTINE_ID, user_id: USER.id, delivery_channel_id: PRIMARY },
            error: null,
          }),
        },
        routine_channels: {
          select: () => ({ data: [{ delivery_channel_id: EXTRA }], error: null }),
          delete: () => ({ data: null, error: null }),
          insert: () => ({ data: null, error: null }),
        },
      },
    });
    const res = await call("PUT", `/routines/${ROUTINE_ID}/channels`, {
      channelIds: [PRIMARY, OTHER, OTHER],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ channelIds: [OTHER] });
    const writes = calls.filter((x) => x.table === "routine_channels" && x.op !== "select");
    expect(writes.map((w) => w.op)).toEqual(["delete", "insert"]);
  });

  it("is the owner's to change", async () => {
    const { call } = appWith({
      tables: {
        routines: {
          select: () => ({
            data: { id: ROUTINE_ID, user_id: "user-2", delivery_channel_id: PRIMARY },
            error: null,
          }),
        },
      },
    });
    const res = await call("PUT", `/routines/${ROUTINE_ID}/channels`, { channelIds: [] });
    expect(res.status).toBe(403);
  });

  it("names a channel the policy refused", async () => {
    const { call } = appWith({
      tables: {
        routines: {
          select: () => ({
            data: { id: ROUTINE_ID, user_id: USER.id, delivery_channel_id: PRIMARY },
            error: null,
          }),
        },
        routine_channels: {
          select: () => ({ data: [], error: null }),
          insert: () => ({ data: null, error: { message: "denied", code: "42501" } }),
        },
      },
    });
    const res = await call("PUT", `/routines/${ROUTINE_ID}/channels`, { channelIds: [OTHER] });
    expect(res.status).toBe(400);
  });
});

describe("POST /routines/:id/test", () => {
  it("runs a test for the owner and answers with the run it wrote", async () => {
    dispatch.runTestRoutine.mockResolvedValue({
      status: "ok",
      itemsNew: 0,
      summary: "Three themes",
    });
    const { call } = appWith({
      tables: {
        routines: { select: () => ({ data: ROUTINE_ROW, error: null }) },
        routine_runs: {
          select: (ctx) => {
            expect(ctx.filters).toContainEqual({
              column: "triggered_by",
              value: "test",
              kind: "eq",
            });
            return {
              data: {
                id: "run-9",
                status: "ok",
                items_new: 0,
                duration_ms: 900,
                error: null,
                triggered_by: "test",
                session_id: "session-9",
                started_at: "2026-10-22T10:00:00Z",
              },
              error: null,
            };
          },
        },
      },
    });
    const res = await call("POST", `/routines/${ROUTINE_ID}/test`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      summary: "Three themes",
      run: { id: "run-9", triggeredBy: "test", sessionId: "session-9" },
    });
    expect(dispatch.runTestRoutine).toHaveBeenCalledOnce();
  });

  it("is the owner's alone, and refused without credits", async () => {
    const theirs = appWith({
      tables: {
        routines: { select: () => ({ data: { ...ROUTINE_ROW, user_id: "user-2" }, error: null }) },
      },
    });
    expect((await theirs.call("POST", `/routines/${ROUTINE_ID}/test`)).status).toBe(403);

    const broke = appWith(
      { tables: { routines: { select: () => ({ data: ROUTINE_ROW, error: null }) } } },
      { check: async () => ({ allowed: false, balance: 0 }) },
    );
    expect((await broke.call("POST", `/routines/${ROUTINE_ID}/test`)).status).toBe(402);
    expect(dispatch.runTestRoutine).not.toHaveBeenCalled();
  });
});

describe("GET /routines/:id/runs", () => {
  it("prices each run that called a model", async () => {
    const { call } = appWith({
      tables: {
        routine_runs: {
          select: () => ({
            data: [
              {
                id: "run-1",
                status: "ok",
                items_new: 3,
                duration_ms: 1000,
                error: null,
                model: "gpt-4o-mini",
                tokens: 120_000,
                prompt_tokens: 100_000,
                completion_tokens: 20_000,
                session_id: "session-1",
                started_at: "2026-10-22T09:00:00Z",
              },
              {
                id: "run-2",
                status: "skipped",
                items_new: 0,
                duration_ms: 10,
                error: null,
                started_at: "2026-10-21T09:00:00Z",
              },
            ],
            error: null,
          }),
        },
      },
    });
    const res = await call("GET", `/routines/${ROUTINE_ID}/runs`);
    expect(res.body[0]).toMatchObject({
      sessionId: "session-1",
      cost: {
        amount: Math.round(estimateCostUsd("gpt-4o-mini", 100_000, 20_000) * 100),
        unit: "credits",
      },
    });
    expect(res.body[1].cost).toBeNull();
  });
});
