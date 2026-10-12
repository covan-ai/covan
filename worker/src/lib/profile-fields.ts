/**
 * The shapes a profile's `locale` and `timezone` may take.
 *
 * Both regexes are copies of the CHECK constraints in
 * `0082_a_face_a_sentence_and_a_clock.sql`, and they have to stay copies: the
 * API refusing a value with a 400 is a message somebody can act on, while the
 * database refusing the same value is a 500 that says nothing. The constraint is
 * there for the client that skips the API; this is there so nobody who uses it
 * ever reaches the constraint.
 */

/**
 * The shape of a BCP 47 tag — `en`, `tr-TR`, `zh-Hant-TW` — not a list of the
 * real ones. Nothing reads `locale` yet, and a list would have to be extended
 * every time somebody wanted a language nobody here thought of.
 */
export const BCP47_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** The shape of an IANA zone name, and the longest one the column accepts. */
export const TIMEZONE_RE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/;
export const TIMEZONE_MAX = 64;

/**
 * The runtime's own spelling of a time zone, or null when it does not know it.
 *
 * Asking `Intl` rather than holding a list: the zone database moves (zones are
 * added, renamed, merged) and the runtime's copy is the one every date this
 * server formats will use anyway. `resolvedOptions()` also canonicalises case,
 * so `europe/istanbul` is stored the way every other reader spells it.
 * `Intl.supportedValuesOf` would be the obvious alternative and is not used,
 * because whether workerd has it is not something to depend on server-side.
 *
 * The result is checked against the column's shape as well, because the runtime
 * accepts more than zone names: a bare offset like `+03:00` is a valid
 * `timeZone` to a current V8 and resolves to itself. That is a clock, not a
 * zone — it does not follow daylight saving — and the column would refuse it.
 */
export function canonicalTimeZone(input: string): string | null {
  const candidate = input.trim();
  if (candidate === "" || candidate.length > TIMEZONE_MAX) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: candidate }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (resolved.length > TIMEZONE_MAX || !TIMEZONE_RE.test(resolved)) return null;
  return resolved;
}
