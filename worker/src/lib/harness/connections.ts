import type { ToolContext } from "./registry";

/**
 * Reading a `tool_connections` row, and the credential behind it.
 *
 * The order is the whole security of this file and it is the same order
 * `routes/connections.ts` uses for OAuth tokens: **ask the database whether
 * this caller may have the row, and only then reach past the database for the
 * column it withheld.** `secret_ciphertext` is granted to no client role
 * (0059) and `connected_account_id` is granted to none either (0062), so the
 * permission question cannot be answered by the same read that fetches them —
 * and answering it second would mean they had already been fetched by the time
 * anybody asked.
 */

/**
 * How Covan speaks to a connection.
 *
 * `unknown` is not a value any row holds; it is what this file returns for a
 * `transport` it does not recognise. Until 0062 an unrecognised value fell back
 * to `"http"`, which was a lie with teeth: a row written by a newer build would
 * have been handed to `http_request`, which would have resolved a path against
 * its base URL and sent the connection's credential there. Every tool refuses
 * `unknown` explicitly instead.
 */
export type ToolTransport = "http" | "sql" | "supabase" | "composio" | "unknown";

export type ToolConnection = {
  id: string;
  workspace_id: string;
  label: string;
  transport: ToolTransport;
  base_url: string;
  auth_kind: "static_header" | "composio" | "unknown";
  allowed_methods: string[];
  config: Record<string, unknown>;
  /**
   * The Supabase account whose token this row borrows, for `supabase` rows
   * and null for every other kind.
   *
   * A project connected through an account has no credential of its own — the
   * token is the account's and one copy of it is the point (0061). This is
   * what `authHeaders` follows to find it.
   */
  account_id: string | null;
  /**
   * The Composio application this row connects, for `composio` rows.
   *
   * Load-bearing rather than decorative: the model finds a tool slug in the
   * catalogue and this is what says which connection id goes with it, and
   * `run_tool` refuses a slug whose toolkit is not this one.
   */
  toolkit_slug: string | null;
  /**
   * Whether the connection has finished being made. Only `composio` rows are
   * ever anything but `active` — every other transport is born finished (0062).
   */
  status: "pending" | "active" | "failed";
};

/**
 * The columns a CLIENT may select.
 *
 * `connected_account_id` and `composio_user_id` are deliberately absent and
 * adding them here would not work: 0062 grants neither to `authenticated`, so
 * PostgREST answers the whole request with a permission error rather than
 * quietly omitting the column. They are read by `lib/harness/secrets.ts`, with
 * the service role, after this read has already decided the caller may have the
 * row.
 */
const SELECT =
  "id, workspace_id, label, transport, base_url, auth_kind, allowed_methods, config, account_id, toolkit_slug, status";

const TRANSPORTS = new Set(["http", "sql", "supabase", "composio"]);

function normalise(row: Record<string, unknown>): ToolConnection {
  const transport =
    typeof row.transport === "string" && TRANSPORTS.has(row.transport)
      ? (row.transport as ToolTransport)
      : "unknown";
  const status = row.status === "pending" || row.status === "failed" ? row.status : "active";
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    label: String(row.label ?? ""),
    transport,
    base_url: String(row.base_url ?? ""),
    // Read from the row rather than asserted, which it was until 0062 added a
    // second value. A hardcoded `static_header` on a Composio row would have
    // sent `authHeaders` looking for an envelope that does not exist.
    auth_kind:
      row.auth_kind === "static_header" || row.auth_kind === "composio" ? row.auth_kind : "unknown",
    allowed_methods: Array.isArray(row.allowed_methods) ? (row.allowed_methods as string[]) : [],
    config:
      row.config && typeof row.config === "object" ? (row.config as Record<string, unknown>) : {},
    account_id: typeof row.account_id === "string" ? row.account_id : null,
    toolkit_slug: typeof row.toolkit_slug === "string" ? row.toolkit_slug.toLowerCase() : null,
    status,
  };
}

/**
 * Every connection this caller may see, for the prompt's manifest.
 *
 * Filtered to the ones that can actually answer. A row appears the moment
 * somebody is sent to a consent screen, so a workspace routinely holds
 * connections that are half made — and a half-made one in the manifest is a
 * connection the model will name, call, and get an error from, having spent a
 * step of the budget to find out. It also counts towards
 * `workspacesWithConnections` on the cron path, which is expensive for a
 * workspace that has connected nothing that works.
 */
export async function listConnections(
  db: ToolContext["db"],
  workspaceId: string,
): Promise<ToolConnection[]> {
  const { data, error } = await db
    .from("tool_connections")
    .select(SELECT)
    .eq("workspace_id", workspaceId)
    .eq("status", "active")
    .order("label", { ascending: true });
  if (error) throw new Error(`could not list connections: ${error.message}`);
  return (data ?? []).map((row) => normalise(row as Record<string, unknown>));
}

/**
 * One connection, through the caller's own client.
 *
 * The workspace filter is belt over the braces RLS already provides, and it is
 * there for the reason `lib/routines/executor.ts` gives about matching on id
 * alone: an id is a thing the model wrote, and a tool that trusted it would be
 * one hallucinated uuid away from a cross-tenant read if a policy ever
 * loosened.
 *
 * Unlike `listConnections` this does NOT filter by status. A tool that asked
 * for a pending connection should be told it has not finished connecting, which
 * is a sentence a person can act on; "no such connection" would send them
 * looking for a row that is on their screen.
 */
export async function loadConnection(ctx: ToolContext, id: string): Promise<ToolConnection | null> {
  const { data, error } = await ctx.db
    .from("tool_connections")
    .select(SELECT)
    .eq("id", id)
    .eq("workspace_id", ctx.workspaceId)
    .maybeSingle();
  if (error) throw new Error(`could not load connection: ${error.message}`);
  return data ? normalise(data as Record<string, unknown>) : null;
}

/** What one connection is called in the manifest, and how it is reached. */
function describe(c: ToolConnection): string {
  if (c.transport === "composio") {
    // The toolkit is named because it is the join: `find_tool` answers with
    // slugs like `GMAIL_SEND_EMAIL`, and without this line the model has no way
    // to know which of two connections that slug belongs to.
    return `${c.toolkit_slug ?? "app"} via run_tool`;
  }
  return c.transport === "http" ? "HTTP API" : "database";
}

/**
 * The line in the system prefix that tells the agent what it can reach.
 *
 * Built from the same rows and in the same spirit as the document manifest in
 * `lib/prompt.ts`: stable turn over turn, so it caches, and naming things the
 * agent would otherwise have to guess at. A tool takes `connectionId`, and
 * without this the model has no way to know one.
 */
export function connectionsManifest(connections: ToolConnection[]): string {
  if (connections.length === 0) return "";
  const lines = connections.map((c) => `- ${c.label} (id: ${c.id}, ${describe(c)})`);
  const hasComposio = connections.some((c) => c.transport === "composio");
  return (
    "Connected services you can reach with your tools:\n" +
    `${lines.join("\n")}\n` +
    "Use describe_connection first when you do not already know what one holds. " +
    (hasComposio
      ? "For a connected app, use find_tool to find the operation you need and then " +
        "run_tool with that app's connection id. "
      : "") +
    "Never guess an id that is not on this list."
  );
}
