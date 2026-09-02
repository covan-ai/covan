/**
 * The client credentials a deployment registers with each provider.
 *
 * Its own type rather than `Bindings`, for the reason `EmbeddingConfig` is its
 * own type: a provider needs four optional strings, and taking the whole
 * environment would let it reach the service-role key it has no business
 * holding. All four are optional because a build with none of them set is a
 * supported configuration — it simply offers no connections and says so.
 */
export type ProviderEnv = {
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

/** The providers a connection can be. Mirrors the check constraint in 0039. */
export type ProviderId = "notion" | "google_drive";

/**
 * What we hold on somebody's behalf after they finish an OAuth flow.
 *
 * Stored as JSON inside `connections.secret_ciphertext`, so the whole envelope
 * is one encrypted column rather than three — a refresh token is exactly as
 * sensitive as an access token, and splitting them would invite a schema where
 * one of them is readable.
 *
 * `refreshToken` and `expiresAt` are both optional because Notion issues
 * neither: its tokens do not expire. Google issues both, and only issues a
 * refresh token on the *first* grant — see `google-drive.ts`.
 */
export type TokenEnvelope = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds. Absent means "does not expire". */
  expiresAt?: number;
};

/** One file as the source describes it, before anything has been read. */
export type RemoteFile = {
  /** The provider's own id. Stable across renames, which is why it is the key. */
  externalId: string;
  /**
   * What it will be called in the bundle, extension included.
   *
   * The extension is not decoration: `lib/extract` reads it on reindex, and the
   * download endpoint serves it as a filename. A Notion page becomes `.md`, a
   * Sheet becomes `.csv`, and a plain file keeps whatever it already had.
   */
  name: string;
  /**
   * Whatever the provider calls "this version" — Drive's `modifiedTime`,
   * Notion's `last_edited_time`. Compared as an opaque string: the sync asks
   * "different from the one I stored?" and never "newer than".
   */
  version: string;
  /** A link to the original, so a citation can open the source document. */
  url: string | null;
};

/** What a provider needs to talk to its API on one connection's behalf. */
export type ProviderContext = {
  token: TokenEnvelope;
  /** `connections.config` — the Drive folder, or {} for Notion. */
  config: Record<string, unknown>;
  fetchImpl: typeof fetch;
};

/**
 * A source of documents.
 *
 * Deliberately small, and deliberately not a search interface. Everything a
 * provider does is: send somebody to an authorization page, turn the code they
 * come back with into a token, list what it can see, and read one file as text.
 * Retrieval, chunking, embedding, citation and permission all happen after this
 * boundary, in exactly the code that already handles uploads — which is the
 * reason a connector cannot introduce a second, subtly different answer to
 * "who is allowed to read this".
 */
export interface ConnectionProvider {
  id: ProviderId;
  /** What the interface calls it. */
  label: string;

  /** Whether this deployment has the client credentials to offer it at all. */
  isConfigured(env: ProviderEnv): boolean;

  /** Where to send the browser to start the grant. */
  authorizeUrl(env: ProviderEnv, state: string, redirectUri: string): string;

  /**
   * Turn the code from the callback into a stored connection.
   *
   * `config` is whatever scope the provider settled during the flow — Notion
   * returns {} because its own picker decided, Drive returns the folder.
   */
  exchangeCode(
    env: ProviderEnv,
    code: string,
    redirectUri: string,
    fetchImpl: typeof fetch,
  ): Promise<{
    token: TokenEnvelope;
    accountLabel: string;
    config: Record<string, unknown>;
  }>;

  /**
   * Refresh the token if it is about to expire, or return it unchanged.
   *
   * Returning the same object means "nothing to store". The sync compares by
   * access token, so a provider that never refreshes needs no special case.
   */
  refresh(env: ProviderEnv, token: TokenEnvelope, fetchImpl: typeof fetch): Promise<TokenEnvelope>;

  /**
   * Everything the connection can currently see.
   *
   * A full listing rather than a changes feed, because the removals are the
   * half a changes feed gets wrong: a document deleted at the source has to
   * stop grounding answers here, and "what changed" never mentions it.
   */
  listFiles(ctx: ProviderContext): Promise<RemoteFile[]>;

  /** One file, as indexable plain text. */
  readFile(ctx: ProviderContext, file: RemoteFile): Promise<string>;
}

/**
 * A provider failure worth telling the person about, as opposed to a bug.
 *
 * `retryable` is what separates "Notion is having a bad afternoon" from "this
 * grant was revoked". The first is left alone to succeed on the next tick; the
 * second pauses the connection, because retrying a revoked token every six
 * hours forever is how an integration becomes a log nobody reads.
 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
  }
}

/**
 * Turn an HTTP response from a provider into the right kind of failure.
 *
 * 401 and 403 are the grant being gone — revoked in the provider's own
 * interface, or an admin removing the app — and no number of retries fixes
 * either. 429 and 5xx are weather.
 */
export function errorForStatus(provider: string, status: number, body: string): ProviderError {
  const detail = body.slice(0, 200).replace(/\s+/g, " ").trim();
  if (status === 401 || status === 403) {
    return new ProviderError(
      `${provider} refused the connection (HTTP ${status}). The access it was given has been ` +
        `revoked or has expired — reconnect it to continue.${detail ? ` ${detail}` : ""}`,
      false,
    );
  }
  return new ProviderError(
    `${provider} returned HTTP ${status}${detail ? `: ${detail}` : ""}`,
    status === 429 || status >= 500,
  );
}
