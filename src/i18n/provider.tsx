import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { i18n } from "./index";
import { LOCALE_COOKIE, formattingLocale, isLocaleTag, pickLocale, uiLanguage } from "./locale";

/**
 * The locale the page is in, as a tiny store the way the theme is one
 * (`lib/theme.tsx`): read through `useSyncExternalStore`, changed from one
 * place, with the server's answer as the snapshot during hydration.
 *
 * On the client the store starts from `<html lang>`, which the server set,
 * so the first render agrees with the HTML. On the server there is no store
 * to speak of — every request renders inside a `LocaleProvider` that carries
 * its own tag — and `current` stays at its default.
 */
let current: string =
  typeof document !== "undefined" && isLocaleTag(document.documentElement.lang)
    ? document.documentElement.lang
    : "en";

const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void) {
  listeners.add(onStoreChange);
  return () => {
    listeners.delete(onStoreChange);
  };
}

function snapshot(): string {
  return current;
}

const LocaleContext = createContext<string>("en");

/**
 * Wraps the app in the request's language.
 *
 * On the server each request gets a clone of the instance with its own
 * language and a shared resource store, because two requests rendering at
 * once must not fight over one `i18n.language`. On the client there is one
 * page and one person, so the singleton is enough — and it is already in
 * the right language, having read `<html lang>` when it was created.
 */
export function LocaleProvider({ locale, children }: { locale: string; children: ReactNode }) {
  const instance = useMemo(() => {
    if (import.meta.env.SSR)
      return i18n.cloneInstance({ lng: uiLanguage(locale), initAsync: false });
    // Belt and braces for a page served without a `lang` (a hand-written
    // test, an unusual host): the route context knows what the server chose.
    const lng = uiLanguage(locale);
    if (i18n.resolvedLanguage !== lng) void i18n.changeLanguage(lng);
    return i18n;
  }, [locale]);

  return (
    <I18nextProvider i18n={instance}>
      <LocaleContext value={locale}>{children}</LocaleContext>
    </I18nextProvider>
  );
}

/** The tag for `<html lang>`: whatever the page was served in, until it is changed. */
export function useHtmlLang(): string {
  const serverLocale = useContext(LocaleContext);
  return useSyncExternalStore(subscribe, snapshot, () => serverLocale);
}

/**
 * The tag to hand to `Intl` — `toLocaleDateString(locale)`,
 * `Intl.RelativeTimeFormat(locale)` — from the person's preference, with the
 * region the interface has always formatted a bare language with.
 */
export function useLocale(): string {
  return formattingLocale(useHtmlLang());
}

/**
 * The tag the page is in right now, for code with no component in reach.
 * Client only: on the server the answer lives in the request, not here.
 */
export function currentLocale(): string {
  return formattingLocale(current);
}

function writeCookie(preference: string | null) {
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie =
    preference === null
      ? `${LOCALE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax${secure}`
      : `${LOCALE_COOKIE}=${encodeURIComponent(preference)}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
}

/**
 * Puts the page in a language: the profile's preference, or `null` to follow
 * the browser. Remembers it in a cookie so the next page is served in it,
 * switches the catalogue, and tells `<html lang>` and every `useLocale()`.
 *
 * Called when the preference is saved and whenever `/me` arrives, so a
 * choice made on one device follows the account to the next. A no-op when
 * nothing changed, which is most of the time.
 */
export function applyLocale(preference: string | null): void {
  const tag = isLocaleTag(preference)
    ? preference
    : pickLocale({ acceptLanguage: navigator.languages?.join(",") ?? navigator.language });
  writeCookie(isLocaleTag(preference) ? preference : null);
  if (tag !== current) {
    current = tag;
    for (const listener of listeners) listener();
  }
  const lng = uiLanguage(tag);
  if (i18n.resolvedLanguage !== lng) void i18n.changeLanguage(lng);
}
