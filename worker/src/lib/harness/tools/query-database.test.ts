import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext, ToolEnv } from "../registry";
import { looksReadOnly, queryDatabaseTool, readOnlyComplaint, rpcUrl } from "./query-database";

/**
 * The tool that lets the agent write its own SQL.
 *
 * What is NOT tested here is that the query cannot write, and the omission is
 * deliberate rather than a gap: read-onlyness is the target database's
 * guarantee, made by `set local transaction read only` inside the function
 * this posts to. Asserting it from here would be asserting something about a
 * database that is not in this test. `looksReadOnly` is the second line and
 * is tested as what it is — a way to give the model a readable reason early.
 */
const authHeaders = vi.fn(async () => ({ apikey: "k", Authorization: "Bearer k" }));
vi.mock("../secrets", () => ({ authHeaders: () => authHeaders() }));

const resolvesPublicly = vi.fn(async (_host: string) => {});
vi.mock("../../routines/source", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../routines/source")>();
  return { ...actual, resolvesPublicly: (host: string) => resolvesPublicly(host) };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const CONNECTION = {
  id: "conn-1",
  workspace_id: "ws-1",
  label: "Covan Supabase",
  transport: "sql",
  base_url: "https://proj.supabase.co/rest/v1",
  auth_kind: "static_header",
  allowed_methods: ["GET"],
  config: { rpc: "covan_query" },
};

function ctxWith(row: Record<string, unknown> | null = CONNECTION): ToolContext {
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
  resolvesPublicly.mockClear();
  resolvesPublicly.mockResolvedValue(undefined);
  fetchMock.mockResolvedValue(new Response('[{"n":4}]', { status: 200 }));
});

describe("looksReadOnly", () => {
  it("accepts the four shapes the carrier can actually run", () => {
    // Each of these composes inside `select * from (…) q limit N`, which is
    // what the function on the target database wraps them in.
    expect(looksReadOnly("select 1")).toBe(true);
    expect(looksReadOnly("WITH x as (select 1) select * from x")).toBe(true);
    expect(looksReadOnly("table orders")).toBe(true);
    expect(looksReadOnly("values (1), (2)")).toBe(true);
  });

  /**
   * Read-shaped and still refused. EXPLAIN is not something you can select
   * from, so it cannot go through a carrier that wraps the query — and the
   * model gets a sentence here rather than a syntax error from the far end
   * that it has no way to act on.
   */
  it("refuses EXPLAIN, which the carrier cannot wrap", () => {
    expect(looksReadOnly("explain select 1")).toBe(false);
  });

  it("refuses the obvious writes", () => {
    expect(looksReadOnly("delete from users")).toBe(false);
    expect(looksReadOnly("update users set x = 1")).toBe(false);
    expect(looksReadOnly("drop table users")).toBe(false);
  });

  it("refuses a write hidden behind a comment", () => {
    expect(looksReadOnly("/* select */ delete from users")).toBe(false);
    expect(looksReadOnly("-- select\ndelete from users")).toBe(false);
  });

  it("refuses a writing CTE, which starts with the right word and is not a read", () => {
    expect(looksReadOnly("with d as (delete from users returning *) select * from d")).toBe(false);
  });

  /**
   * The difference between a crude check and an obstructive one. "Which
   * events were deletions" is an ordinary question, and a check that reads
   * the word inside the quotes refuses it with an explanation that is not
   * true.
   */
  it("does not read a keyword that is part of the data", () => {
    expect(looksReadOnly("select * from events where action = 'delete'")).toBe(true);
    expect(looksReadOnly("select * from t where note = 'it''s a drop'")).toBe(true);
  });

  it("says what tripped it, so the model can tell a refusal from a bug", () => {
    // Caught by the opening word, and named as the opening word.
    expect(readOnlyComplaint("update orders set total = 0")).toContain("not update");
    // Caught further in, and named as the keyword.
    expect(
      readOnlyComplaint("with d as (delete from users returning *) select * from d"),
    ).toContain("DELETE");
    // Named specifically, because "send a SELECT" is unhelpful advice to
    // somebody who sent a read.
    expect(readOnlyComplaint("explain select 1")).toContain("EXPLAIN");
    expect(readOnlyComplaint("select 1")).toBeNull();
  });
});

describe("rpcUrl", () => {
  it("hangs rpc/<name> off the PostgREST base the connection names", () => {
    expect(rpcUrl(CONNECTION as never)).toBe("https://proj.supabase.co/rest/v1/rpc/covan_query");
  });

  it("falls back to the documented name when the connection does not say", () => {
    expect(rpcUrl({ ...CONNECTION, config: {} } as never)).toBe(
      "https://proj.supabase.co/rest/v1/rpc/covan_query",
    );
  });
});

describe("query_database", () => {
  it("posts the SQL and the row cap to the named function", async () => {
    const result = await queryDatabaseTool.run(
      { connectionId: "conn-1", sql: "select count(*) as n from orders", limit: 50 },
      ctxWith(),
    );
    expect(result).toEqual({ kind: "ok", content: '[{"n":4}]' });
    expect(fetchMock.mock.calls[0][0]).toBe("https://proj.supabase.co/rest/v1/rpc/covan_query");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      p_sql: "select count(*) as n from orders",
      p_limit: 50,
    });
    expect(fetchMock.mock.calls[0][1].headers.apikey).toBe("k");
  });

  it("refuses an HTTP connection rather than posting SQL at an API", async () => {
    const result = await queryDatabaseTool.run(
      { connectionId: "conn-1", sql: "select 1" },
      ctxWith({ ...CONNECTION, transport: "http" }),
    );
    expect((result as { message: string }).message).toContain("http_request");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a write and tells the model not to rephrase it", async () => {
    const result = await queryDatabaseTool.run(
      { connectionId: "conn-1", sql: "update orders set total = 0" },
      ctxWith(),
    );
    expect((result as { message: string }).message).toContain("read-only");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses two statements in one call", async () => {
    const result = await queryDatabaseTool.run(
      { connectionId: "conn-1", sql: "select 1; drop table orders" },
      ctxWith(),
    );
    expect((result as { message: string }).message).toContain("one statement");
  });

  /**
   * The bug this pins, found against a real Postgres: the first version of
   * the documented function appended `limit N` to the caller's SQL, and
   * `select 1 limit 5 limit 200` is a syntax error. An agent writing its own
   * SQL puts a LIMIT on it constantly.
   */
  it("passes a query that has its own LIMIT straight through", async () => {
    const result = await queryDatabaseTool.run(
      { connectionId: "conn-1", sql: "select * from orders limit 5" },
      ctxWith(),
    );
    expect(result).toMatchObject({ kind: "ok" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).p_sql).toBe("select * from orders limit 5");
  });

  it("allows the trailing semicolon a person would type", async () => {
    const result = await queryDatabaseTool.run(
      { connectionId: "conn-1", sql: "select 1;" },
      ctxWith(),
    );
    expect(result).toMatchObject({ kind: "ok" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).p_sql).toBe("select 1");
  });

  it("bounds the row cap in both directions", async () => {
    await queryDatabaseTool.run(
      { connectionId: "conn-1", sql: "select 1", limit: 99999 },
      ctxWith(),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).p_limit).toBe(1000);
  });

  it("forwards the target's own error, which is what fixes the next query", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"message":"column o.custmer_id does not exist"}', { status: 400 }),
    );
    const result = await queryDatabaseTool.run(
      { connectionId: "conn-1", sql: "select o.custmer_id from orders o" },
      ctxWith(),
    );
    expect((result as { message: string }).message).toContain("custmer_id");
  });

  it("says plainly when a query matched nothing, rather than returning []", async () => {
    fetchMock.mockResolvedValue(new Response("[]", { status: 200 }));
    const result = await queryDatabaseTool.run(
      { connectionId: "conn-1", sql: "select 1" },
      ctxWith(),
    );
    expect(result).toEqual({ kind: "ok", content: "The query ran and matched no rows." });
  });

  it("goes through the SSRF guard before it posts anything", async () => {
    const result = await queryDatabaseTool.run(
      { connectionId: "conn-1", sql: "select 1" },
      ctxWith({ ...CONNECTION, base_url: "http://127.0.0.1:5432" }),
    );
    expect((result as { message: string }).message).toContain("private address");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * The second carrier: a project reached through the account's own token.
 *
 * Same tool, same read-only check, same guards — only the envelope changes.
 * What is worth asserting here is the part the Management API does not do for
 * us: it takes no row cap, so the cap has to be in the statement before it
 * leaves.
 */
const SUPABASE_CONNECTION = {
  id: "conn-2",
  workspace_id: "ws-1",
  label: "covan-prod",
  transport: "supabase",
  base_url: "https://api.supabase.com",
  auth_kind: "static_header",
  allowed_methods: ["GET"],
  config: { ref: "abcdefghijklmnop", projectName: "covan-prod" },
  account_id: "acct-1",
};

describe("a Supabase account connection", () => {
  it("posts the statement to that project's read-only endpoint", async () => {
    const result = await queryDatabaseTool.run(
      { connectionId: "conn-2", sql: "select count(*) as n from public.orders" },
      ctxWith(SUPABASE_CONNECTION),
    );

    expect(result).toEqual({ kind: "ok", content: '[{"n":4}]' });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.supabase.com/v1/projects/abcdefghijklmnop/database/query/read-only",
    );
  });

  it("caps the rows in the statement, because the endpoint takes no limit", async () => {
    await queryDatabaseTool.run(
      { connectionId: "conn-2", sql: "select * from public.orders", limit: 5 },
      ctxWith(SUPABASE_CONNECTION),
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.query).toBe("select * from ( select * from public.orders ) as covan_q limit 5");
    expect(body.p_sql).toBeUndefined();
  });

  it("still refuses a write before it reaches the account's token", async () => {
    const result = await queryDatabaseTool.run(
      { connectionId: "conn-2", sql: "delete from public.orders" },
      ctxWith(SUPABASE_CONNECTION),
    );

    expect((result as { message: string }).message).toContain("read-only");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
