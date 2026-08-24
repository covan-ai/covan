import type { Bindings } from "../types";

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

  return {
    SUPABASE_URL: source.SUPABASE_URL!,
    SUPABASE_ANON_KEY: source.SUPABASE_ANON_KEY!,
    SUPABASE_SERVICE_ROLE_KEY: source.SUPABASE_SERVICE_ROLE_KEY!,
    OPENAI_API_KEY: source.OPENAI_API_KEY!,
    // Optional on purpose: absent means api.openai.com and the built-in model
    // list, which is what an operator who has not thought about it should get.
    OPENAI_BASE_URL: source.OPENAI_BASE_URL,
    OPENAI_MODEL: source.OPENAI_MODEL,
    ROUTINE_SECRET_KEY: source.ROUTINE_SECRET_KEY!,
    RESEND_API_KEY: source.RESEND_API_KEY ?? "",
    RESEND_FROM: source.RESEND_FROM ?? "",
    ALLOWED_ORIGIN: source.ALLOWED_ORIGIN!,
    WORKER_HOST: source.WORKER_HOST,
    ADMIN_API_KEY: source.ADMIN_API_KEY,
    DOCS_DIR: source.DOCS_DIR!,
    // DOCS stays undefined: there is no R2 binding off Cloudflare, and its
    // absence is what makes getDocStore choose the filesystem.
  };
}
