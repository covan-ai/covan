/**
 * Which language a person reads the interface in, and where that answer comes
 * from. Pure: no DOM, no request, no i18next — so the server, the client and
 * the static 500 page can all share it.
 *
 * Two different things are called a locale here, and keeping them apart is
 * most of what this file does:
 *
 * - A **tag** (`tr-TR`, `en-US`, `de-DE`): what the browser or the profile
 *   said. It goes into `<html lang>` and into every `Intl` call, so dates and
 *   numbers follow it in full, region included.
 * - A **UI language** (`"en" | "tr"`): which catalogue the words come from.
 *   The interface exists in exactly these, so anything else maps to English.
 */

export const LOCALE_COOKIE = "covan-locale";

/** The languages the interface is written in. Adding one means a catalogue. */
export const UI_LANGUAGES = ["en", "tr"] as const;
export type UiLanguage = (typeof UI_LANGUAGES)[number];

/**
 * The same shape `profiles.locale` is checked against (migration 0082): a
 * language subtag and any number of further subtags. Strict on purpose — the
 * cookie value ends up inside `<html lang="…">` on a page we build as a string.
 */
const TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function isLocaleTag(value: string | null | undefined): value is string {
  return typeof value === "string" && TAG.test(value);
}

/** The header's tags, best first. `*` and anything malformed are left out. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header) return [];
  const entries = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params
        .map((p) => p.trim())
        .find((p) => p.startsWith("q="))
        ?.slice(2);
      // A `q` that is not a number is junk on an otherwise usable entry;
      // the entry keeps the default weight rather than being thrown away.
      const weight = q === undefined || !Number.isFinite(Number(q)) ? 1 : Number(q);
      return { tag: tag.trim(), weight, index };
    })
    .filter((e) => e.weight > 0 && isLocaleTag(e.tag));
  entries.sort((a, b) => b.weight - a.weight || a.index - b.index);
  return entries.map((e) => e.tag);
}

/** One cookie out of a `Cookie:` header (or `document.cookie`), decoded. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The language subtag, lowercased. A subtag is ASCII, so no locale is needed. */
function languageOf(tag: string | null | undefined): string {
  return (tag ?? "").split("-")[0]?.toLowerCase() ?? ""; // i18n-ignore
}

/** The catalogue a tag reads from: its language if the interface has it, else English. */
export function uiLanguage(tag: string | null | undefined): UiLanguage {
  const language = languageOf(tag);
  return (UI_LANGUAGES as readonly string[]).includes(language) ? (language as UiLanguage) : "en";
}

/**
 * Which tag to use, from what is known at the time.
 *
 * The cookie wins: it is the profile's preference, written when it was saved
 * and again whenever `/me` says so. Without one, the browser's list is
 * searched for the first language the interface actually has — a German
 * browser gets English, not a German `<html lang>` on an English page. The
 * region is kept, so an en-US browser formats dates its own way.
 */
export function pickLocale(input: {
  cookie?: string | null | undefined;
  acceptLanguage?: string | null | undefined;
}): string {
  if (isLocaleTag(input.cookie)) return input.cookie;
  const supported = parseAcceptLanguage(input.acceptLanguage).find(
    (tag) => uiLanguage(tag) === languageOf(tag),
  );
  return supported ?? "en";
}

/**
 * The tag to hand to `Intl`. A bare language has no region, and `Intl` would
 * pick one for it — `en` formats like en-US — so the two the interface knows
 * get the region they have always been formatted with.
 */
export function formattingLocale(tag: string): string {
  if (tag === "en") return "en-GB";
  if (tag === "tr") return "tr-TR";
  return tag;
}
