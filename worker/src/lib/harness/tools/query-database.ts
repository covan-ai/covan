import { assertFetchableUrl, ownHostsFrom } from "../../routines/url-guard";
import { readCapped, resolvesPublicly } from "../../routines/source";
import { loadConnection, type ToolConnection } from "../connections";
import { authHeaders } from "../secrets";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";

/**
 * The agent writes its own SQL.
 *
 * The alternative — a list of queries somebody wrote in advance, exposed as
 * named tools — was considered and rejected, and the reason is the whole point
 * of this file: every new question would need a new query, which means code,
 * which means the thing this design exists to avoid. A schema the agent can
 * read (`describe_connection`) plus SQL it can write is the only shape where
 * adding a second database is a row rather than a release.
 *
 * WHERE READ-ONLY ACTUALLY COMES FROM. Not from this file. The target database
 * runs the query inside a function that opens with `set local transaction read
 * only` (the snippet is in `docs/integrations.md`), so a hidden INSERT, an
 * UPDATE inside a CTE, or a DDL statement is refused by Postgres at the
 * transaction level — by the database being asked, using its own rules, with
 * no parsing anywhere. `looksReadOnly` below is a second line that catches the
 * obvious cases early and gives the model a readable reason; it is not the
 * line that holds.
 *
 * WHY POSTGREST AND NOT A POSTGRES DRIVER. Cloudflare Workers cannot open a
 * raw TCP socket, so a driver would work on the Node runtime and not on the
 * other one — and "both runtimes must keep working" is not negotiable here
 * (AGENTS.md; `docs/architecture.md`, "the two seams"). PostgREST will not
 * take raw SQL but will call a function, and the function is the carrier.
 */

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 256 * 1024;

/** Rows the target function returns unless the model asks for fewer. */
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/** What the target function is called when the connection does not say. */
export const DEFAULT_RPC = "covan_query";

/**
 * A cheap first read of whether this is a query.
 *
 * Deliberately crude, and deliberately not the security boundary. It exists so
 * that an agent that writes `delete from users` is told "this connection is
 * read-only" in words it can act on, instead of getting a Postgres error about
 * a read-only transaction that it may well decide to retry.
 *
 * Comments are stripped first, because `/* x *\/ delete ...` starts with a
 * comment and not with `delete`.
 */
export function looksReadOnly(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  if (!stripped) return false;
  // `explain` is read-shaped and still refused: the carrier runs the query
  // inside `select * from (...)`, and EXPLAIN is not something you can select
  // from. Refusing it here gives the model a sentence instead of a syntax
  // error from the far end that it cannot act on.
  if (!/^(select|with|table|values)\b/i.test(stripped)) return false;
  // A writing CTE is the interesting case and the only one worth naming:
  // `with x as (delete from t returning *) select * from x` passes the test
  // above and is not a read.
  return !/\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke|copy|vacuum|call|do)\b/i.test(
    stripped,
  );
}

/** The rpc endpoint for a connection, on the PostgREST base it names. */
export function rpcUrl(connection: ToolConnection): string {
  const name =
    typeof connection.config.rpc === "string" && connection.config.rpc.trim()
      ? connection.config.rpc.trim()
      : DEFAULT_RPC;
  const base = connection.base_url.endsWith("/") ? connection.base_url : `${connection.base_url}/`;
  return `${base}rpc/${encodeURIComponent(name)}`;
}

export const queryDatabaseTool: AgentTool = {
  name: "query_database",
  description:
    "Run a read-only SQL query against a database this workspace has connected, and get " +
    "the rows back as JSON. Write the SQL yourself. One statement, and a LIMIT of your own " +
    "is fine. The connection is read-only and enforced as such by the database — do not " +
    "attempt INSERT, UPDATE, DELETE or DDL, and EXPLAIN is not supported either. " +
    "Call describe_connection first if you do not already know the tables and columns.",
  input: {
    type: "object",
    properties: {
      connectionId: { type: "string", description: "The id of a connected database." },
      sql: {
        type: "string",
        description: "One SELECT statement. No semicolon-separated statements, no writes.",
      },
      limit: {
        type: "integer",
        description: `Maximum rows to return. Defaults to ${DEFAULT_LIMIT}.`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
    },
    required: ["connectionId", "sql"],
    additionalProperties: false,
  },
  destructive: false,
  needs: "connection",
  isConfigured: (env: ToolEnv) => Boolean(env.ALLOWED_ORIGIN && env.ROUTINE_SECRET_KEY),
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = args as { connectionId?: unknown; sql?: unknown; limit?: unknown };
    if (typeof input.connectionId !== "string" || !input.connectionId) {
      return { kind: "error", message: "connectionId is required" };
    }
    if (typeof input.sql !== "string" || !input.sql.trim()) {
      return { kind: "error", message: "sql is required" };
    }
    const sql = input.sql.trim().replace(/;\s*$/, "");
    if (sql.includes(";")) {
      return {
        kind: "error",
        message: "send one statement — semicolons separating statements are not accepted",
      };
    }
    if (!looksReadOnly(sql)) {
      return {
        kind: "error",
        message:
          "this connection is read-only: send a SELECT. The database refuses writes at the " +
          "transaction level, so retrying a write in different words will not work.",
      };
    }
    const limit =
      typeof input.limit === "number" && Number.isFinite(input.limit)
        ? Math.min(Math.max(Math.trunc(input.limit), 1), MAX_LIMIT)
        : DEFAULT_LIMIT;

    const connection = await loadConnection(ctx, input.connectionId);
    if (!connection) return { kind: "error", message: "no such connection in this workspace" };
    if (connection.transport !== "sql") {
      return {
        kind: "error",
        message: `${connection.label} is an HTTP API — use http_request for it`,
      };
    }

    let target: URL;
    try {
      target = assertFetchableUrl(rpcUrl(connection), ownHostsFrom(ctx.env));
      await resolvesPublicly(target.hostname);
    } catch (err) {
      return { kind: "error", message: err instanceof Error ? err.message : "unsafe url" };
    }

    const res = await fetch(target.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "covan-agent/1.0",
        ...(await authHeaders(ctx.env, connection)),
      },
      body: JSON.stringify({ p_sql: sql, p_limit: limit }),
      redirect: "manual",
      signal: ctx.signal ?? AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status >= 300 && res.status < 400) {
      return { kind: "error", message: `${res.status} redirect — not followed` };
    }

    const text = await readCapped(res, MAX_BYTES);

    if (!res.ok) {
      // The target's own error, forwarded rather than flattened. "column
      // o.custmer_id does not exist" is the thing that lets the model write a
      // working query on its next pass; "the query failed" is not.
      return {
        kind: "error",
        message: `the database refused the query (${res.status}): ${text.slice(0, 2000)}`,
      };
    }

    if (!text.trim() || text.trim() === "[]" || text.trim() === "null") {
      return { kind: "ok", content: "The query ran and matched no rows." };
    }
    return { kind: "ok", content: text };
  },
};
