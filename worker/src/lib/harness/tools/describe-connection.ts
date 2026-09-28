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
/**
 * Schemas that belong to the platform rather than to the application.
 *
 * Supabase ships a dozen of these and `information_schema.columns` lists them
 * all. Ordered by `table_schema`, `auth.*` comes before `public.*` — so every
 * call against the founder's project returned 12,054 characters beginning at
 * `auth.audit_log_entries`, and the 1,000-row limit and the 12,000-character
 * cap were both spent before reaching a table anybody would query. At 12:44:55
 * on 2026-09-25 the agent answered "the messages table isn't visible; which
 * table holds agent messages?" — a wasted pass and a wrong answer.
 *
 * By name, deliberately, and not "everything but public": an application that
 * keeps its tables in a `sales` schema is describing its own tables. The cost
 * is an application whose own schema is called one of these, which is hidden;
 * the tool description says so.
 */
export const INTERNAL_SCHEMAS = [
  "pg_catalog",
  "information_schema",
  "auth",
  "storage",
  "extensions",
  "realtime",
  "vault",
  "net",
  "supabase_functions",
  "supabase_migrations",
  "graphql",
  "graphql_public",
  "pgsodium",
  "pgsodium_masks",
  "cron",
  "pgbouncer",
];

const SCHEMA_QUERY =
  "select table_schema, table_name, column_name, data_type " +
  "from information_schema.columns " +
  `where table_schema not in (${INTERNAL_SCHEMAS.map((s) => `'${s}'`).join(", ")}) ` +
  // `public` first, so the row limit is spent on the tables the model can use.
  "order by (table_schema <> 'public'), table_schema, table_name, ordinal_position";

/** Enough columns to describe a real schema, few enough to stay readable. */
const SCHEMA_ROW_LIMIT = 1000;

/**
 * Columns of one table the summary will name before it starts counting.
 *
 * A forty-column table is already more than a model needs to write a query;
 * a two-hundred-column one is the rest of the schema not fitting.
 */
const MAX_COLUMNS_PER_TABLE = 40;

/**
 * What `config.summary` was written by.
 *
 * Bumped when the rendering changes, so a summary cached by an older build is
 * refetched once rather than served forever — the truncated `auth.*` answers
 * are in `config.summary` on every connection that was ever described.
 */
const SUMMARY_VERSION = 2;

export const describeConnectionTool: AgentTool = {
  name: "describe_connection",
  description:
    "Find out what a connected service offers before you use it: for a database, its " +
    "tables and columns; for an HTTP API, whatever the team recorded about it. Call this " +
    "once before your first query_database or http_request against a connection you have " +
    "not used in this conversation. A database answer lists the application's own tables, " +
    "public first; the platform's internal schemas (auth, storage, extensions and the " +
    "rest) are left out, so a table of yours that lives in a schema with one of those " +
    "names will not appear.",
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

    // Answered twice in one turn more often than it should be, and a schema
    // does not change inside a turn. Its own map rather than `searchMemo`,
    // whose documentation says only `find_tool` writes there.
    //
    // Keyed on the connection alone, and a refresh OVERWRITES the entry rather
    // than occupying a second one beside it. With the flag in the key, a model
    // that refreshed because the answer looked wrong could ask a third time
    // and be handed the very text the refresh had just replaced.
    const memoKey = `describe|${connection.id}`;
    const remembered = ctx.describeMemo?.get(memoKey);
    if (remembered && input.refresh !== true) return { kind: "ok", content: remembered };

    const answer = (content: string): ToolResult => {
      ctx.describeMemo?.set(memoKey, content);
      return { kind: "ok", content };
    };

    const cached = connection.config.summary;
    // Only a summary THIS tool rendered goes stale when the rendering changes,
    // and `summary_cached_at` is what says it did: `cacheConnectionSummary` is
    // the only writer of that field.
    //
    // NOT the transport. `config.summary` is a field a person can fill in on
    // any connection — the Add-connection form offers it for a database too
    // ("What it holds (optional)") and the PATCH route takes it for every
    // kind. Treating a database's summary as a rendering because of its
    // transport would query information_schema and write the generated table
    // listing over somebody's own description, through the service client,
    // with nobody having asked for a refresh.
    const wasRendered = typeof connection.config.summary_cached_at === "string";
    const cacheIsCurrent = !wasRendered || connection.config.summary_version === SUMMARY_VERSION;
    if (input.refresh !== true && cacheIsCurrent && typeof cached === "string" && cached.trim()) {
      return answer(
        `${connection.label} (${connection.transport}, ${connection.base_url})\n\n` + cached,
      );
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

    // A `sql` connection can answer a schema query, through PostgREST. An HTTP
    // API has nothing to ask.
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

    const summary = summariseSchema(result.content);
    // Best-effort. A failed cache write costs a round trip next turn.
    await cacheConnectionSummary(ctx.env, connection, summary, SUMMARY_VERSION);

    return answer(`${connection.label} (database, ${connection.base_url})\n\n` + summary);
  },
};

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
 * `public.` is dropped as noise. It used to be kept for a connected Supabase
 * account, whose read-only endpoint refused a bare table name; that carrier is
 * gone and PostgREST resolves against its own `search_path`, so there is one
 * answer again rather than a parameter.
 */
export function summariseSchema(json: string): string {
  let rows: Array<Record<string, unknown>>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return json;
    rows = parsed as Array<Record<string, unknown>>;
  } catch {
    return json;
  }
  const tables = new Map<string, string[]>();
  const internal = new Set(INTERNAL_SCHEMAS);
  for (const row of rows) {
    const schema = String(row.table_schema ?? "public");
    const table = String(row.table_name ?? "");
    if (!table) continue;
    // Again here, not only in the query: a role that can see everything gets
    // the same answer whichever way the rows arrived, and this is the half a
    // unit test can hold.
    if (internal.has(schema)) continue;
    const key = schema === "public" ? table : `${schema}.${table}`;
    const column = `${String(row.column_name ?? "")} ${String(row.data_type ?? "")}`.trim();
    const list = tables.get(key);
    if (list) list.push(column);
    else tables.set(key, [column]);
  }
  if (tables.size === 0) return json;
  return [...tables.entries()]
    .map(([table, cols]) => {
      const shown = cols.slice(0, MAX_COLUMNS_PER_TABLE);
      const hidden = cols.length - shown.length;
      const more = hidden > 0 ? `, … ${hidden} more columns` : "";
      return `${table}(${shown.join(", ")}${more})`;
    })
    .join("\n");
}
