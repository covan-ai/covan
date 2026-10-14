/**
 * The one thing an API key may not do, in the one place that says why.
 *
 * A key is not a scope list. It is a way to *become* the person who owns it:
 * everything it reaches, it reaches as them, and RLS decides the rest. That is
 * the whole design, and it is why this rule is one sentence wide rather than a
 * second permission system living beside the database.
 *
 * The sentence: a key may not create access that survives its own revocation.
 * Revoking a leaked key has to be the end of the incident, and each of these
 * would make it the middle of one.
 *
 * - **Minting a key** (`routes/api-keys.ts`). A key that writes successors
 *   cannot be revoked: the moment one leaks it makes more, and revoking the
 *   original leaves every child working.
 * - **Revoking a key** (`routes/api-keys.ts`). The same leak pointed the other
 *   way — a leaked key taking down the keys somebody was still relying on.
 * - **Closing the account** (`routes/account.ts`). Destroys the evidence and
 *   the account in one call, and no revocation afterwards undoes it.
 * - **Membership.** Inviting, revoking an invitation, accepting one, changing
 *   a role, removing somebody, leaving, creating a workspace and switching
 *   into another. An admin's key inviting an admin produces a second person
 *   with their own session; a key that joins or creates a workspace reaches
 *   past the one it belongs to. None of it is undone by revoking the key.
 * - **Third parties.** Starting or re-granting an OAuth connection, choosing
 *   what a Drive connection imports, connecting a Composio application or
 *   letting an agent act in one, installing Slack, storing a service
 *   credential, rotating a webhook's signing secret. Each ends in a token or a
 *   secret held somewhere a revocation here cannot reach.
 * - **The owner's browser.** A live view of it carries their signed-in
 *   cookies, and a saved login signs an agent in as them on every later run.
 *
 * Membership and role changes were missing until finding 7 of the 2026-10-08
 * audit, and the third parties until later. Both times the route
 * that forgot behaved identically for a key and a session, so nothing noticed.
 * `worker/src/api-key-refusal.static.test.ts` now sorts EVERY authenticated
 * handler into "refused" or "open to a key", so a new route cannot be added
 * without that decision being written down.
 *
 * What a key may still start that runs on after the request -- a routine, a
 * delivery channel, an ingest trigger -- is written onto by the key's id and
 * stopped when the key is revoked. See `apiKeyIdOf` below.
 *
 * `what` completes "api keys cannot ___ — sign in to do this", so it reads as
 * the verb phrase the caller just attempted.
 */
export function refuseIfKeyAuthenticated(
  c: { get: (k: "apiKeyId") => string | undefined },
  what: string,
) {
  return c.get("apiKeyId")
    ? ({ error: `api keys cannot ${what} — sign in to do this` } as const)
    : null;
}

/**
 * The key this request was made with, to write onto what it starts, or null
 * for a browser session.
 *
 * For the rows the API creates with the service role on a caller's behalf --
 * a delivery channel, a webhook trigger -- which therefore cannot pick the key
 * up from the token the way a routine does (0088). Revoking the key disables
 * the channel and deletes the trigger, so a key that sets up a webhook leaves
 * nothing behind that still delivers once it is gone.
 */
export function apiKeyIdOf(c: { get: (k: "apiKeyId") => string | undefined }): string | null {
  return c.get("apiKeyId") ?? null;
}
