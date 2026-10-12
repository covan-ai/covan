/**
 * The languages a person can say they read. Stored as BCP 47 tags.
 *
 * Nothing reads this yet: the interface is English, and dates are formatted
 * for the browser's own language. It is stored now because it was asked for
 * and because the first thing to use it is obvious — a `useLocale()` that
 * answers `me.user.locale ?? navigator.language`, passed to
 * `toLocaleDateString` and `formatRelative`. Null means "follow the browser",
 * which is what happens today for everybody.
 */
export const LOCALES = [
  { tag: "en", label: "English" },
  { tag: "tr", label: "Türkçe" },
  { tag: "de", label: "Deutsch" },
  { tag: "fr", label: "Français" },
  { tag: "es", label: "Español" },
  { tag: "pt", label: "Português" },
  { tag: "it", label: "Italiano" },
  { tag: "nl", label: "Nederlands" },
] as const;
