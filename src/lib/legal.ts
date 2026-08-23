/**
 * Where "Terms" and "Privacy Policy" point.
 *
 * Two audiences, one sign-up form. A self-hoster running Covan for their own
 * company has no terms of service to link to and does not need one — the
 * licence and an honest account of where their data goes is the whole of it,
 * and that is what `/terms` and `/privacy` in this build say. An operator
 * running Covan as a service for other people does need one, written by a
 * lawyer rather than by this repository, and points these at it.
 *
 * So the links are configurable and default to the built-in pages. What they
 * must never be again is `href="#"`, which is what sat next to a required "I
 * agree" checkbox: asking someone to accept terms and then giving them nothing
 * to read is worse than either honest answer.
 */

export type LegalLink = {
  /** Passed to <a href> when external, or to <Link to> when it is a route. */
  href: string;
  /** External links open in a new tab and carry rel="noreferrer". */
  external: boolean;
};

/**
 * Trim and reject the empty string, so an unset variable and a variable set to
 * "" mean the same thing. Vite inlines `undefined` for the first and `""` for
 * the second depending on how the build was configured, and the difference
 * should not decide where a link goes.
 */
function configured(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveLegalLink(configuredUrl: string | undefined, fallback: string): LegalLink {
  const url = configured(configuredUrl);
  return url ? { href: url, external: true } : { href: fallback, external: false };
}

export function termsLink(): LegalLink {
  return resolveLegalLink(import.meta.env.VITE_TERMS_URL, "/terms");
}

export function privacyLink(): LegalLink {
  return resolveLegalLink(import.meta.env.VITE_PRIVACY_URL, "/privacy");
}
