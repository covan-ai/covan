/**
 * What the runner needs before it touches anything: the local stack, the way
 * CI's `rls` job exports it, and a key to embed with.
 */
const REQUIRED = [
  "SUPABASE_TEST_URL",
  "SUPABASE_TEST_ANON_KEY",
  "SUPABASE_TEST_SERVICE_ROLE_KEY",
  "OPENAI_API_KEY",
] as const;

export function missingStackVars(env: Record<string, string | undefined>): string[] {
  return REQUIRED.filter((name) => !env[name]?.trim());
}
