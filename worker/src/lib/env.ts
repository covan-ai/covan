import type { Bindings } from "../types";
import { embeddingDimensions } from "./embeddings";
import { ragMinSimilarity } from "./rag";

/** Absent or empty means unset — a blank line in a .env file is not a value. */
const REQUIRED = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
  "ROUTINE_SECRET_KEY",
  "ALLOWED_ORIGIN",
  "DOCS_DIR",
] as const;

/**
 * The values `.env.docker.example` ships. That file is tracked in a public
 * repository and the quickstart copies it verbatim, so every one of these is
 * known to anyone who can read GitHub — and every one of them works: the demo
 * JWTs verify against the shipped JWT_SECRET and do not expire until
 * 2027-01-09, and the routine key decodes to a valid 32-byte AES-GCM key.
 *
 * They are correct for a laptop and catastrophic anywhere else, which is why
 * the check below keys off the origin rather than off a NODE_ENV nobody sets.
 */
const PUBLISHED_DEFAULTS: Partial<Record<(typeof REQUIRED)[number], string>> = {
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE",
  SUPABASE_SERVICE_ROLE_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q",
  ROUTINE_SECRET_KEY: "Y292YW4tbG9jYWwtZGV2LXJvdXRpbmUta2V5LTAwMDE=",
};

/** A stack whose frontend is on localhost is a laptop, not a deployment. */
function servesLocalhostOnly(allowedOrigin: string): boolean {
  return allowedOrigin
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean)
    .every((o) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(o));
}

/** Byte length of a base64 string, or -1 if it is not base64 at all. */
function base64Bytes(value: string): number {
  try {
    return atob(value).length;
  } catch {
    return -1;
  }
}

/**
 * Build the same `Bindings` shape Cloudflare injects, from `process.env`.
 *
 * Reports every missing variable in one message. A first-run operator who is
 * told about one missing key at a time restarts the stack five times.
 */
export function loadEnv(source: Record<string, string | undefined> = process.env): Bindings {
  const missing = REQUIRED.filter((k) => !source[k]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        `See .env.example and docs/self-hosting.md.`,
    );
  }

  if (!servesLocalhostOnly(source.ALLOWED_ORIGIN!)) {
    const published = Object.entries(PUBLISHED_DEFAULTS)
      .filter(([k, v]) => source[k] === v)
      .map(([k]) => k);
    if (published.length > 0) {
      throw new Error(
        `Refusing to start: ${published.join(", ")} still hold the values from ` +
          `.env.docker.example. That file is in a public repository, so these are ` +
          `not secrets. Regenerate them — see docs/self-hosting.md — or set ` +
          `ALLOWED_ORIGIN to a localhost URL if this really is a local stack.`,
      );
    }
  }

  // Checked here rather than at first use: encryptSecret is called the first
  // time somebody saves a delivery channel, which is a bad moment to discover
  // the key was never valid.
  const keyBytes = base64Bytes(source.ROUTINE_SECRET_KEY!);
  if (![16, 24, 32].includes(keyBytes)) {
    throw new Error(
      `ROUTINE_SECRET_KEY must be base64 that decodes to 16, 24 or 32 bytes ` +
        `(got ${keyBytes < 0 ? "invalid base64" : `${keyBytes} bytes`}). ` +
        `Generate one with: openssl rand -base64 32`,
    );
  }

  // Same reasoning as the key above, one step earlier: a bad retrieval number
  // does not announce itself. A wrong width surfaces as documents that upload
  // and answer nothing; a wrong floor surfaces as answers that got vaguer.
  // Both resolvers throw with the correction in the message, so the operator
  // reads it at `docker compose up` instead of inferring it a week later.
  embeddingDimensions(source);
  ragMinSimilarity(source);

  return {
    SUPABASE_URL: source.SUPABASE_URL!,
    SUPABASE_ANON_KEY: source.SUPABASE_ANON_KEY!,
    SUPABASE_SERVICE_ROLE_KEY: source.SUPABASE_SERVICE_ROLE_KEY!,
    OPENAI_API_KEY: source.OPENAI_API_KEY!,
    // Optional on purpose: absent means api.openai.com and the built-in model
    // list, which is what an operator who has not thought about it should get.
    OPENAI_BASE_URL: source.OPENAI_BASE_URL,
    OPENAI_MODEL: source.OPENAI_MODEL,
    // Separate from the two above on purpose — `lib/openai` explains why an
    // endpoint for completions is not automatically an endpoint for documents.
    EMBEDDING_BASE_URL: source.EMBEDDING_BASE_URL,
    EMBEDDING_MODEL: source.EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS: source.EMBEDDING_DIMENSIONS,
    RAG_MIN_SIMILARITY: source.RAG_MIN_SIMILARITY,
    ROUTINE_SECRET_KEY: source.ROUTINE_SECRET_KEY!,
    RESEND_API_KEY: source.RESEND_API_KEY ?? "",
    RESEND_FROM: source.RESEND_FROM ?? "",
    ALLOWED_ORIGIN: source.ALLOWED_ORIGIN!,
    WORKER_HOST: source.WORKER_HOST,
    ADMIN_API_KEY: source.ADMIN_API_KEY,
    // Optional, and either name works. `SUPABASE_JWT_SECRET` is what the
    // Cloudflare deployment sets; `JWT_SECRET` is what a self-hosted stack
    // already has, because GoTrue and PostgREST are configured with it in the
    // same .env. Accepting both means docker-compose gets API keys without the
    // operator having to copy a value they already set once. Absent means the
    // feature is simply off — see routes/api-keys.ts.
    SUPABASE_JWT_SECRET: source.SUPABASE_JWT_SECRET || source.JWT_SECRET,
    // Optional on purpose: absent means the defaults in lib/ratelimit, so a
    // stack that was never configured is still bounded. `0` turns a tier off.
    RATE_LIMIT_STANDARD_PER_MINUTE: source.RATE_LIMIT_STANDARD_PER_MINUTE,
    RATE_LIMIT_EXPENSIVE_PER_MINUTE: source.RATE_LIMIT_EXPENSIVE_PER_MINUTE,
    DOCS_DIR: source.DOCS_DIR!,
    // DOCS stays undefined: there is no R2 binding off Cloudflare, and its
    // absence is what makes getDocStore choose the filesystem.
  };
}
