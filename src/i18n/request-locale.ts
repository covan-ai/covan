import { createIsomorphicFn } from "@tanstack/react-start";
import { getCookie, getRequestHeader } from "@tanstack/react-start/server";
import { LOCALE_COOKIE, pickLocale, readCookie } from "./locale";

/**
 * The tag the current page should be in, asked from the root route's
 * `beforeLoad`. The server reads the request; the client reads the browser.
 * The server's answer is dehydrated into the page, so on a normal load the
 * client branch never runs — it is for client-side navigations that mount
 * the root afresh.
 *
 * The server import is used only inside `.server()`, which the Start
 * compiler strips from the client bundle (and refuses to build if it ever
 * leaks).
 */
export const requestLocale = createIsomorphicFn()
  .server(() =>
    pickLocale({
      cookie: getCookie(LOCALE_COOKIE),
      acceptLanguage: getRequestHeader("accept-language"),
    }),
  )
  .client(() =>
    pickLocale({
      cookie: readCookie(document.cookie, LOCALE_COOKIE),
      acceptLanguage: navigator.languages?.join(",") ?? navigator.language,
    }),
  );
