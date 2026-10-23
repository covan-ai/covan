import { englishT, type Translate } from "@/i18n";

/**
 * Letters are capitalised in the reader's language: a dotted lowercase i
 * becomes a dotted capital in Turkish and a plain I in English. `locale`
 * defaults to English for callers that do not pass one.
 */

/** "Ada Lovelace" -> "AL". Falls back to a dash so a row never looks broken. */
export function getInitials(
  name: string | null | undefined,
  fallback = "–",
  locale: string = "en",
): string {
  if (!name) return fallback;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0]!.charAt(0).toLocaleUpperCase(locale);
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toLocaleUpperCase(locale);
}

/** A tile's two letters, at every size the boards draw one ("Google Drive" -> "GD"). */
export function monogram(label: string, locale: string = "en"): string {
  const trimmed = label.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "–";
  if (trimmed.length <= 2) return trimmed.toLocaleUpperCase(locale);
  return words.length > 1
    ? (words[0]!.charAt(0) + words[1]!.charAt(0)).toLocaleUpperCase(locale)
    : words[0]!.slice(0, 2).toLocaleUpperCase(locale);
}

/** "Can Bora" -> "Can B.": a teammate's name where a column is narrow (A5). */
export function shortName(
  name: string | null | undefined,
  t: Translate = englishT,
  locale: string = "en",
): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return t("A teammate");
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]!.charAt(0).toLocaleUpperCase(locale)}.`;
}
