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
const cacheConnectionSummary = vi.fn(
  async (_env: unknown, _c: unknown, _s: string, _v: number) => {},
);
vi.mock("../secrets", () => ({
  authHeaders: () => authHeaders(),
  cacheConnectionSummary: (env: unknown, connection: unknown, summary: string, version: number) =>
    cacheConnectionSummary(env, connection, summary, version),
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

  it("puts public tables first and leaves Supabase's own schemas out", () => {
    // Every call against the founder's Supabase connection came back 12,054
    // characters starting at `auth.audit_log_entries`: the query ordered by
    // table_schema, so the 1,000-row limit and the 12,000-char cap were spent
    // before `public`. On 2026-09-25 at 12:44:55 the agent answered "the
    // messages table isn't visible; which table holds agent messages?"
    expect(
      summariseSchema(
        JSON.stringify([
          { table_schema: "auth", table_name: "users", column_name: "id", data_type: "uuid" },
          { table_schema: "public", table_name: "messages", column_name: "id", data_type: "uuid" },
          { table_schema: "sales", table_name: "deals", column_name: "id", data_type: "uuid" },
        ]),
        { qualify: true },
      ).split("\n"),
      // `sales` stays: the exclusion is Supabase's own schema names, not
      // "everything but public". An application that keeps its tables outside
      // public is describing its own tables.
    ).toEqual(["public.messages(id uuid)", "sales.deals(id uuid)"]);
  });

  it("lists the first forty columns of a wide table and counts the rest", () => {
    const rows = Array.from({ length: 52 }, (_, i) => ({
      table_schema: "public",
      table_name: "orders",
      column_name: `c${i}`,
      data_type: "text",
    }));
    const out = summariseSchema(JSON.stringify(rows));
    expect(out).toMatch(/^orders\(c0 text, .*c39 text, … 12 more columns\)$/);
  });

  it("hands back whatever it was given when it cannot read it", () => {
    expect(summariseSchema("not json")).toBe("not json");
  });

  // Supabase's read-only endpoint refuses a reference that names no schema, so
  // a summary that drops `public.` would be teaching the model to write the
  // one statement that connection cannot run.
  it("keeps public on every table when the carrier insists on it", () => {
    expect(
      summariseSchema(
        JSON.stringify([
          { table_schema: "public", table_name: "orders", column_name: "id", data_type: "uuid" },
        ]),
        { qualify: true },
      ),
    ).toBe("public.orders(id uuid)");
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

  it("answers a second describe of the same connection in one turn from memory", async () => {
    // Nothing about a schema changes inside one turn, and the model asks again
    // anyway — the same reason `find_tool` has a memo.
    const ctx = { ...ctxWith(SQL_CONNECTION), describeMemo: new Map<string, string>() };
    const first = await describeConnectionTool.run({ connectionId: "conn-1" }, ctx);
    const second = await describeConnectionTool.run({ connectionId: "conn-1" }, ctx);
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not serve the pre-refresh answer after a refresh corrected it", async () => {
    // Keyed on the flag, the two answers sat side by side: describe, then
    // describe with refresh, then describe again handed back the text the
    // refresh had just replaced — inside the same turn.
    const ctx = { ...ctxWith(SQL_CONNECTION), describeMemo: new Map<string, string>() };
    await describeConnectionTool.run({ connectionId: "conn-1" }, ctx);
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify([
          { table_schema: "public", table_name: "invoices", column_name: "id", data_type: "uuid" },
        ]),
        { status: 200 },
      ),
    );
    const refreshed = await describeConnectionTool.run(
      { connectionId: "conn-1", refresh: true },
      ctx,
    );
    const third = await describeConnectionTool.run({ connectionId: "conn-1" }, ctx);
    expect(third).toEqual(refreshed);
    expect((third as { content: string }).content).toContain("invoices");
  });

  it("does not go near the network when the answer is already recorded", async () => {
    const result = await describeConnectionTool.run(
      { connectionId: "conn-1" },
      ctxWith({
        ...SQL_CONNECTION,
        config: { rpc: "covan_query", summary: "orders(id uuid)", summary_version: 2 },
      }),
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

  it("refetches a schema summary an older build wrote, once", async () => {
    // Every connection ever described carries a `config.summary` rendered by
    // the build that cut off at `auth.audit_log_entries`. Without a version
    // beside it, that answer is served forever and the fix never reaches the
    // connections it was written for.
    const result = await describeConnectionTool.run(
      { connectionId: "conn-1" },
      ctxWith({
        ...SQL_CONNECTION,
        // `summary_cached_at` and no version: written by an older build of
        // this tool, rather than typed by a person.
        config: {
          rpc: "covan_query",
          summary: "auth.users(id uuid)",
          summary_cached_at: "2026-09-01T00:00:00Z",
        },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((result as { content: string }).content).toContain("orders(id uuid, total numeric)");
    expect(cacheConnectionSummary).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.any(String),
      2,
    );
  });

  it("keeps a description a person wrote about a DATABASE, and does not overwrite it", async () => {
    // The Add-connection form offers "What it holds (optional)" for SQL
    // connections too, and writes it to the same `config.summary`. Keying
    // staleness on the transport treats that text as an old rendering: the
    // tool queries information_schema and writes the generated listing over it
    // through the service client, so a team's own words are gone from the
    // database and from the Integrations page with nobody having asked for a
    // refresh. `summary_cached_at` is what tells the two apart — only
    // `cacheConnectionSummary` writes it.
    const theirs = "Our reporting warehouse. Facts in reporting.*, dimensions in dim.*.";
    const result = await describeConnectionTool.run(
      { connectionId: "conn-1" },
      ctxWith({ ...SQL_CONNECTION, config: { rpc: "covan_query", summary: theirs } }),
    );
    expect((result as { content: string }).content).toContain("reporting warehouse");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cacheConnectionSummary).not.toHaveBeenCalled();
  });

  it("keeps a description a person wrote, which no rendering change makes stale", async () => {
    // The version is about what THIS tool renders. An HTTP connection's
    // summary is the team's own text about their own API, and discarding it
    // would answer "no description has been recorded" in its place.
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

  // The one thing a schema listing cannot teach by example is what to do when
  // the listing is already cached and the model is reading it cold.
  it("tells the model that a Supabase project wants schema-qualified names", async () => {
    const result = await describeConnectionTool.run(
      { connectionId: "conn-2" },
      ctxWith({
        ...SQL_CONNECTION,
        id: "conn-2",
        transport: "supabase",
        base_url: "https://api.supabase.com",
        config: { ref: "abcdefghijklmnop", summary: "public.orders(id uuid)", summary_version: 2 },
        account_id: "acct-1",
      }),
    );

    expect((result as { content: string }).content).toContain("public.orders");
    expect((result as { content: string }).content.toLowerCase()).toContain("schema");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a Supabase project's schema instead of calling it an undescribed API", async () => {
    const result = await describeConnectionTool.run(
      { connectionId: "conn-3" },
      ctxWith({
        ...SQL_CONNECTION,
        id: "conn-3",
        transport: "supabase",
        base_url: "https://api.supabase.com",
        config: { ref: "abcdefghijklmnop" },
        account_id: "acct-1",
      }),
    );

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.supabase.com/v1/projects/abcdefghijklmnop/database/query/read-only",
    );
    expect((result as { content: string }).content).toContain("public.orders(id uuid");
  });

  it("refuses a connection this workspace cannot see", async () => {
    const result = await describeConnectionTool.run({ connectionId: "conn-1" }, ctxWith(null));
    expect(result).toEqual({ kind: "error", message: "no such connection in this workspace" });
  });
});
