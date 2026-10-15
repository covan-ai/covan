import { docxText, odtText, pptxText, xlsxText } from "./office";
import { decodeText, htmlToText, rtfToText } from "./text";
import type { RangeReader } from "./zip";
import { ZipError } from "./zip";

/**
 * A stored document's text, read by the server.
 *
 * The one place that knows which formats the server can read and how. The
 * upload's allowlist (`lib/extract.ts`), the indexing job and the Drive sync
 * all come here, so a format is supported everywhere or nowhere.
 *
 * PDFs are the exception and say so: their text comes from the browser, which
 * runs pdf.js where it bundles reliably, and is stored beside the file
 * (`lib/document-text.ts`). Asked for a PDF this returns null, which the
 * caller reads as "look for the text the upload kept".
 */

export type Extracted = {
  text: string;
  /** The text was cut at `maxChars`; everything before the cut is here. */
  truncated: boolean;
};

export class UnreadableFile extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnreadableFile";
  }
}

/** The formats read as plain text, decoded by `decodeText`. */
const PLAIN = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "xml", "log", "yaml", "yml"]);

/** The formats this module reads, PDF aside. */
export const SERVER_READABLE = new Set([
  ...PLAIN,
  "html",
  "htm",
  "rtf",
  "docx",
  "pptx",
  "xlsx",
  "odt",
]);

export function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

/**
 * Read a document of `size` bytes through `read`, keeping at most `maxChars`.
 *
 * Plain text is read only as far as `maxChars` needs, so a 100 MB log costs a
 * few megabytes; markup is read whole up to a few times that and then
 * stripped; an Office file costs its text entries and nothing else. Throws
 * `UnreadableFile` for a file that is not what its name says.
 */
export async function extractText(
  name: string,
  read: RangeReader,
  size: number,
  maxChars: number,
): Promise<Extracted | null> {
  const ext = extOf(name);
  if (ext === "pdf") return null;

  const cut = (text: string, alreadyCut = false): Extracted =>
    text.length > maxChars
      ? { text: text.slice(0, maxChars), truncated: true }
      : { text, truncated: alreadyCut };

  try {
    if (PLAIN.has(ext) || ext === "html" || ext === "htm" || ext === "rtf") {
      // Four bytes is the most a character can take in UTF-8, and markup is
      // allowed four times as much again for the tags it will lose.
      const budget = PLAIN.has(ext) ? maxChars * 4 : maxChars * 16;
      const want = Math.min(size, budget);
      const text = decodeText(await read(0, want));
      const readAll = want >= size;
      if (ext === "html" || ext === "htm") return cut(htmlToText(text), !readAll);
      if (ext === "rtf") return cut(rtfToText(text), !readAll);
      return cut(text, !readAll);
    }
    if (ext === "docx") return cut(await docxText(read, size));
    if (ext === "pptx") return cut(await pptxText(read, size));
    if (ext === "xlsx") return cut(await xlsxText(read, size, maxChars));
    if (ext === "odt") return cut(await odtText(read, size));
  } catch (err) {
    if (err instanceof ZipError) {
      throw new UnreadableFile(
        `this does not read as a .${ext} file (${err.message}) — check it opens, and that it is not password-protected`,
      );
    }
    throw err;
  }
  throw new UnreadableFile(`.${ext} files cannot be read`);
}

/** `extractText` over bytes already in memory. */
export function extractFromBytes(
  name: string,
  bytes: Uint8Array,
  maxChars: number,
): Promise<Extracted | null> {
  return extractText(
    name,
    async (offset, length) => bytes.subarray(offset, offset + length),
    bytes.byteLength,
    maxChars,
  );
}
