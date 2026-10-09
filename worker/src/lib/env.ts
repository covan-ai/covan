import type { Bindings } from "../types";
import { embeddingDimensions } from "./embeddings";
import { ragMinSimilarity } from "./rag";
import { lexicalSearchEnabled } from "./search-terms";

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

/** `.env.docker.example:101`, character for character. */
const DEMO_JWT_SECRET = "your-super-secret-jwt-token-with-at-least-32-characters-long";

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
/**
 * Keyed on plain strings rather than on `REQUIRED`, which is finding 9 of the
 * 2026-10-08 audit. The signing key is optional — absent means API keys are off
 * — so it is not in `REQUIRED`, and the old type made the one published default
 * that *is* a signing key impossible to list. The guard below reads
 * `source[k]`, which is the raw environment, so a key here only has to be a
 * name an operator can set.
 */
const PUBLISHED_DEFAULTS: Record<string, string> = {
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE",
  SUPABASE_SERVICE_ROLE_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q",
  ROUTINE_SECRET_KEY: "Y292YW4tbG9jYWwtZGV2LXJvdXRpbmUta2V5LTAwMDE=",
  // Both spellings of the signing key, because `loadEnv` accepts both (see
  // SUPABASE_JWT_SECRET at the foot of this file) and the shipped file sets the
  // self-hosted one. This is the value API keys are signed and verified with,
  // so holding the published default means anybody who can read GitHub can mint
  // a token for any account on the stack. `docker/check-secrets.sh` catches the
  // `JWT_SECRET` spelling too, but only when the stack is brought up through
  // docker-compose; the published image's entrypoint is `bun run src/node.ts`,
  // which runs this function and nothing else.
  JWT_SECRET: DEMO_JWT_SECRET,
  SUPABASE_JWT_SECRET: DEMO_JWT_SECRET,
};

/**
 * The shortest key worth calling a signing key.
 *
 * Same reasoning as `ROUTINE_SECRET_KEY`'s byte check, and the same reason for
 * checking it here: a key too short to sign with does not announce itself. API
 * keys mint and verify perfectly well against a guessable secret, and the first
 * person to notice is not the operator. 32 is what Supabase itself requires of
 * the same value.
 *
 * It does not subsume the published-default check above: the value
 * `.env.docker.example` ships is 60 characters long. Two different failures.
 */
const JWT_SECRET_MIN_CHARS = 32;

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
      // Worded for one as well as for several: with the signing key now on the
      // list, one offender is the likely case, and "JWT_SECRET still hold the
      // values" reads like a bug in the thing that is refusing to start.
      const several = published.length > 1;
      throw new Error(
        `Refusing to start: ${published.join(", ")} still ` +
          `${several ? "hold the values" : "holds the value"} from ` +
          `.env.docker.example. That file is in a public repository, so ` +
          `${several ? "these are" : "this is"} not ` +
          `${several ? "secrets" : "a secret"}. Regenerate ` +
          `${several ? "them" : "it"} — see docs/self-hosting.md — or set ` +
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

  // Resolved once, here, because the guard above and the check below and the
  // binding at the foot of this function all have to mean the same value.
  const jwtSecret = source.SUPABASE_JWT_SECRET || source.JWT_SECRET;
  if (jwtSecret && jwtSecret.length < JWT_SECRET_MIN_CHARS) {
    throw new Error(
      `SUPABASE_JWT_SECRET (or JWT_SECRET) is ${jwtSecret.length} characters; ` +
        `it must be at least ${JWT_SECRET_MIN_CHARS}. It is what API keys are signed ` +
        `with, and a short one is guessable. Generate one with: openssl rand -base64 32`,
    );
  }

  // Same reasoning as the key above, one step earlier: a bad retrieval number
  // does not announce itself. A wrong width surfaces as documents that upload
  // and answer nothing; a wrong floor surfaces as answers that got vaguer.
  // Both resolvers throw with the correction in the message, so the operator
  // reads it at `docker compose up` instead of inferring it a week later.
  embeddingDimensions(source);
  ragMinSimilarity(source);
  lexicalSearchEnabled(source);

  return {
    SUPABASE_URL: source.SUPABASE_URL!,
    SUPABASE_ANON_KEY: source.SUPABASE_ANON_KEY!,
    SUPABASE_SERVICE_ROLE_KEY: source.SUPABASE_SERVICE_ROLE_KEY!,
    OPENAI_API_KEY: source.OPENAI_API_KEY!,
    // Optional on purpose: absent means api.openai.com and the built-in model
    // list, which is what an operator who has not thought about it should get.
    OPENAI_BASE_URL: source.OPENAI_BASE_URL,
    OPENAI_MODEL: source.OPENAI_MODEL,
    // Optional, and deliberately not in REQUIRED: without it the Claude models
    // are simply not offered and nothing reaches Anthropic. `lib/models.ts`
    // treats its presence as the opt-in.
    ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: source.ANTHROPIC_BASE_URL,
    // Separate from the two above on purpose — `lib/openai` explains why an
    // endpoint for completions is not automatically an endpoint for documents.
    EMBEDDING_BASE_URL: source.EMBEDDING_BASE_URL,
    EMBEDDING_MODEL: source.EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS: source.EMBEDDING_DIMENSIONS,
    RAG_MIN_SIMILARITY: source.RAG_MIN_SIMILARITY,
    RAG_LEXICAL: source.RAG_LEXICAL,
    ROUTINE_SECRET_KEY: source.ROUTINE_SECRET_KEY!,
    // Optional, and absent is a supported configuration: without it a workspace
    // cannot store its own provider key at all, `PUT /workspace/provider-keys`
    // answers 501 and the interface never renders the field. Forwarded here
    // rather than left out because the Node runtime is a place somebody may
    // deliberately want the feature — a self-hoster who has registered a metered
    // entitlements implementation of their own has the same wall to offer doors
    // beside. Unlike `ROUTINE_SECRET_KEY` it is not validated at boot: it is
    // optional, and refusing to start over a key nothing may ever use would turn
    // an unused feature into an outage.
    PROVIDER_KEY_SECRET: source.PROVIDER_KEY_SECRET,
    // Composio's catalogue, on the same terms as the OAuth pairs below:
    // optional, and absent means the feature is simply not offered. This list
    // is an explicit allowlist rather than a spread of `source`, which is the
    // thing to notice when adding a variable — omit it here and every Docker
    // and Node self-host reports the feature unconfigured with no error
    // anywhere, while the Cloudflare build works fine.
    COMPOSIO_API_KEY: source.COMPOSIO_API_KEY,
    COMPOSIO_BASE_URL: source.COMPOSIO_BASE_URL,
    // The browser tool, and the takeover that recovers a login wall. Omitted
    // here until 2026-10-09, which is the failure the comment above describes
    // happening to the very next variable somebody added: `browse` reported
    // itself unconfigured on every Docker and Node self-host, with no error
    // anywhere, while the Cloudflare build worked fine. `docker-compose.yml`
    // was not passing it through either, so there were two independent
    // reasons and fixing one would have changed nothing.
    BROWSER_USE_API_KEY: source.BROWSER_USE_API_KEY,
    BROWSER_USE_BASE_URL: source.BROWSER_USE_BASE_URL,
    // Where a message from the quota wall goes, defaulting in `routes/support.ts`
    // to efe@covan.app. Forwarded for a sharper reason than the one above: that
    // route is mounted unconditionally, so without this an operator's own users
    // would be mailing us through the operator's Resend account with no way to
    // redirect it.
    SUPPORT_EMAIL: source.SUPPORT_EMAIL,
    RESEND_API_KEY: source.RESEND_API_KEY ?? "",
    RESEND_FROM: source.RESEND_FROM ?? "",
    ALLOWED_ORIGIN: source.ALLOWED_ORIGIN!,
    WORKER_HOST: source.WORKER_HOST,
    ADMIN_API_KEY: source.ADMIN_API_KEY,
    // Connected sources and the Slack app. Every one is optional, and absence
    // is a supported configuration rather than a misconfiguration: a build with
    // none of them set offers no connections and no Slack, and says so on the
    // Integrations page instead of failing at boot.
    NOTION_CLIENT_ID: source.NOTION_CLIENT_ID,
    NOTION_CLIENT_SECRET: source.NOTION_CLIENT_SECRET,
    GOOGLE_CLIENT_ID: source.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: source.GOOGLE_CLIENT_SECRET,
    SLACK_CLIENT_ID: source.SLACK_CLIENT_ID,
    SLACK_CLIENT_SECRET: source.SLACK_CLIENT_SECRET,
    SLACK_SIGNING_SECRET: source.SLACK_SIGNING_SECRET,
    // Optional, and either name works. `SUPABASE_JWT_SECRET` is what the
    // Cloudflare deployment sets; `JWT_SECRET` is what a self-hosted stack
    // already has, because GoTrue and PostgREST are configured with it in the
    // same .env. Accepting both means docker-compose gets API keys without the
    // operator having to copy a value they already set once. Absent means the
    // feature is simply off — see routes/api-keys.ts.
    SUPABASE_JWT_SECRET: jwtSecret,
    // Optional on purpose: absent means the defaults in lib/ratelimit, so a
    // stack that was never configured is still bounded. `0` turns a tier off.
    RATE_LIMIT_STANDARD_PER_MINUTE: source.RATE_LIMIT_STANDARD_PER_MINUTE,
    RATE_LIMIT_EXPENSIVE_PER_MINUTE: source.RATE_LIMIT_EXPENSIVE_PER_MINUTE,
    DOCS_DIR: source.DOCS_DIR!,
    // DOCS stays undefined: there is no R2 binding off Cloudflare, and its
    // absence is what makes getDocStore choose the filesystem.
  };
}
