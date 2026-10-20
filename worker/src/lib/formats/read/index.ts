import { CfbError, isCfb, openCfb, PasswordProtected } from "./cfb";
import { docText } from "./doc";
import { docxText, odtText, pptxText, xlsxText } from "./office";
import { pptText } from "./ppt";
import { decodeText, htmlToText, rtfToText } from "./text";
import { xlsText } from "./xls";
import type { RangeReader } from "./zip";
import { ZipError } from "./zip";

/**
 * A stored document's text, read by the server.
 *
 * The one place that knows which formats the server can read and how. The
 * upload's allowlist (`lib/extract.ts`), the indexing job and the Drive sync
 * all come here, so a format is supported everywhere or nowhere.
 *
 * PDFs are the exception and say so: an upload's text comes from the browser
 * and is stored beside the file (`lib/document-text.ts`). Asked for a PDF this
 * returns null, which the caller reads as "look for the text the upload kept".
 * A file with nothing kept beside it — a Drive sync's — is read by `pdf.ts`.
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
  "doc",
  "xls",
  "ppt",
]);

/** The Office 97-2003 formats, each with the format that replaced it. */
const LEGACY: Record<string, "docx" | "xlsx" | "pptx"> = { doc: "docx", xls: "xlsx", ppt: "pptx" };

const APP: Record<string, string> = { doc: "Word", xls: "Excel", ppt: "PowerPoint" };

export function extOf(name: string): string {
  const m = name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

/**
 * Read a document of `size` bytes through `read`, keeping at most `maxChars`.
 *
 * Plain text is read only as far as `maxChars` needs, so a 100 MB log costs a
 * few megabytes; markup is read whole up to a few times that and then
 * stripped; an Office file costs its text entries (or, for a 97-2003 one, its
 * text streams) and nothing else. Throws `UnreadableFile` for a file that is
 * not what its name says, or is locked with a password.
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

  /** Text or markup, read only as far as `maxChars` needs. */
  const asText = async (kind: string): Promise<Extracted> => {
    // Four bytes is the most a character can take in UTF-8, and markup is
    // allowed four times as much again for the tags it will lose.
    const budget = PLAIN.has(kind) ? maxChars * 4 : maxChars * 16;
    const want = Math.min(size, budget);
    const text = decodeText(await read(0, want));
    const readAll = want >= size;
    if (kind === "html" || kind === "htm") return cut(htmlToText(text), !readAll);
    if (kind === "rtf") return cut(rtfToText(text), !readAll);
    return cut(text, !readAll);
  };

  try {
    if (PLAIN.has(ext) || ext === "html" || ext === "htm" || ext === "rtf")
      return await asText(ext);
    if (ext === "docx") return cut(await docxText(read, size));
    if (ext === "pptx") return cut(await pptxText(read, size));
    if (ext === "xlsx") return cut(await xlsxText(read, size, maxChars));
    if (ext === "odt") return cut(await odtText(read, size));
    if (LEGACY[ext]) {
      // A `.doc` is often not one. Word saves RTF and web pages under the
      // name if asked, web apps export an HTML table as `.xls` because Excel
      // opens it, and a `.docx` renamed to `.doc` opens in Word without a
      // word. Each is read as what it is; only a compound file goes on to the
      // 97-2003 readers.
      const head = await read(0, Math.min(size, 512));
      if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
        const modern = LEGACY[ext];
        if (modern === "docx") return cut(await docxText(read, size));
        if (modern === "pptx") return cut(await pptxText(read, size));
        return cut(await xlsxText(read, size, maxChars));
      }
      if (!isCfb(head)) {
        const start = decodeText(head).trimStart().slice(0, 512);
        if (start.startsWith("{\\rtf")) return await asText("rtf");
        if (/^<(?:!doctype\s+html|html|table|head|body|meta)/i.test(start)) {
          return await asText("html");
        }
        throw new CfbError("not an Office 97-2003 file");
      }
      const cfb = await openCfb(read, size);
      // An Office 2007+ file with a password to open is a compound file too,
      // holding the encrypted zip; whatever its name, it is locked.
      if (cfb.has("EncryptedPackage")) throw new PasswordProtected();
      const got =
        ext === "doc"
          ? await docText(cfb, maxChars)
          : ext === "xls"
            ? await xlsText(cfb, maxChars)
            : await pptText(cfb, maxChars);
      return cut(got.text, got.truncated);
    }
  } catch (err) {
    if (err instanceof PasswordProtected) {
      throw new UnreadableFile(
        `this .${ext} file is password-protected — open it in ${APP[ext] ?? "the app that made it"}, remove the password and save it again`,
      );
    }
    if (err instanceof ZipError || err instanceof CfbError) {
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
