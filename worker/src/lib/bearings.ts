import { extOf } from "./extract";

/**
 * What a passage is embedded with besides itself.
 *
 * Moved out of the indexing job when the sync started using it too: an
 * uploaded document's passages were embedded under its name, a synced one's
 * bare (covan-cloud#438), so a short passage from Notion or Drive was matched
 * on its few words alone and lost to the same words in an upload. One helper,
 * so the two paths cannot drift apart again.
 */

/** The header row of a table-shaped document, or "" for anything else. */
export function tableHeader(name: string, text: string): string {
  const ext = extOf(name);
  if (ext !== "csv" && ext !== "tsv" && ext !== "xlsx") return "";
  // An Excel file's text opens with its first sheet's heading line.
  const lines = text.split("\n", 4).filter((l) => l.trim() && !l.startsWith("## Sheet"));
  return (lines[0] ?? "").slice(0, 300);
}

/** A passage as it is embedded: under its document's name, and its table's header. */
export function withBearings(name: string, header: string, content: string): string {
  const head = header && !content.startsWith(header) ? `${header}\n` : "";
  return `${name}\n\n${head}${content}`;
}
