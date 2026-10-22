/** "Ada Lovelace" -> "AL". Falls back to a dash so a row never looks broken. */
export function getInitials(name: string | null | undefined, fallback = "–"): string {
  if (!name) return fallback;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
}

/** A tile's letters: one at the smallest sizes, two from 24 up ("Google Drive" -> "GD"). */
export function monogram(label: string, size = 24): string {
  const trimmed = label.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "–";
  if (size < 24) return trimmed.charAt(0).toUpperCase();
  if (trimmed.length <= 2) return trimmed.toUpperCase();
  return words.length > 1
    ? (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase()
    : words[0]!.charAt(0).toUpperCase();
}

/** "Can Bora" -> "Can B.": a teammate's name where a column is narrow (A5). */
export function shortName(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A teammate";
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.`;
}
