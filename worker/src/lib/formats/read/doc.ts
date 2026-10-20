import { CfbError, PasswordProtected, u16, u32, type CompoundFile } from "./cfb";
import { decodeUtf16, decodeWindows1252, tidy } from "./text";

/**
 * Text out of a Word 97-2003 `.doc` ([MS-DOC]).
 *
 * A `.doc` keeps its characters in the "WordDocument" stream, but not in
 * order and not in one encoding: Word saves by appending, so the document is
 * a list of pieces — runs of characters somewhere in the stream — and the
 * list, the piece table, is in a second stream ("0Table" or "1Table", the
 * header says which). Each piece is either UTF-16 or "compressed", one byte
 * per character in Windows-1252. Word compresses a piece only when every
 * character in it fits that code page, so Turkish text — ğ, ş, ı, İ are not
 * in it — lands in UTF-16 pieces and comes out whole, while ü, ö and ç may
 * arrive either way and are the same letters both ways.
 *
 * What is read: the main text, then footnotes and endnotes (as `.docx` does),
 * with fields reduced to what they display. What is not: headers and footers
 * (the same line on every page says nothing), comments, text boxes, and any
 * formatting — headings are not marked, because a heading in a `.doc` is a
 * style index in a table this does not read. Table cells are separated by
 * tabs and rows by line breaks, worked out from the cell marks alone; an
 * empty last cell can make a row break one cell early.
 */

/** No stream of a `.doc` may be larger than this. A 400-page manual's text is a fraction of it. */
const MAX_STREAM_BYTES = 64 * 1024 * 1024;

/** Word 6 and 95 have their own header (wIdent 0xA5DC) and their own piece table. */
const OLD_WORD = "a Word 6 or Word 95 document, older than this reader goes — save it as .docx";

type Fib = {
  table: "0Table" | "1Table";
  /** Characters in the main text, footnotes, headers, (macros), comments, endnotes. */
  ccp: { text: number; ftn: number; hdd: number; mcr: number; atn: number; edn: number };
  fcClx: number;
  lcbClx: number;
};

/** The File Information Block: where everything else is. */
function readFib(word: Uint8Array): Fib {
  if (word.length >= 2 && u16(word, 0) === 0xa5dc) throw new CfbError(OLD_WORD);
  if (word.length < 64 || u16(word, 0) !== 0xa5ec) {
    throw new CfbError("not a Word document (no Word header)");
  }
  // Word 6 and 95 wrote a different header, laid out by fixed offsets; Word
  // 97 introduced the counted blocks read below. The two are told apart by
  // the version and by those counts, which the older layout does not have.
  const nFib = u16(word, 2);
  const flags = u16(word, 0x0a);
  if (flags & 0x0100) throw new PasswordProtected();
  const csw = u16(word, 32);
  const rgLw = 34 + csw * 2 + 2;
  const cslw = u16(word, rgLw - 2);
  const blobAt = rgLw + cslw * 4 + 2;
  if (nFib < 0x69 || csw !== 14 || cslw < 11 || blobAt > word.length) {
    throw new CfbError(OLD_WORD);
  }
  const cbRgFcLcb = u16(word, blobAt - 2);
  // fcClx/lcbClx is the 34th pair of FibRgFcLcb97.
  const clxAt = blobAt + 33 * 8;
  if (cbRgFcLcb < 34 || clxAt + 8 > word.length) {
    throw new CfbError("the Word header is damaged");
  }
  const lw = (i: number) => u32(word, rgLw + i * 4);
  return {
    table: flags & 0x0200 ? "1Table" : "0Table",
    ccp: { text: lw(3), ftn: lw(4), hdd: lw(5), mcr: lw(6), atn: lw(7), edn: lw(8) },
    fcClx: u32(word, clxAt),
    lcbClx: u32(word, clxAt + 4),
  };
}

type Piece = { cpStart: number; cpEnd: number; offset: number; compressed: boolean };

/**
 * The piece table, out of the CLX: some property blocks (`Prc`, skipped) and
 * then one `Pcdt`, which is an array of character positions followed by one
 * eight-byte descriptor per piece.
 */
function readPieces(table: Uint8Array, fc: number, lcb: number, word: Uint8Array): Piece[] {
  if (lcb === 0 || fc + lcb > table.length) throw new CfbError("the piece table is missing");
  const end = fc + lcb;
  let at = fc;
  while (at < end) {
    const clxt = table[at];
    if (clxt === 1) {
      at += 3 + u16(table, at + 1);
      continue;
    }
    if (clxt !== 2 || at + 5 > end) break;
    const length = u32(table, at + 1);
    const start = at + 5;
    const n = (length - 4) / 12;
    if (!Number.isInteger(n) || n < 1 || start + length > table.length) break;
    const pieces: Piece[] = [];
    for (let i = 0; i < n; i++) {
      const cpStart = u32(table, start + i * 4);
      const cpEnd = u32(table, start + (i + 1) * 4);
      const raw = u32(table, start + (n + 1) * 4 + i * 8 + 2);
      const compressed = (raw & 0x40000000) !== 0;
      const fcValue = raw & 0x3fffffff;
      const offset = compressed ? fcValue / 2 : fcValue;
      const count = cpEnd - cpStart;
      if (cpEnd < cpStart || offset + count * (compressed ? 1 : 2) > word.length) {
        throw new CfbError("a piece of the text is past the end of its stream");
      }
      pieces.push({ cpStart, cpEnd, offset: Math.floor(offset), compressed });
    }
    return pieces;
  }
  throw new CfbError("the piece table is damaged");
}

/**
 * Word's text, one character at a time, turned into plain text.
 *
 * Word marks structure with control characters inside the text itself: 13
 * ends a paragraph, 7 ends a table cell (and, doubled, a row), 11 is a line
 * break, 12 a page or section break. A field — a page number, a hyperlink, a
 * table of contents — is `19 instruction 20 result 21`, and nests; what a
 * reader sees is the result, so the instruction (`HYPERLINK "https://…"`,
 * `PAGE \* MERGEFORMAT`) is dropped and the result kept.
 */
class WordText {
  private parts: string[] = [];
  private codes: number[] = [];
  /** One entry per open field: true while still in its instruction. */
  private fields: boolean[] = [];
  private inInstruction = 0;
  private previous = 0;
  length = 0;

  push(c: number) {
    if (c === 0x13) {
      // Fields nest, but not this deep in any real document.
      if (this.fields.length < 64) {
        this.fields.push(true);
        this.inInstruction++;
      }
      return;
    }
    if (c === 0x14) {
      const top = this.fields.length - 1;
      if (top >= 0 && this.fields[top]) {
        this.fields[top] = false;
        this.inInstruction--;
      }
      return;
    }
    if (c === 0x15) {
      if (this.fields.pop()) this.inInstruction--;
      return;
    }
    if (this.inInstruction > 0) return;

    const previous = this.previous;
    this.previous = c;
    if (c === 0x0d || c === 0x0b || c === 0x0c || c === 0x0e) return this.emit(0x0a);
    if (c === 0x07) {
      if (previous !== 0x07) return this.emit(0x09);
      // A cell mark straight after another is the row's end mark. Forgotten
      // at once, so a next row that opens with an empty cell is a tab.
      this.previous = 0;
      return this.emit(0x0a);
    }
    if (c === 0x09) return this.emit(0x09);
    if (c === 0x1e) return this.emit(0x2d); // non-breaking hyphen
    if (c === 0xa0) return this.emit(0x20);
    // Everything else below a space is an anchor for something that is not
    // text: a picture, a drawing, a footnote or comment reference.
    if (c < 0x20) return;
    this.emit(c);
  }

  private emit(c: number) {
    this.codes.push(c);
    this.length++;
    if (this.codes.length >= 8192) this.flush();
  }

  private flush() {
    this.parts.push(String.fromCharCode(...this.codes));
    this.codes = [];
  }

  text(): string {
    this.flush();
    return this.parts.join("");
  }
}

export async function docText(
  cfb: CompoundFile,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  const word = await cfb.stream("WordDocument", MAX_STREAM_BYTES);
  if (!word) throw new CfbError("not a Word document (no WordDocument stream)");
  const fib = readFib(word);
  const table = await cfb.stream(fib.table, MAX_STREAM_BYTES);
  if (!table) throw new CfbError(`the ${fib.table} stream is missing`);
  const pieces = readPieces(table, fib.fcClx, fib.lcbClx, word);
  const last = pieces.reduce((m, p) => Math.max(m, p.cpEnd), 0);

  // The text is one run of character positions: the main document, then each
  // kind of note and header in a fixed order. When the counts do not add up —
  // some writers leave them zero — the whole run is read instead.
  const { text: ccpText, ftn, hdd, mcr, atn, edn } = fib.ccp;
  const endnotesAt = ccpText + ftn + hdd + mcr + atn;
  const ranges: [number, number][] =
    ccpText > 0 && endnotesAt + edn <= last
      ? [
          [0, ccpText],
          [ccpText, ccpText + ftn],
          [endnotesAt, endnotesAt + edn],
        ]
      : [[0, last]];

  const out: string[] = [];
  let truncated = false;
  let length = 0;
  for (const [from, to] of ranges) {
    if (to <= from) continue;
    const w = new WordText();
    for (const p of pieces) {
      const start = Math.max(from, p.cpStart);
      const end = Math.min(to, p.cpEnd);
      if (start >= end) continue;
      const skip = start - p.cpStart;
      const count = end - start;
      const chars = p.compressed
        ? decodeWindows1252(word.subarray(p.offset + skip, p.offset + skip + count))
        : decodeUtf16(word.subarray(p.offset + skip * 2, p.offset + (skip + count) * 2), true);
      for (let i = 0; i < chars.length && !truncated; i++) {
        w.push(chars.charCodeAt(i));
        truncated = length + w.length > maxChars;
      }
      if (truncated) break;
    }
    const text = tidy(w.text());
    if (text) out.push(text);
    length += text.length;
    if (truncated) break;
  }
  return { text: out.join("\n\n"), truncated };
}
