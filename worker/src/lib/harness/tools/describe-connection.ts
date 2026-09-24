import { loadConnection } from "../connections";
import { cacheConnectionSummary } from "../secrets";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";
import { queryDatabaseTool } from "./query-database";

/**
 * What a connection holds, so the model does not have to know a service by
 * heart.
 *
 * The answer is cached in `tool_connections.config.summary` and re-read from
 * there. Asking the target on every turn would be a round trip and a page of
 * input tokens per question, for an answer that changes when somebody runs a
 * migration — which is to say rarely, and never in the middle of a
 * conversation. `refresh: true` is the escape hatch, and the settings screen
 * offers it as a button.
 *
 * For a SQL connection the summary is produced by an ordinary query against
 * `information_schema`, run through `query_database` like any other. There is
 * no special path, no second code route and nothing Supabase-shaped: any
 * Postgres that can answer the query can be described.
 */

/**
 * The schema, as the target itself reports it.
 *
 * `information_schema.columns` rather than `pg_catalog`, because it is
 * standard and because it is already filtered to what the querying role may
 * see — a read-only role with rights on two schemas describes two schemas,
 * which is the right answer and not a thing this query has to arrange.
 */
const SCHEMA_QUERY =
  "select table_schema, table_name, column_name, data_type " +
  "from information_schema.columns " +
  "where table_schema not in ('pg_catalog', 'information_schema') " +
  "order by table_schema, table_name, ordinal_position";

/** Enough columns to describe a real schema, few enough to stay readable. */
const SCHEMA_ROW_LIMIT = 1000;

export const describeConnectionTool: AgentTool = {
  name: "describe_connection",
  description:
    "Find out what a connected service offers before you use it: for a database, its " +
    "tables and columns; for an HTTP API, whatever the team recorded about it. Call this " +
    "once before your first query_database or http_request against a connection you have " +
    "not used in this conversation.",
  input: {
    type: "object",
    properties: {
      connectionId: { type: "string", description: "The id of a connected service." },
      refresh: {
        type: "boolean",
        description:
          "Ask the service again instead of using what is already recorded. Only when the " +
          "recorded description looks wrong or out of date.",
      },
    },
    required: ["connectionId"],
    additionalProperties: false,
  },
  destructive: false,
  needs: "connection",
  isConfigured: (env: ToolEnv) => Boolean(env.ROUTINE_SECRET_KEY),
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const input = args as { connectionId?: unknown; refresh?: unknown };
    if (typeof input.connectionId !== "string" || !input.connectionId) {
      return { kind: "error", message: "connectionId is required" };
    }
    const connection = await loadConnection(ctx, input.connectionId);
    if (!connection) return { kind: "error", message: "no such connection in this workspace" };

    const cached = connection.config.summary;
    if (input.refresh !== true && typeof cached === "string" && cached.trim()) {
      return {
        kind: "ok",
        content:
          `${connection.label} (${connection.transport}, ${connection.base_url})\n\n` +
          `${cached}${qualifiedNamesNote(connection.transport)}`,
      };
    }

    // A connected application does not have a schema to describe; it has a
    // catalogue to search, and the catalogue is not this connection's — it is
    // fifteen hundred applications wide and lives behind `find_tool`.
    // Answered here rather than falling into the `http` branch below, which
    // would have reported allowed methods that mean nothing on this transport,
    // or into the query below, which would have run `information_schema`
    // against an API that has no database.
    if (connection.transport === "composio") {
      return {
        kind: "ok",
        content:
          `${connection.label} is a connected ${connection.toolkit_slug ?? "application"}.\n\n` +
          `Use find_tool with toolkit "${connection.toolkit_slug ?? ""}" to see what it can do, ` +
          `then run_tool with this connection's id. There is nothing else to describe: the ` +
          "list of operations is the catalogue's, not this connection's.",
      };
    }

    if (connection.transport === "unknown") {
      return {
        kind: "error",
        message:
          `${connection.label} is a kind of connection this build does not know how to reach. ` +
          "It was probably made by a newer version of Covan.",
      };
    }

    // Every carrier that can answer a schema query goes on: `sql` through
    // PostgREST, `supabase` through the account's own token. Only an HTTP API
    // has nothing to ask.
    if (connection.transport === "http") {
      // Nothing to go and fetch. An OpenAPI document would be the obvious
      // thing to read, and is deliberately not read: the path it lives at is
      // a guess for every API that is not the one we tested against, and a
      // tool that fetches three guessed paths per call is three requests
      // somebody's rate limit pays for. The team writes a description when
      // they create the connection; this reports it.
      return {
        kind: "ok",
        content:
          `${connection.label} (HTTP API, ${connection.base_url})\n` +
          `Methods the team allowed: ${connection.allowed_methods.join(", ") || "none"}.\n\n` +
          "No description has been recorded for this connection. Ask the person you are " +
          "talking to which path you should call, or try a documented one with " +
          "http_request — do not guess repeatedly.",
      };
    }

    // The same tool a person's question goes through, called directly. Not a
    // shortcut: it carries the origin guard, the credential resolution and the
    // read-only check with it, and a second copy of that would be a second
    // place to get it wrong.
    const result = await queryDatabaseTool.run(
      { connectionId: connection.id, sql: SCHEMA_QUERY, limit: SCHEMA_ROW_LIMIT },
      ctx,
    );
    if (result.kind !== "ok") return result;

    const qualify = connection.transport === "supabase";
    const summary = summariseSchema(result.content, { qualify });
    // Best-effort. A failed cache write costs a round trip next turn.
    await cacheConnectionSummary(ctx.env, connection, summary);

    return {
      kind: "ok",
      content:
        `${connection.label} (database, ${connection.base_url})\n\n` +
        `${summary}${qualifiedNamesNote(connection.transport)}`,
    };
  },
};

/**
 * The sentence a Supabase project needs and no other connection does.
 *
 * Its endpoint refuses a reference that names no schema. The summary above
 * already shows every table as `public.orders`, which teaches by example — but
 * a model reading a cached summary cold is one `select * from orders` away
 * from a refusal it has to spend a turn understanding, and one line is cheaper
 * than that turn.
 */
function qualifiedNamesNote(transport: string): string {
  return transport === "supabase"
    ? "\n\nName the schema on every table (public.orders, not orders) — this connection refuses " +
        "a bare table name."
    : "";
}

/**
 * One line per table, columns inline.
 *
 * A row per column is how the database answers and is the wrong shape to send
 * a model: four hundred JSON objects saying `{"table_name":"orders",...}` four
 * hundred times is mostly the word `table_name`. Folding it costs nothing and
 * roughly quarters the tokens.
 *
 * Falls back to the raw JSON if it cannot be read. The point is to be cheaper,
 * not to be the only way the answer can arrive.
 *
 * `qualify` keeps `public.` on every line. It is on for a connection whose
 * carrier refuses a bare table name, which is what the summary is teaching the
 * model to write.
 */
export function summariseSchema(json: string, opts?: { qualify?: boolean }): string {
  let rows: Array<Record<string, unknown>>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return json;
    rows = parsed as Array<Record<string, unknown>>;
  } catch {
    return json;
  }
  const tables = new Map<string, string[]>();
  for (const row of rows) {
    const schema = String(row.table_schema ?? "public");
    const table = String(row.table_name ?? "");
    if (!table) continue;
    // `public.` is dropped where it is noise and kept where it is required:
    // Supabase's read-only endpoint refuses an unqualified reference, so a
    // summary written for one has to name the schema every time.
    const key = schema === "public" && !opts?.qualify ? table : `${schema}.${table}`;
    const column = `${String(row.column_name ?? "")} ${String(row.data_type ?? "")}`.trim();
    const list = tables.get(key);
    if (list) list.push(column);
    else tables.set(key, [column]);
  }
  if (tables.size === 0) return json;
  return [...tables.entries()].map(([table, cols]) => `${table}(${cols.join(", ")})`).join("\n");
}
