import type { Session } from "@supabase/supabase-js";
import { supabase } from "./client";

/**
 * What a session lookup can honestly report.
 *
 * `getSession()` answers `session: null` in two situations that mean opposite
 * things, and the app used to collapse them into one:
 *
 * - **Nobody is signed in.** The refresh token is gone or the server rejected
 *   it, supabase-js has cleared storage, and `error` is null.
 * - **The lookup could not complete.** The access token had expired, the
 *   refresh request failed for a reason worth retrying, and supabase-js
 *   *deliberately left the session on disk*. `error` is an
 *   `AuthRetryableFetchError`.
 *
 * The second is not "signed out" and must never be treated as such. Measured in
 * Chrome against a token endpoint that dropped the connection: `getSession()`
 * spent 21 seconds retrying, returned `{ session: null, error }`, and the
 * refresh token was still sitting in localStorage — perfectly good, and about
 * to be thrown away by a redirect to the sign-in page. That is the whole of the
 * "it signs me out between visits" bug: a network blip on the return visit, not
 * a session that expired.
 */
export type SessionAnswer =
  | { kind: "session"; session: Session }
  | { kind: "second-factor"; session: Session }
  | { kind: "none" }
  | { kind: "unknown" };

/**
 * The stored session, as one of four answers rather than a nullable value.
 *
 * The fourth is a session that is real but not finished: the password was
 * right, and the account has an authenticator whose code has not been given
 * yet. Every request it makes is refused (0108), so it must not be shown the
 * app — and it must not be signed out either, because the next step is one
 * code away. It goes to `/two-factor`.
 *
 * Never rejects: a caller deciding whether to show the app cannot be asked to
 * also handle a throw, and a throw here — storage unavailable in a private
 * window, say — is another way of not being able to tell.
 */
export async function readSession(): Promise<SessionAnswer> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (data.session) {
      // Read from the token and the user already on disk; no request is made.
      const { data: level } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      if (level?.currentLevel === "aal1" && level.nextLevel === "aal2") {
        return { kind: "second-factor", session: data.session };
      }
      return { kind: "session", session: data.session };
    }
    return error ? { kind: "unknown" } : { kind: "none" };
  } catch {
    return { kind: "unknown" };
  }
}
