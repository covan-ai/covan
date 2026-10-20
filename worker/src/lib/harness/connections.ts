import type { ToolContext } from "./registry";

/**
 * Reading a `tool_connections` row, and the credential behind it.
 *
 * The order is the whole security of this file and it is the same order
 * `routes/connections.ts` uses for OAuth tokens: **ask the database whether
 * this caller may have the row, and only then reach past the database for the
 * column it withheld.** `secret_ciphertext` is granted to no client role
 * (0059) and `connected_account_id` is granted to none either (0063), so the
 * permission question cannot be answered by the same read that fetches them —
 * and answering it second would mean they had already been fetched by the time
 * anybody asked.
 */

/**
 * How Covan speaks to a connection.
 *
 * `unknown` is not a value any row holds; it is what this file returns for a
 * `transport` it does not recognise. Until 0063 an unrecognised value fell back
 * to `"http"`, which was a lie with teeth: a row written by a newer build would
 * have been handed to `http_request`, which would have resolved a path against
 * its base URL and sent the connection's credential there. Every tool refuses
 * `unknown` explicitly instead.
 */
export type ToolTransport = "http" | "sql" | "composio" | "unknown";

export type ToolConnection = {
  id: string;
  workspace_id: string;
  label: string;
  transport: ToolTransport;
  base_url: string;
  /**
   * How the credential is held — and for a composio row, **load-bearing rather
   * than descriptive** since 0072. `composio_no_auth` is the only thing telling
   * `composioAccount` that a row naming no account is correct rather than
   * broken (covan#253).
   */
  auth_kind: "static_header" | "composio" | "composio_no_auth" | "unknown";
  allowed_methods: string[];
  config: Record<string, unknown>;
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
   * ever anything but `active` — every other transport is born finished (0063).
   */
  status: "pending" | "active" | "failed";
  /**
   * Who may reach it (0098): `owner` is its creator alone, `workspace` is every
   * member. Read here so a tool can tell a person's own connection from one a
   * colleague shared — a write through somebody else's account asks first.
   */
  scope: "owner" | "workspace";
  created_by: string | null;
};

/**
 * The columns a CLIENT may select.
 *
 * `connected_account_id` and `composio_user_id` are deliberately absent and
 * adding them here would not work: 0063 grants neither to `authenticated`, so
 * PostgREST answers the whole request with a permission error rather than
 * quietly omitting the column. They are read by `lib/harness/secrets.ts`, with
 * the service role, after this read has already decided the caller may have the
 * row.
 */
const SELECT =
  "id, workspace_id, label, transport, base_url, auth_kind, allowed_methods, config, toolkit_slug, status, scope, created_by";

/**
 * Own or shared, said in the query as well as by the policy (0098).
 *
 * On a chat turn `db` is the caller's client and the read policy already says
 * this. On a scheduled run it is the service role, which no policy filters, so
 * without this a routine would reach every member's personal account in its
 * workspace. `userId` is the person the turn runs for — never anything the
 * model wrote — and is checked to be a bare id before it goes into the filter.
 */
function reachableBy(userId: string): string {
  // A uuid in practice; refused if it holds anything PostgREST's filter
  // grammar would read as structure.
  if (!/^[A-Za-z0-9_-]+$/.test(userId)) throw new Error("not a user id");
  return `scope.eq.workspace,created_by.eq.${userId}`;
}

const TRANSPORTS = new Set(["http", "sql", "composio"]);

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
    // Read from the row rather than asserted, which it was until 0063 added a
    // second value. A hardcoded `static_header` on a Composio row would have
    // sent `authHeaders` looking for an envelope that does not exist.
    // Every value spelled out, and missing one is not cosmetic: an unlisted
    // `auth_kind` reads as `unknown`, `composioAccount` then takes the managed
    // branch, and every call on an application that needs no credential fails
    // with "needs to be reconnected" — which is impossible for that shape.
    auth_kind:
      row.auth_kind === "static_header" ||
      row.auth_kind === "composio" ||
      row.auth_kind === "composio_no_auth"
        ? row.auth_kind
        : "unknown",
    allowed_methods: Array.isArray(row.allowed_methods) ? (row.allowed_methods as string[]) : [],
    config:
      row.config && typeof row.config === "object" ? (row.config as Record<string, unknown>) : {},
    toolkit_slug: typeof row.toolkit_slug === "string" ? row.toolkit_slug.toLowerCase() : null,
    status,
    // Anything but `workspace` is read as personal: the narrower reading.
    scope: row.scope === "workspace" ? "workspace" : "owner",
    created_by: typeof row.created_by === "string" ? row.created_by : null,
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
  userId: string,
): Promise<ToolConnection[]> {
  const { data, error } = await db
    .from("tool_connections")
    .select(SELECT)
    .eq("workspace_id", workspaceId)
    .or(reachableBy(userId))
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
    .or(reachableBy(ctx.userId))
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
 * How many connections the manifest names one by one.
 *
 * The manifest is in the system prefix of every pass of every turn, at roughly
 * twenty tokens a line, and nothing bounded it: two hundred connections was
 * ~4,000 tokens of context each pass — the failure `find-tool.ts` was built to
 * avoid, putting every service into every prompt, reproduced one layer up
 * (#257). Twenty-four is generous for a workspace that uses what it connected
 * and cheap for one that connected everything.
 */
export const MANIFEST_MAX_LINES = 24;

/**
 * The line in the system prefix that tells the agent what it can reach.
 *
 * Built from the same rows and in the same spirit as the document manifest in
 * `lib/prompt.ts`: stable turn over turn, so it caches, and naming things the
 * agent would otherwise have to guess at. A tool takes `connectionId`, and
 * without this the model has no way to know one.
 *
 * CAPPED AT `MANIFEST_MAX_LINES`, and what is dropped is chosen, not cut. A
 * database or an HTTP API is always listed: nothing else ever tells the model
 * its id, because `find_tool` searches the app catalogue and never surfaces one.
 * A connected app can afford to be left off — `find_tool` hands back the
 * connectionId beside every result from an app the workspace has connected — so
 * those fill the remaining lines in label order (the order `listConnections`
 * reads, which keeps the prefix stable), and the rest are named in one line by
 * toolkit, which costs a few tokens each rather than twenty and still tells the
 * model they exist.
 */
export function connectionsManifest(connections: ToolConnection[]): string {
  if (connections.length === 0) return "";
  const others = connections.filter((c) => c.transport !== "composio");
  const appRoom = Math.max(0, MANIFEST_MAX_LINES - others.length);
  const apps = connections.filter((c) => c.transport === "composio");
  const listed = new Set([...others, ...apps.slice(0, appRoom)]);
  const unlisted = apps.slice(appRoom);
  const lines = connections
    .filter((c) => listed.has(c))
    .map((c) => `- ${c.label} (id: ${c.id}, ${describe(c)})`);
  if (unlisted.length > 0) {
    const slugs = [...new Set(unlisted.map((c) => c.toolkit_slug ?? "app"))].join(", ");
    lines.push(
      `- …and ${unlisted.length} more connected apps (${slugs}); find_tool searches all of ` +
        "them and gives the connectionId with each result — name the app in your query or " +
        "pass it as toolkit.",
    );
  }
  const hasComposio = connections.some((c) => c.transport === "composio");
  const hasOther = connections.some((c) => c.transport !== "composio");

  /**
   * Who `describe_connection` is for, said precisely.
   *
   * This used to read "use describe_connection first when you do not already
   * know what one holds", with no exception — and the model obeyed it. Three
   * production turns in a row opened with a `describe_connection` on a
   * connected app, which can only ever answer "there is nothing here to
   * describe, use find_tool", because a connected app's operations belong to
   * the catalogue rather than to the row. One step of eight, spent following
   * our own instruction to a dead end.
   *
   * So the sentence is now scoped to the transports it is true of, and the
   * connected-app path says outright that the step is not needed. Cheaper than
   * making `describe_connection` do something useful here, and more honest:
   * the tool was right, the instruction was wrong.
   *
   * The connected-app sentence also says which questions it is for. Without
   * that, an agent told to work "from the team's documents" answered "look at
   * my Notion page" with two document searches and "I cannot see Notion",
   * Notion listed right here the whole time. A named app is where to look.
   *
   * And what it says about an app has to come from reading it. Asked again,
   * the same agent said Notion had no page about the person — having still
   * read nothing from Notion. An answer about an app's contents that rests on
   * an empty document search is invented, however plausible it reads.
   */
  const guidance = [
    hasOther
      ? "Use describe_connection on a database or an API when you do not already know what " +
        "it holds."
      : "",
    hasComposio
      ? "A connected app needs no describing — go straight to find_tool for the operation " +
        "you need, then run_tool with that app's connection id. When the person names one " +
        "of these apps or asks about what is in it, read it there: search_documents covers " +
        "only the documents in Covan, never a connected app. Do not say what an app holds, " +
        "or that it lacks something, unless you read it with run_tool in this turn."
      : "",
    "Never guess an id that is not on this list.",
    // Without this the sentence above forbids the very ids the overflow line
    // says find_tool will hand over.
    unlisted.length > 0 ? "A connectionId find_tool gives you counts as on it." : "",
  ].filter(Boolean);

  return `Connected services you can reach with your tools:\n${lines.join("\n")}\n${guidance.join(" ")}`;
}

/**
 * How long a "this connection does not have that operation" fact is trusted.
 *
 * It has to expire, because it can stop being true: re-authorising a connected
 * application with broader scopes can add operations the account did not have,
 * and a permanent exclusion would hide one forever with nothing saying why. It
 * has to expire *slowly*, because the cost of being wrong the other way is a
 * step out of eight and a billed Composio 404 — see `recordUnavailableTool`.
 *
 * Thirty days is the compromise: a workspace that widens its scopes pays one
 * failed call per operation to rediscover it, once a month at worst.
 */
const UNAVAILABLE_TRUSTED_DAYS = 30;
const UNAVAILABLE_TRUSTED_MS = UNAVAILABLE_TRUSTED_DAYS * 24 * 60 * 60 * 1000;

/**
 * The entries of a connection's `unavailable_tools` bag that are still
 * trusted, with when each was recorded (NaN for a date nobody can read).
 *
 * An unparseable date is trusted rather than discarded. It means an older or
 * hand-edited bag, and the slug was still put there by a real 404.
 */
function trustedUnavailable(config: Record<string, unknown>, now: number): Array<[string, number]> {
  const raw = config.unavailable_tools;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const cutoff = now - UNAVAILABLE_TRUSTED_MS;
  const live: Array<[string, number]> = [];
  for (const [slug, at] of Object.entries(raw as Record<string, unknown>)) {
    const seen = typeof at === "string" ? Date.parse(at) : NaN;
    if (Number.isNaN(seen) || seen >= cutoff) live.push([slug, seen]);
  }
  return live;
}

/**
 * How many operations this connection is hiding, and until when — what the
 * Integrations card says so a person is not shown "connected" and nothing
 * else for a month (covan#276).
 *
 * `hiddenUntil` is when the OLDEST trusted entry expires, in epoch ms: the
 * first moment anything comes back. Null when every entry's date is
 * unreadable, which is trusted indefinitely. The whole answer is null when
 * nothing is hidden, so the card has one thing to check.
 *
 * Here rather than in the DTO because the thirty days are this file's, and a
 * second copy of the arithmetic would be free to drift from the one that
 * actually decides what `find_tool` hides.
 */
export function hiddenOperations(
  config: Record<string, unknown>,
  now: number = Date.now(),
): { count: number; hiddenUntil: number | null } | null {
  const live = trustedUnavailable(config, now);
  if (live.length === 0) return null;
  const dated = live.map(([, seen]) => seen).filter((seen) => !Number.isNaN(seen));
  return {
    count: live.length,
    hiddenUntil: dated.length > 0 ? Math.min(...dated) + UNAVAILABLE_TRUSTED_MS : null,
  };
}

/**
 * The operations this connection has already proven it cannot run.
 *
 * WHY THIS EXISTS. `find_tool` searches Composio's whole catalogue, and the
 * catalogue is the union of what every account of an application *could* have.
 * A connected account has a subset, and the only thing that knows which subset
 * is Composio's execute endpoint — it answers `404 Tool_ToolNotFound` for a
 * slug that is in the catalogue and not on the account. There is no documented
 * way to ask in advance: `/api/v3.1/tools` takes `toolkit_slug`, `tool_slugs`,
 * `auth_config_ids`, `tags`, `scopes` and `search`, and nothing that names a
 * connected account.
 *
 * So the answer is learnt rather than looked up, and this is where it is kept.
 * Twenty of the thirty `run_tool` failures ever recorded are this one thing,
 * which makes it the single largest failure class in the harness — larger than
 * every other cause combined.
 *
 * Read off `config`, which `listConnections` already selects, so filtering a
 * search costs no query at all.
 *
 * Entries past `UNAVAILABLE_TRUSTED_DAYS` are ignored rather than deleted:
 * reading is on the critical path of every search and writing is not, so the
 * expiry belongs on the cheap side. A malformed or missing bag reads as "we
 * know nothing", which is where this started.
 */
export function unavailableTools(connection: ToolConnection): Set<string> {
  return new Set(trustedUnavailable(connection.config, Date.now()).map(([slug]) => slug));
}
