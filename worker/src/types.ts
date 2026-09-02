import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { Entitlements } from "./lib/entitlements";

/**
 * Exactly what the routine engine needs to run a tick.
 *
 * This exists because the engine is deployed twice. `src/index.ts` is the API
 * Worker and gets the full `Bindings` below; `src/cron.ts` is a scheduled-only
 * Worker on a separate Cloudflare account (see wrangler.cron.toml) that is
 * given these bindings and nothing else — no anon key, no R2 bucket. Typing the
 * engine against `Bindings` would have it claim bindings that Worker genuinely
 * does not have, and the first `env.DOCS` added to the engine would fail in
 * production rather than in tsc.
 *
 * ALLOWED_ORIGIN is here despite the cron Worker serving no HTTP: the SSRF
 * guard uses it to refuse routines pointed back at our own frontend.
 */
export type RoutineEnv = {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OPENAI_API_KEY: string;
  /**
   * Where completions go. Unset means api.openai.com; set it to any
   * OpenAI-compatible endpoint (Ollama, vLLM, LiteLLM, OpenRouter) to keep the
   * conversation on infrastructure you control. Transcription is not routed
   * through it, and embeddings have a variable of their own — see `lib/openai`
   * for why they are two decisions rather than one.
   */
  OPENAI_BASE_URL?: string;
  /**
   * Forces one model for every completion, ignoring the per-agent picker.
   * Needed with OPENAI_BASE_URL because `lib/models` allowlists OpenAI's
   * catalogue, and a local endpoint serves names that are not in it.
   */
  OPENAI_MODEL?: string;
  /** base64 32-byte AES-GCM key for delivery_channels.secret_ciphertext. */
  ROUTINE_SECRET_KEY: string;
  RESEND_API_KEY: string;
  /** Verified sender, e.g. "Routines <routines@yourdomain.com>". */
  RESEND_FROM: string;
  ALLOWED_ORIGIN: string;
  /** This worker's own domain, once a custom domain fronts it (unset on workers.dev). */
  WORKER_HOST?: string;
  /**
   * Monthly token allowance per user. Unset means unmetered, which is what a
   * self-hosted Covan is: the operator brings their own OPENAI_API_KEY and
   * decides what to spend on it. A hosted deployment sets this and registers a
   * metering implementation — see `lib/entitlements`. Declared here, in the
   * shared type, because shared code checks for its presence to catch a hosted
   * deploy that forgot to register one.
   */
  QUOTA_MONTHLY_TOKENS?: string;
};

/**
 * What the connection engine needs, which is strictly more than the routine
 * engine and strictly less than the API.
 *
 * A sync writes documents: it embeds text and puts bytes in the document store,
 * so it needs the embedding configuration and one of the two storage bindings —
 * neither of which the routine engine has ever touched. Naming that as its own
 * type is what lets `cron.ts` stay honest. That Worker is deployed to a second
 * Cloudflare account with `RoutineEnv` and nothing else; it can now be given
 * these bindings as well, and `canSyncConnections` below is how it asks whether
 * it was, rather than claiming them in a type and finding out in production.
 */
export type SyncEnv = RoutineEnv & {
  /**
   * Where document embeddings go. Unset means api.openai.com, which is also
   * what `OPENAI_BASE_URL` on its own leaves them at — the two do not inherit
   * from each other, deliberately (`lib/openai`).
   */
  EMBEDDING_BASE_URL?: string;
  /** Unset means `text-embedding-3-small`. Set it whenever the endpoint is. */
  EMBEDDING_MODEL?: string;
  /**
   * The width of `document_chunks.embedding`. Unset means 1536, which is what
   * migration 0004 declares. Changing this without changing the column — or the
   * other way round — is caught at the first embedding call rather than at the
   * insert; see `lib/embeddings`.
   */
  EMBEDDING_DIMENSIONS?: string;
  /** The R2 bucket, on Cloudflare only. Absent on the Node/Docker runtime. */
  DOCS?: R2Bucket;
  /** Filesystem document root, on the Node runtime only. Absent on Cloudflare. */
  DOCS_DIR?: string;
  /**
   * OAuth client credentials, one pair per connectable source. Every one is
   * optional and absence is a supported configuration: a deployment that sets
   * none simply offers no connections, and the Integrations page says which
   * variables would turn each one on rather than hiding it.
   */
  NOTION_CLIENT_ID?: string;
  NOTION_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

/**
 * Whether this environment can actually run a sync.
 *
 * The document store is the discriminator, for the same reason it is in
 * `getDocStore`: it is the one binding that has no default and no fallback. A
 * cron Worker deployed without it should say so once per tick and skip, not
 * fail every connection in the workspace and pause them all.
 */
export function canSyncConnections(env: RoutineEnv): env is SyncEnv {
  const candidate = env as SyncEnv;
  return Boolean(candidate.DOCS || candidate.DOCS_DIR);
}

/**
 * Bindings + secrets available to the API Worker, across both runtimes it
 * ships on. Secrets (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * OPENAI_API_KEY, ROUTINE_SECRET_KEY) are set via `wrangler secret put` on
 * Cloudflare. ALLOWED_ORIGIN is a plain var. Document storage is either DOCS
 * (the R2 bucket binding, Cloudflare only) or DOCS_DIR (a filesystem root,
 * Node/Docker only) — see `getDocStore` in `lib/docstore`, the only place that
 * reads either. ADMIN_API_KEY (optional) gates the /admin/backfill-embeddings
 * maintenance endpoint; when unset the endpoint fails closed.
 */
export type Bindings = SyncEnv & {
  SUPABASE_ANON_KEY: string;
  /**
   * The cosine-similarity floor below which a retrieved chunk is dropped as
   * irrelevant. Unset means 0.25, which is tuned against
   * `text-embedding-3-small` — an operator who changes the embedding model
   * needs their own floor, because a wrong one does not break retrieval, it
   * quietly makes it worse.
   */
  RAG_MIN_SIMILARITY?: string;
  /**
   * The project's JWT signing secret, and the one thing that makes API keys
   * possible: a key is exchanged for a short-lived JWT for its owner, so the
   * request reaches Postgres as that person and RLS decides as it always does.
   * See `lib/api-keys.ts`.
   *
   * Optional, and its absence is a supported configuration rather than a
   * misconfiguration — a deployment that never sets it simply has no API keys,
   * and says so instead of failing. On Cloudflare: `wrangler secret put
   * SUPABASE_JWT_SECRET`. On a self-hosted stack it is the same `JWT_SECRET` the
   * rest of the compose file already uses, which is why `lib/env.ts` accepts
   * either name.
   */
  SUPABASE_JWT_SECRET?: string;
  ADMIN_API_KEY?: string;
  /**
   * The Slack app this deployment owns. All three or none: a client pair with
   * no signing secret could install and then reject every event it was sent,
   * which is the configuration mistake that looks like a Slack outage.
   *
   * On `Bindings` rather than `SyncEnv` because Slack is a surface, not a
   * source — it is served by the API Worker and there is nothing for a cron
   * tick to do with it.
   */
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  SLACK_SIGNING_SECRET?: string;
  /**
   * Rate limiting, on Cloudflare only — `[[ratelimits]]` in wrangler.toml.
   * Their presence is what makes `getRateLimiter` use the edge counter instead
   * of the in-process one, the same way `DOCS` chooses R2 over the filesystem.
   * Absent on Node, where the two variables below configure the fallback.
   */
  RATE_LIMIT_STANDARD?: RateLimit;
  RATE_LIMIT_EXPENSIVE?: RateLimit;
  /**
   * Requests per minute on the Node runtime. Unset takes the defaults in
   * `lib/ratelimit/types.ts`; `0` disables that tier, which is what an operator
   * who limits in nginx or Cloudflare in front of this should set rather than
   * running two limiters that disagree.
   */
  RATE_LIMIT_STANDARD_PER_MINUTE?: string;
  RATE_LIMIT_EXPENSIVE_PER_MINUTE?: string;
};

/**
 * Per-request context set by middleware.
 * `db` is a request-scoped Supabase client carrying the caller's bearer token,
 * so Postgres RLS (`auth.uid()`) resolves to the authenticated user.
 */
export type Variables = {
  user: User;
  db: SupabaseClient;
  /** What this caller may spend. Unmetered unless a hosted build says otherwise. */
  entitlements: Entitlements;
  /**
   * Set only when the caller proved themselves with an API key rather than a
   * browser session. Routes read it to refuse the things a key must not do —
   * chiefly creating another key, which would make revocation meaningless.
   */
  apiKeyId?: string;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
