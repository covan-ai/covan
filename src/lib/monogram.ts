/** "Ada Lovelace" -> "AL". Falls back to a dash so a row never looks broken. */
export function getInitials(name: string | null | undefined, fallback = "–"): string {
  if (!name) return fallback;
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return fallback;
  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();
  return (parts[0]!.charAt(0) + parts[1]!.charAt(0)).toUpperCase();
}

/** A tile's two letters, at every size the boards draw one ("Google Drive" -> "GD"). */
export function monogram(label: string): string {
  const trimmed = label.trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "–";
  if (trimmed.length <= 2) return trimmed.toUpperCase();
  return words.length > 1
    ? (words[0]!.charAt(0) + words[1]!.charAt(0)).toUpperCase()
    : words[0]!.slice(0, 2).toUpperCase();
}

/** "Can Bora" -> "Can B.": a teammate's name where a column is narrow (A5). */
export function shortName(name: string | null | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "A teammate";
  if (parts.length === 1) return parts[0]!;
  return `${parts[0]} ${parts[parts.length - 1]!.charAt(0).toUpperCase()}.`;
}
