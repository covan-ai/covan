// Client mirrors of the worker's connection DTOs (worker/src/lib/dto.ts). Kept
// in their own file so api-client.ts stays a transport layer, the same
// arrangement routines-api.ts already uses.

export type ProviderId = "notion" | "google_drive";

/**
 * A service an agent can CALL, as opposed to a source it reads documents from.
 *
 * The two are next to each other on one screen and are not the same thing, so
 * it is worth saying which is which. A `Connection` above syncs files into a
 * bundle and the agent never talks to it. A `ToolConnection` is a database or
 * an API the agent reaches at question time, through the general tools in the
 * worker's harness — and adding one is this form rather than a release, which
 * is the whole design (worker/src/lib/harness/registry.ts).
 *
 * There is no credential on this type and there is none on the wire either:
 * migration 0059 grants `secret_ciphertext` to no client role at all.
 */
export type ToolConnection = {
  id: string;
  label: string;
  /**
   * `sql` speaks to a Postgres through PostgREST; `http` to any REST API;
   * `supabase` to one project of a connected Supabase account, through that
   * account's own token and with nothing installed in the project; `composio`
   * to one of about fifteen hundred applications, through an OAuth grant that
   * lives at Composio and never reaches Covan.
   */
  transport: "http" | "sql" | "supabase" | "composio";
  baseUrl: string;
  /**
   * The HTTP methods a person allowed. Not advisory — the worker refuses
   * anything not on this list before it builds a URL, and the default is GET
   * alone.
   */
  allowedMethods: string[];
  /** What the agent is told this service holds. Cached, and refreshable. */
  summary: string | null;
  /** The read-only function a `sql` connection speaks through. */
  rpc: string | null;
  /**
   * The Supabase account this project borrows its token from, or null for
   * every other kind. The page groups by it, so a person can see what
   * disconnecting the account would take with it.
   */
  accountId: string | null;
  /** The Supabase project ref, for a `supabase` connection. */
  projectRef: string | null;
  /**
   * The application a `composio` connection connects — `gmail`, `linear`.
   *
   * There is no account reference on this type and none on the wire either:
   * migration 0063 grants `connected_account_id` to no client role, for the
   * same reason 0059 withholds a credential. One deployment-wide API key opens
   * every workspace's accounts, so that id is the boundary.
   */
  toolkitSlug: string | null;
  /**
   * `pending` while somebody is away at a consent screen. Every transport but
   * `composio` is born `active`, so this is only ever interesting on one card.
   */
  status: "pending" | "active" | "failed";
  createdAt: number;
};

/** One of the applications this deployment's catalogue can offer. */
export type ComposioToolkit = {
  slug: string;
  name: string;
  description: string;
  authSchemes: string[];
};

export type ComposioToolkitsResponse = {
  /**
   * False when the operator has not set `COMPOSIO_API_KEY`. The section is
   * still shown and names the variable, for the reason `ProviderAvailability`
   * is shown unconfigured: a self-hoster reading the docs for a feature their
   * own build appears not to have is the failure that pattern exists to avoid.
   */
  configured: boolean;
  toolkits: ComposioToolkit[];
};

/**
 * What one agent may do at one connected service, without being asked.
 *
 * There is no `never` here because there is none in the table: the absence of a
 * row IS the default, and for a connected application that default is `ask`.
 * So a card lists what it has rows for and says "asks first" about the rest,
 * which is true whether or not a row exists to say it.
 */
export type ToolConnectionGrant = {
  agentId: string;
  connectionId: string;
  slug: string;
  mode: "ask" | "always";
  grantedBy: string | null;
  grantedAt: number;
};

/**
 * The connection and operation a confirmation is about, when it is about one.
 *
 * Lives here rather than in `agent-steps.tsx` on purpose. That card's own
 * comment says it knows nothing about scheduling or email and prints whatever
 * a tool proposed, and a second exception for connected apps would be the
 * start of a card that knows about every tool. So the card takes an optional
 * standing-permission action and the CALLER decides whether there is one to
 * offer; this is how the caller decides.
 *
 * `null` for every other tool's proposal, and for a malformed one — a standing
 * permission written from a half-read object would name an operation nobody
 * approved.
 */
export function runToolProposal(
  proposal: unknown,
): { connectionId: string; connectionLabel: string; slug: string } | null {
  if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return null;
  const row = proposal as Record<string, unknown>;
  if (row.kind !== "run_tool") return null;
  const connection = row.connection as Record<string, unknown> | undefined;
  const connectionId = typeof connection?.id === "string" ? connection.id : "";
  const slug = typeof row.slug === "string" ? row.slug : "";
  if (!connectionId || !slug) return null;
  return {
    connectionId,
    connectionLabel: typeof connection?.label === "string" ? connection.label : "this service",
    slug,
  };
}

/**
 * A Supabase account connected to this workspace.
 *
 * There is no token on this type and none on the wire: migration 0061 grants
 * the column to no client role. `tokenHint` is four characters and exists so
 * an admin can tell two tokens apart without being shown either.
 */
export type SupabaseAccount = {
  id: string;
  tokenHint: string;
  /** The user id of whoever pasted it, or null once they close their account. */
  connectedBy: string | null;
  createdAt: number;
};

/** One project the connected account can see, as the picker lists it. */
export type SupabaseProject = {
  ref: string;
  name: string;
  region: string;
  /** Supabase's own word for it — a paused project is worth saying out loud. */
  status: string;
};

export type SupabaseAccountResponse = { account: SupabaseAccount | null };

export type SupabaseProjectsResponse = { projects: SupabaseProject[] };

/** One tool this build has, and whether this deployment can run it. */
export type ToolAvailability = {
  name: string;
  description: string;
  /** Whether it changes anything outside Covan. Shown, because it matters. */
  destructive: boolean;
  configured: boolean;
};

export type ToolConnectionsResponse = {
  connections: ToolConnection[];
  tools: ToolAvailability[];
};

/** A source this deployment can offer, and whether it has been given the keys. */
export type ProviderAvailability = {
  id: ProviderId;
  label: string;
  /**
   * False when the operator has not set the provider's client credentials. The
   * row is still shown — hiding it would leave a self-hoster reading the docs
   * for a feature their own build appears not to have.
   */
  configured: boolean;
};

/**
 * Why the engine paused a connection. Mirrors migration 0057's CHECK.
 *
 * `access_narrowed` is the one that is not a fault: the source suddenly shows
 * far less than it did, which is what a reconnect with a narrower grant looks
 * like from the engine's side. Nothing was removed and somebody is being asked.
 */
export type ConnectionPausedCode =
  | "needs_folder"
  | "owner_left"
  | "owner_gone"
  | "grant_revoked"
  | "repeated_failures"
  | "provider_unconfigured"
  | "unknown_provider"
  | "access_narrowed"
  | "restored";

export type Connection = {
  id: string;
  provider: ProviderId;
  /** The external account: a Notion workspace name, a Google address. */
  accountLabel: string;
  bundleId: string;
  bundleName: string | null;
  /**
   * The grant holder: whose OAuth grant this carries and whose view of the
   * source decides what syncs. Null once they have closed their account — the
   * workspace owns the connection, which is what lets it outlive them.
   */
  userId: string | null;
  status: "active" | "paused";
  /** Why it stopped, in a sentence. Set by the engine, cleared on resume. */
  pausedReason: string | null;
  /**
   * Why it stopped, as something to branch on. Null when a person pressed
   * Pause, which needs no explanation.
   *
   * The screen decides between Resume and Reconnect from this rather than from
   * the sentence beside it — a revoked grant needs a new one, and resuming it
   * would simply fail again and pause it a second time.
   */
  pausedCode: ConnectionPausedCode | null;
  /**
   * A Drive connection between the grant and the folder picker. A step rather
   * than a fault, which is why it is not `pausedReason`.
   */
  needsFolder: boolean;
  folderName: string | null;
  syncIntervalMinutes: number;
  nextSyncAt: number | null;
  lastSyncAt: number | null;
  documentCount: number;
  createdAt: number;
};

/** `skipped` means "looked, nothing had changed" — it is not a failure. */
export type ConnectionRun = {
  id: string;
  status: "ok" | "skipped" | "failed";
  added: number;
  updated: number;
  removed: number;
  error: string | null;
  durationMs: number | null;
  startedAt: number;
};

export type ConnectionsResponse = {
  connections: Connection[];
  providers: ProviderAvailability[];
};

export type DriveFolder = { id: string; name: string };

export type SyncOutcome = {
  status: "ok" | "skipped" | "failed";
  added: number;
  updated: number;
  removed: number;
  /** True when the run stopped at its ceiling with work left to do. */
  more: boolean;
};

export type SlackState = {
  /** Whether this deployment has a Slack app at all. */
  configured: boolean;
  installation: {
    id: string;
    teamName: string;
    /** Which agent answers. Null when the chosen one was deleted. */
    agentId: string | null;
    installedBy: string;
    createdAt: number;
  } | null;
};

/**
 * What the callback reports back through the URL, turned into a sentence.
 *
 * The API cannot say it itself: a browser coming back from a consent screen is
 * mid-redirect, and the only thing that survives is a query parameter. Anything
 * unrecognised falls through to the raw code rather than being swallowed —
 * a provider can invent an error string at any time, and showing it is more
 * use than "something went wrong".
 */
export const CONNECT_ERRORS: Record<string, string> = {
  cancelled: "You cancelled that before granting access. Nothing was connected.",
  expired: "That took longer than ten minutes, so the request expired. Try again.",
  missing_code: "The provider sent us back without an authorisation code. Try again.",
  unavailable: "This deployment is not configured for that provider.",
  not_a_member: "You are no longer a member of that workspace.",
  read_only: "Your role in this workspace is read-only, so you cannot connect a source.",
  admin_only: "Only a workspace admin can install the Slack app.",
  bundle_gone: "The bundle you were connecting to no longer exists.",
  grant_failed: "The provider refused the grant. Try connecting again.",
  exchange_failed: "We could not complete the exchange with the provider. Try again.",
  save_failed: "The grant worked but we could not save it. Try again.",
  connection_gone:
    "The connection you were reconnecting has been removed, or moved to another workspace. " +
    "Nothing was changed — connect the source again to start over.",
  wrong_provider:
    "That grant is for a different provider than the connection you were reconnecting. " +
    "Nothing was changed.",
};

export function connectErrorMessage(code: string): string {
  return CONNECT_ERRORS[code] ?? `The connection failed: ${code}`;
}
