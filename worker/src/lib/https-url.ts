/**
 * An address a provider handed us to send somebody's browser to, if it is an
 * `https:` one; otherwise null.
 *
 * Composio's consent page and browser-use's live view both arrive as strings in
 * a provider's JSON and end up in `location.assign`, `location.replace` or an
 * `<iframe src>` in the app. None of those checks a scheme, so a `javascript:`
 * or `data:` value from a compromised or confused provider would run as covan.app.
 * Checked where the value enters, so nothing downstream has to remember to.
 * The string is returned as it came, not re-serialised: it is a credential, and
 * a normalised copy is a different string.
 */
export function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}
