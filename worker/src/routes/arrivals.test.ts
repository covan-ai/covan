import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import {
  activeWorkspaceTables,
  fakeDb,
  type QueryContext,
  type QueryResult,
} from "../test-support/fake-db";

/**
 * A scan one person owns, through the caller's own client.
 *
 * The engine is stubbed — `scan.test.ts` is its test — and so is the
 * database; whether Postgres hides somebody else's scan is
 * `tests/rls/arrivals.test.ts`. What is under test is the route's half: what
 * it inserts, when it refuses, and that it starts the scan it queued.
 */
const runArrivalScan = vi.fn(async (_env: unknown, _id: string) => {});
vi.mock("../lib/arrivals/scan", () => ({
  runArrivalScan: (env: unknown, id: string) => runArrivalScan(env, id),
}));

const { arrivals } = await import("./arrivals");

const USER = { id: "user-1", email: "ada@acme.test" };
const WS = "ws-1";
const SCAN_ID = "7d1f3c2a-0b4e-4c8e-9a51-3e2f1d0c9b8a";
const ROUTINE_ID = "0c9e8d7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f";

type Row = Record<string, unknown>;

function scanRow(over: Row = {}): Row {
  return {
    id: SCAN_ID,
    workspace_id: WS,
    user_id: USER.id,
    status: "done",
    taxonomy: 1,
    sources: [{ connection_id: "c-1", toolkit: "gmail" }],
    window_days: 30,
    total: 12,
    unanswered: 3,
    error: null,
    started_at: "2026-10-26T09:00:00.000Z",
    finished_at: "2026-10-26T09:00:20.000Z",
    created_at: "2026-10-26T09:00:00.000Z",
    ...over,
  };
}

type Spec = {
  /** What the newest-scan read answers. */
  scans?: Row[];
  connections?: Row[];
  buckets?: Row[];
  insert?: QueryResult;
  update?: QueryResult;
  apiKey?: boolean;
};

function setup(spec: Spec = {}) {
  const { db, callsTo } = fakeDb({
    tables: {
      ...activeWorkspaceTables(USER.id, WS),
      arrival_scans: {
        select: (ctx: QueryContext) => {
          const rows = spec.scans ?? [];
          return { data: ctx.single ? (rows[0] ?? null) : rows, error: null };
        },
        insert: (ctx) =>
          spec.insert ?? {
            data: { ...scanRow({ status: "queued", total: null }), ...ctx.values },
            error: null,
          },
      },
      arrival_buckets: {
        select: () => ({ data: spec.buckets ?? [], error: null }),
        update: () => spec.update ?? { data: [{ kind: "question" }], error: null },
      },
      tool_connections: {
        select: () => ({ data: spec.connections ?? [], error: null }),
      },
    },
  });
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", USER as never);
    if (spec.apiKey) c.set("apiKeyId", "key-1");
    await next();
  });
  app.route("/", arrivals);
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { send, callsTo };
}

beforeEach(() => runArrivalScan.mockClear());

describe("POST /arrivals", () => {
  it("says there is nothing to read when no mailbox or calendar is connected", async () => {
    const { send, callsTo } = setup();
    const res = await send("POST", "/arrivals");
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "no_source" });
    expect(callsTo("arrival_scans").filter((c) => c.op === "insert")).toEqual([]);
  });

  it("asks only for the caller's own active mail and calendar connections", async () => {
    const { send, callsTo } = setup();
    await send("POST", "/arrivals");
    const [read] = callsTo("tool_connections");
    expect(read.filters).toEqual(
      expect.arrayContaining([
        { column: "workspace_id", value: WS, kind: "eq" },
        { column: "created_by", value: USER.id, kind: "eq" },
        { column: "status", value: "active", kind: "eq" },
        { column: "toolkit_slug", value: ["gmail", "outlook", "googlecalendar"], kind: "in" },
      ]),
    );
  });

  it("queues a scan of every connection it found and starts it", async () => {
    const { send, callsTo } = setup({
      connections: [
        { id: "c-1", toolkit_slug: "gmail" },
        { id: "c-2", toolkit_slug: "googlecalendar" },
      ],
    });
    const res = await send("POST", "/arrivals");
    expect(res.status).toBe(201);
    const [insert] = callsTo("arrival_scans").filter((c) => c.op === "insert");
    expect(insert.values).toEqual({
      workspace_id: WS,
      user_id: USER.id,
      sources: [
        { connection_id: "c-1", toolkit: "gmail" },
        { connection_id: "c-2", toolkit: "googlecalendar" },
      ],
      taxonomy: 1,
      window_days: 30,
    });
    const { scan } = (await res.json()) as { scan: Row };
    expect(scan).toMatchObject({ id: SCAN_ID, status: "queued", buckets: [] });
    expect(runArrivalScan).toHaveBeenCalledTimes(1);
    expect(runArrivalScan.mock.calls[0][1]).toBe(SCAN_ID);
  });

  it("answers with the scan already under way rather than starting a second", async () => {
    const { send, callsTo } = setup({
      scans: [scanRow({ status: "running", total: null })],
      connections: [{ id: "c-1", toolkit_slug: "gmail" }],
    });
    const res = await send("POST", "/arrivals");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scan: Row }).scan.status).toBe("running");
    expect(callsTo("arrival_scans").filter((c) => c.op === "insert")).toEqual([]);
    expect(runArrivalScan).not.toHaveBeenCalled();
  });

  it("is refused to an API key", async () => {
    const { send } = setup({ apiKey: true, connections: [{ id: "c-1", toolkit_slug: "gmail" }] });
    const res = await send("POST", "/arrivals");
    expect(res.status).toBe(403);
    expect(runArrivalScan).not.toHaveBeenCalled();
  });
});

describe("GET /arrivals/latest", () => {
  it("answers the newest scan with its buckets, in camelCase", async () => {
    const { send } = setup({
      scans: [scanRow()],
      buckets: [
        {
          kind: "question",
          label: "Order questions",
          count: 7,
          unanswered: 3,
          examples: ["Is the spring order still on?"],
          template_id: "arrivals-questions",
          routine_id: null,
        },
      ],
    });
    const res = await send("GET", "/arrivals/latest");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scan: Row }).scan).toEqual({
      id: SCAN_ID,
      workspaceId: WS,
      userId: USER.id,
      status: "done",
      taxonomy: 1,
      sources: [{ connectionId: "c-1", toolkit: "gmail" }],
      windowDays: 30,
      total: 12,
      unanswered: 3,
      error: null,
      startedAt: "2026-10-26T09:00:00.000Z",
      finishedAt: "2026-10-26T09:00:20.000Z",
      createdAt: "2026-10-26T09:00:00.000Z",
      buckets: [
        {
          kind: "question",
          label: "Order questions",
          count: 7,
          unanswered: 3,
          examples: ["Is the spring order still on?"],
          templateId: "arrivals-questions",
          routineId: null,
        },
      ],
    });
  });

  it("answers 404 when there has never been one", async () => {
    const { send } = setup();
    expect((await send("GET", "/arrivals/latest")).status).toBe(404);
  });
});

describe("GET /arrivals/:id", () => {
  it("answers 404 for a scan the caller cannot see", async () => {
    const { send } = setup();
    expect((await send("GET", `/arrivals/${SCAN_ID}`)).status).toBe(404);
  });

  it("answers 404 for an id that is not one", async () => {
    const { send } = setup({ scans: [scanRow()] });
    expect((await send("GET", "/arrivals/not-a-uuid")).status).toBe(404);
  });
});

describe("PATCH /arrivals/:id/buckets/:kind", () => {
  it("records the routine made from a bucket", async () => {
    const { send, callsTo } = setup();
    const res = await send("PATCH", `/arrivals/${SCAN_ID}/buckets/question`, {
      routineId: ROUTINE_ID,
    });
    expect(res.status).toBe(200);
    const [update] = callsTo("arrival_buckets").filter((c) => c.op === "update");
    expect(update.values).toEqual({ routine_id: ROUTINE_ID });
    expect(update.filters).toEqual(
      expect.arrayContaining([
        { column: "scan_id", value: SCAN_ID, kind: "eq" },
        { column: "kind", value: "question", kind: "eq" },
      ]),
    );
  });

  it("answers 404 when no bucket of the caller's was changed", async () => {
    const { send } = setup({ update: { data: [], error: null } });
    const res = await send("PATCH", `/arrivals/${SCAN_ID}/buckets/question`, {
      routineId: ROUTINE_ID,
    });
    expect(res.status).toBe(404);
  });

  it("refuses a kind that does not exist", async () => {
    const { send } = setup();
    const res = await send("PATCH", `/arrivals/${SCAN_ID}/buckets/spam`, { routineId: ROUTINE_ID });
    expect(res.status).toBe(400);
  });

  it("is refused to an API key", async () => {
    const { send } = setup({ apiKey: true });
    const res = await send("PATCH", `/arrivals/${SCAN_ID}/buckets/question`, {
      routineId: ROUTINE_ID,
    });
    expect(res.status).toBe(403);
  });
});
