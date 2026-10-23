/**
 * The languages a person can read the interface in. Stored as BCP 47 tags
 * in `profiles.locale`; null means "follow the browser".
 *
 * Only the languages the interface actually exists in (`src/i18n/locale.ts`
 * `UI_LANGUAGES`). The column accepts any tag, and the picker shows a tag it
 * does not know as itself, but offering Deutsch and answering in English
 * would be a promise the product does not keep. A language goes on this
 * list the day its catalogue does.
 */
export const LOCALES = [
  { tag: "en", label: "English" },
  { tag: "tr", label: "Türkçe" },
] as const;
