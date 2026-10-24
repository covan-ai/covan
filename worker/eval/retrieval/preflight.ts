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

/**
 * Why one case's retrieval cannot be scored, or null when it can.
 *
 * `retrieveForAgent` keeps a turn going whatever breaks, so both of these come
 * back as an empty list — which the benchmark would score as a search that
 * found nothing. The corpus is known to be there, so neither is a result.
 */
export function invalidRetrieval(
  r: { failed: boolean; docNames: string[] },
  caseId: string,
): string | null {
  if (r.failed) {
    return (
      `retrieval failed on case ${caseId}; the run is not valid. ` +
      `The most common cause is the embedding key or its credit — see the error logged above.`
    );
  }
  if (r.docNames.length === 0) {
    return `retrieval saw no documents on case ${caseId}; the corpus did not reach the agent.`;
  }
  return null;
}
