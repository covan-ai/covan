import { i18n } from "@/i18n";

/**
 * An address the app may send the browser to, if it is an `https:` one;
 * otherwise null.
 *
 * `location.assign`, `location.replace` and an `<iframe src>` take any string,
 * and React checks none of them. The addresses that reach them here come out
 * of an API response — a provider's consent page, a live browser view — so a
 * `javascript:` or `data:` value that got that far would run as this page.
 * The API refuses such values where they enter (`worker/src/lib/https-url.ts`);
 * this is the same rule on the side that would have followed one.
 */
export function safeNavigationUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

/** `location.assign` for an address from a response, or an error saying why not. */
export function navigateAway(raw: string): void {
  const url = safeNavigationUrl(raw);
  if (!url) throw new Error(i18n.t("That sent back an address Covan won't open."));
  window.location.assign(url);
}
