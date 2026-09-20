// Client mirrors of the worker's connection DTOs (worker/src/lib/dto.ts). Kept
// in their own file so api-client.ts stays a transport layer, the same
// arrangement routines-api.ts already uses.

export type ProviderId = "notion" | "google_drive";

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
