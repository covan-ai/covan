/**
 * Maps a Postgres write error to the HTTP status it should surface as.
 *
 * Two codes mean "this caller sent something the database refuses", and they
 * arrive by different routes:
 *
 *   - `42501` (insufficient_privilege) is a policy refusal.
 *     `routines_insert_own` and `routines_update_own` require the delivery
 *     channel to be the caller's, the agent to belong to the routine's
 *     workspace, and — since 0056 — the output bundle to be one in that same
 *     workspace. Any of those failing is a bad request, not a server fault.
 *   - `23514` (check_violation) is a CHECK constraint. 0055's
 *     `routines_webhook_needs_no_source_check` refuses a webhook trigger on a
 *     routine that watches something, and 0056's bounds the output retention.
 *     Both describe what the caller asked for.
 *
 * Anything else — a broken connection, a missing table, a foreign key the API
 * should have caught — is a genuine server failure and stays a 500.
 */
export function insertErrorStatus(error: { code?: string | null } | null | undefined): 400 | 500 {
  return error?.code === "42501" || error?.code === "23514" ? 400 : 500;
}
