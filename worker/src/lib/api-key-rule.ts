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
 * - **Inviting somebody** (`routes/invitations.ts`). An admin's key may invite
 *   an admin, and what comes back is a second person with their own session —
 *   access in a third party's hands that revoking the key does not touch.
 * - **Changing a member's role** (`routes/workspace.ts`). The same thing done
 *   to somebody who is already here: a viewer promoted to admin by a key stays
 *   an admin afterwards.
 *
 * The last two were missing until finding 7 of the 2026-10-08 audit — the
 * second time a route that creates access forgot to ask. The real fix is to
 * invert the rule, so a key's powers are an allowlist and forgetting is
 * impossible; that is recorded as deferred work. Until then
 * `worker/src/api-key-refusal.static.test.ts` is what notices.
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
