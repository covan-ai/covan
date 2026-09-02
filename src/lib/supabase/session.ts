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
  { kind: "session"; session: Session } | { kind: "none" } | { kind: "unknown" };

/**
 * The stored session, as one of three answers rather than a nullable value.
 *
 * Never rejects: a caller deciding whether to show the app cannot be asked to
 * also handle a throw, and a throw here — storage unavailable in a private
 * window, say — is another way of not being able to tell.
 */
export async function readSession(): Promise<SessionAnswer> {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (data.session) return { kind: "session", session: data.session };
    return error ? { kind: "unknown" } : { kind: "none" };
  } catch {
    return { kind: "unknown" };
  }
}
