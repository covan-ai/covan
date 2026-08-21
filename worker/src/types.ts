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
 * Bindings + secrets available to the API Worker, across both runtimes it
 * ships on. Secrets (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
 * OPENAI_API_KEY, ROUTINE_SECRET_KEY) are set via `wrangler secret put` on
 * Cloudflare. ALLOWED_ORIGIN is a plain var. Document storage is either DOCS
 * (the R2 bucket binding, Cloudflare only) or DOCS_DIR (a filesystem root,
 * Node/Docker only) — see `getDocStore` in `lib/docstore`, the only place that
 * reads either. ADMIN_API_KEY (optional) gates the /admin/backfill-embeddings
 * maintenance endpoint; when unset the endpoint fails closed.
 */
export type Bindings = RoutineEnv & {
  SUPABASE_ANON_KEY: string;
  /** The R2 bucket, on Cloudflare only. Absent on the Node/Docker runtime. */
  DOCS?: R2Bucket;
  /** Filesystem document root, on the Node runtime only. Absent on Cloudflare. */
  DOCS_DIR?: string;
  ADMIN_API_KEY?: string;
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
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: Variables;
};
