import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext, ToolEnv } from "../registry";
import { describeConnectionTool, summariseSchema } from "./describe-connection";

/**
 * What the cache is for, stated as a test: the second call must not go to the
 * network. Asking a database for its schema on every turn is a round trip and
 * a page of input tokens, for an answer that changes when somebody runs a
 * migration — which is to say rarely, and never mid-conversation.
 */
const authHeaders = vi.fn(async () => ({ apikey: "k" }));
const cacheConnectionSummary = vi.fn(async (_env: unknown, _c: unknown, _s: string) => {});
vi.mock("../secrets", () => ({
  authHeaders: () => authHeaders(),
  cacheConnectionSummary: (env: unknown, connection: unknown, summary: string) =>
    cacheConnectionSummary(env, connection, summary),
}));

vi.mock("../../routines/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../routines/source")>();
  return { ...actual, resolvesPublicly: async () => {} };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const SQL_CONNECTION = {
  id: "conn-1",
  workspace_id: "ws-1",
  label: "Covan Supabase",
  transport: "sql",
  base_url: "https://proj.supabase.co/rest/v1",
  auth_kind: "static_header",
  allowed_methods: ["GET"],
  config: { rpc: "covan_query" },
};

function ctxWith(row: Record<string, unknown> | null): ToolContext {
  return {
    db: {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
        }),
      }),
    } as unknown as ToolContext["db"],
    env: { ALLOWED_ORIGIN: "https://app.covan.test", ROUTINE_SECRET_KEY: "k" } as ToolEnv,
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  cacheConnectionSummary.mockClear();
  fetchMock.mockResolvedValue(
    new Response(
      JSON.stringify([
        { table_schema: "public", table_name: "orders", column_name: "id", data_type: "uuid" },
        {
          table_schema: "public",
          table_name: "orders",
          column_name: "total",
          data_type: "numeric",
        },
        { table_schema: "billing", table_name: "plans", column_name: "id", data_type: "text" },
      ]),
      { status: 200 },
    ),
  );
});

describe("summariseSchema", () => {
  it("folds a row per column into a line per table", () => {
    expect(
      summariseSchema(
        JSON.stringify([
          { table_schema: "public", table_name: "orders", column_name: "id", data_type: "uuid" },
          { table_schema: "public", table_name: "orders", column_name: "n", data_type: "int" },
        ]),
      ),
    ).toBe("orders(id uuid, n int)");
  });

  it("keeps the schema name on anything outside public", () => {
    expect(
      summariseSchema(
        JSON.stringify([
          { table_schema: "billing", table_name: "plans", column_name: "id", data_type: "text" },
        ]),
      ),
    ).toBe("billing.plans(id text)");
  });

  it("hands back whatever it was given when it cannot read it", () => {
    expect(summariseSchema("not json")).toBe("not json");
  });
});

describe("describe_connection", () => {
  it("asks the database once and writes the answer back", async () => {
    const result = await describeConnectionTool.run(
      { connectionId: "conn-1" },
      ctxWith(SQL_CONNECTION),
    );
    expect(result).toMatchObject({ kind: "ok" });
    expect((result as { content: string }).content).toContain("orders(id uuid, total numeric)");
    expect((result as { content: string }).content).toContain("billing.plans(id text)");
    expect(cacheConnectionSummary).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not go near the network when the answer is already recorded", async () => {
    const result = await describeConnectionTool.run(
      { connectionId: "conn-1" },
      ctxWith({ ...SQL_CONNECTION, config: { rpc: "covan_query", summary: "orders(id uuid)" } }),
    );
    expect((result as { content: string }).content).toContain("orders(id uuid)");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks again when somebody says the recorded answer is wrong", async () => {
    await describeConnectionTool.run(
      { connectionId: "conn-1", refresh: true },
      ctxWith({ ...SQL_CONNECTION, config: { rpc: "covan_query", summary: "stale" } }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache a schema it failed to read", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const result = await describeConnectionTool.run(
      { connectionId: "conn-1" },
      ctxWith(SQL_CONNECTION),
    );
    expect(result).toMatchObject({ kind: "error" });
    expect(cacheConnectionSummary).not.toHaveBeenCalled();
  });

  it("reports what a person recorded about an HTTP API, and fetches nothing", async () => {
    const result = await describeConnectionTool.run(
      { connectionId: "conn-1" },
      ctxWith({
        ...SQL_CONNECTION,
        transport: "http",
        base_url: "https://api.example.com",
        config: { summary: "GET /orders returns the last 100." },
      }),
    );
    expect((result as { content: string }).content).toContain("GET /orders");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("says so plainly when nobody recorded anything about an HTTP API", async () => {
    const result = await describeConnectionTool.run(
      { connectionId: "conn-1" },
      ctxWith({
        ...SQL_CONNECTION,
        transport: "http",
        base_url: "https://api.example.com",
        config: {},
      }),
    );
    expect((result as { content: string }).content).toContain("No description has been recorded");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a connection this workspace cannot see", async () => {
    const result = await describeConnectionTool.run({ connectionId: "conn-1" }, ctxWith(null));
    expect(result).toEqual({ kind: "error", message: "no such connection in this workspace" });
  });
});
