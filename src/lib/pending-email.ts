/**
 * The address somebody asked to move to, remembered in this browser until the
 * change completes.
 *
 * `/confirmed` needs it to tell an email change from a sign-up confirmation.
 * The link's own `type=email_change` is no help there: supabase-js reads the
 * token out of the URL fragment and clears it before the page renders. What
 * survives is the session, and a session whose address is the one written
 * here is a change that just finished.
 *
 * Only a hint for wording. Opened in another browser, the second link still
 * changes the address; the page just says "confirmed" instead of "changed".
 */
const KEY = "covan.pendingEmail";

export function rememberPendingEmail(email: string): void {
  try {
    localStorage.setItem(KEY, email.toLowerCase());
  } catch {
    // Storage blocked: the page falls back to its general wording.
  }
}

/** True, once, when `email` is the address a change was waiting for. */
export function takePendingEmail(email: string | null | undefined): boolean {
  try {
    const pending = localStorage.getItem(KEY);
    if (!pending || !email || pending !== email.toLowerCase()) return false;
    localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
