import i18next, { type i18n as I18n, type TFunction } from "i18next";
import { initReactI18next } from "react-i18next";
import { UI_LANGUAGES, uiLanguage, type UiLanguage } from "./locale";
import { resources } from "./resources";

export type { TFunction } from "i18next";
export {
  LOCALE_COOKIE,
  UI_LANGUAGES,
  formattingLocale,
  uiLanguage,
  type UiLanguage,
} from "./locale";
/**
 * The hook and the component come from here, not from `react-i18next`.
 *
 * Importing this module is what creates the instance and hands it to
 * react-i18next (`initReactI18next`, below). A component that imported the
 * package directly would work in the app, where the root route has long
 * since loaded this file — and render raw keys in a unit test, where
 * nothing else has. The lint rule makes the import path the rule.
 */
export { Trans, useTranslation } from "react-i18next";

/**
 * The words of the interface, in the language the person reads.
 *
 * Keys are the English copy itself — `t("Save changes")` — so the source
 * stays readable, a missing translation shows English rather than a key,
 * and the English catalogue is a list of what the product says rather than
 * a second place to write it. `src/i18n/locales/tr.json` is the only file in
 * the repository that holds Turkish; `interface-language.static.test.ts`
 * keeps it that way.
 *
 * Two shapes of key need an extra word in the call, and the catalogue test
 * checks for both:
 *
 * - plurals: `t("{{count}} file", { count, defaultValue_other: "{{count}} files" })`.
 *   `{{count}}` is reserved for the plural selector; a number that does not
 *   pluralise the sentence is named something else.
 * - context, when one English word needs two translations:
 *   `t("Done", { context: "status", defaultValue: "Done" })`.
 */
export function createI18n(lng: UiLanguage): I18n {
  const instance = i18next.createInstance();
  instance.use(initReactI18next);
  void instance.init({
    lng,
    fallbackLng: "en",
    supportedLngs: [...UI_LANGUAGES],
    nonExplicitSupportedLngs: true,
    load: "languageOnly",
    resources,
    keySeparator: false,
    nsSeparator: false,
    pluralSeparator: "_",
    contextSeparator: "_",
    returnEmptyString: false,
    returnNull: false,
    interpolation: { escapeValue: false },
    // Everything is bundled, so there is nothing to wait for: `t` works
    // from the line after this one, which is what server rendering needs.
    initAsync: false,
    react: { useSuspense: false },
    // In development, a string that is not in en.json yet is one somebody
    // wrote without running the extraction. Say so once, in the console.
    saveMissing: import.meta.env.DEV && !import.meta.env.TEST,
    missingKeyHandler: (_lngs, _ns, key) => {
      console.warn(`[i18n] "${key}" is not in en.json yet — run \`bun run i18n:extract\``);
    },
  });
  return instance;
}

/**
 * The language the page was served in, read back the way the theme reads
 * its init script's decision: the server chose `<html lang>`, and the first
 * client render has to agree with it byte for byte.
 */
function initialLanguage(): UiLanguage {
  if (typeof document === "undefined") return "en";
  return uiLanguage(document.documentElement.lang);
}

/**
 * The instance the client renders with. On the server it is only the source
 * of per-request clones (`provider.tsx`); its own language there is English
 * and never changes.
 *
 * Imported by name on purpose. `package.json` declares `sideEffects: false`,
 * so a bare `import "@/i18n"` would be dropped by the bundler.
 */
export const i18n: I18n = createI18n(initialLanguage());

/**
 * Marks a string in a table as copy that is translated at render time —
 * `label: msg("Inbox")`, later `t(item.label)`. It returns its argument; its
 * only job is to be a name the extraction tool looks for, so the string
 * reaches en.json without being translated at import time, before any
 * language is known.
 */
export function msg(english: string): string {
  return english;
}

/**
 * `t()` for a key that came out of a table — `lookup(t, item.label)`.
 *
 * The extraction tool reads every `t(…)` and refuses one whose key it
 * cannot see; the table's `msg()` entries are where it sees these. This file
 * is outside what it reads, which is the whole trick.
 */
export function lookup(t: TFunction, key: string): string {
  return t(key);
}
