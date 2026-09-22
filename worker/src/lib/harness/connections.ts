import type { ToolContext, ToolEnv } from "./registry";

/**
 * Reading a `tool_connections` row, and the credential behind it.
 *
 * The order is the whole security of this file and it is the same order
 * `routes/connections.ts` uses for OAuth tokens: **ask the database whether
 * this caller may have the row, and only then reach past the database for the
 * column it withheld.** `secret_ciphertext` is granted to no client role
 * (0059), so the permission question cannot be answered by the same read that
 * fetches the secret — and answering it second would mean the secret had
 * already been fetched by the time anybody asked.
 */

export type ToolConnection = {
  id: string;
  workspace_id: string;
  label: string;
  transport: "http" | "sql" | "supabase";
  base_url: string;
  auth_kind: "static_header";
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
};

const SELECT =
  "id, workspace_id, label, transport, base_url, auth_kind, allowed_methods, config, account_id";

function normalise(row: Record<string, unknown>): ToolConnection {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    label: String(row.label ?? ""),
    transport: row.transport === "sql" || row.transport === "supabase" ? row.transport : "http",
    base_url: String(row.base_url ?? ""),
    auth_kind: "static_header",
    allowed_methods: Array.isArray(row.allowed_methods) ? (row.allowed_methods as string[]) : [],
    config:
      row.config && typeof row.config === "object" ? (row.config as Record<string, unknown>) : {},
    account_id: typeof row.account_id === "string" ? row.account_id : null,
  };
}

/** Every connection this caller may see, for the prompt's manifest. */
export async function listConnections(
  db: ToolContext["db"],
  workspaceId: string,
): Promise<ToolConnection[]> {
  const { data, error } = await db
    .from("tool_connections")
    .select(SELECT)
    .eq("workspace_id", workspaceId)
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
  const lines = connections.map(
    (c) => `- ${c.label} (id: ${c.id}, ${c.transport === "http" ? "HTTP API" : "database"})`,
  );
  return (
    "Connected services you can reach with your tools:\n" +
    `${lines.join("\n")}\n` +
    "Use describe_connection first when you do not already know what one holds. " +
    "Never guess an id that is not on this list."
  );
}
