/**
 * Maps a Postgres insert error to the HTTP status it should surface as.
 *
 * `routines_insert_own`'s WITH CHECK requires the delivery channel to be
 * owned by the caller and the agent to belong to the routine's workspace.
 * Either mismatch fails as an RLS/permission violation — Postgres code
 * `42501` (insufficient_privilege) — which is a bad request from this
 * caller, not a server error. Anything else is a genuine server failure.
 */
export function insertErrorStatus(error: { code?: string | null } | null | undefined): 400 | 500 {
  return error?.code === "42501" ? 400 : 500;
}
