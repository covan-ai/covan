import { CfbError, PasswordProtected, u16, u32, type CompoundFile } from "./cfb";
import { csvCell } from "./office";
import { decodeLatin1, decodeUtf16, decodeWindows1252, decodeWindows1254 } from "./text";

/**
 * Text out of an Excel 97-2003 `.xls` ([MS-XLS]), in the shape `xlsxText`
 * gives a `.xlsx`: each sheet as CSV under `## Sheet: <name>`, so a workbook
 * reads the same whichever format it was saved in.
 *
 * The "Workbook" stream is a flat run of BIFF8 records — a two-byte type, a
 * two-byte length, the data. First the workbook's globals (sheet names, the
 * shared string table), then each sheet between its own BOF and EOF, with one
 * record per cell. Text cells mostly point into the shared string table
 * (SST), and that table is the one hard part: a record holds at most 8,224
 * bytes, so a long table goes on in CONTINUE records, and a string can be cut
 * in the middle of its characters. When that happens the CONTINUE begins with
 * the string's option byte again, which may switch the rest of the string
 * from one byte per character to two — the rest is UTF-16 from there on, which
 * is exactly where a Turkish string's first ğ or ş tends to fall.
 *
 * Excel 95 workbooks ("Book" stream, BIFF5) are read too: no shared strings,
 * and text in the code page the file names (1254 for a Turkish one).
 *
 * Values are what the cell holds: text as text, numbers as stored (dates as
 * serial numbers, as `.xlsx` gives them), a formula's last computed result.
 * Not read: charts, comments, cell formatting, and a workbook with a password
 * to open it.
 */

const MAX_STREAM_BYTES = 64 * 1024 * 1024;

const BOF = 0x0809;
const EOF = 0x000a;
const FILEPASS = 0x002f;
const CODEPAGE = 0x0042;
const CONTINUE = 0x003c;
const BOUNDSHEET = 0x0085;
const SST = 0x00fc;
const LABELSST = 0x00fd;
const LABEL = 0x0204;
const RSTRING = 0x00d6;
const NUMBER = 0x0203;
const RK = 0x027e;
const MULRK = 0x00bd;
const FORMULA = 0x0006;
const STRING = 0x0207;
const BOOLERR = 0x0205;

const BLANK = 0x0201;
const MULBLANK = 0x00be;

const WORKSHEET = 0x0010;

/** Records that are a cell of their own, so a string still owed to an earlier FORMULA is not coming. */
const CELL_RECORDS = new Set([
  LABELSST,
  LABEL,
  RSTRING,
  NUMBER,
  RK,
  MULRK,
  BOOLERR,
  BLANK,
  MULBLANK,
  FORMULA,
  EOF,
]);

const ERRORS: Record<number, string> = {
  0x00: "#NULL!",
  0x07: "#DIV/0!",
  0x0f: "#VALUE!",
  0x17: "#REF!",
  0x1d: "#NAME?",
  0x24: "#NUM!",
  0x2a: "#N/A",
};

type BiffRecord = {
  type: number;
  /** Where the record's header starts in the stream, which is how a sheet is named. */
  offset: number;
  data: Uint8Array;
  /** The CONTINUE records straight after it, which carry the rest of its data. */
  more: Uint8Array[];
};

function* records(s: Uint8Array): Generator<BiffRecord> {
  let at = 0;
  while (at + 4 <= s.length) {
    const type = u16(s, at);
    const length = u16(s, at + 2);
    const offset = at;
    // A record running past the end is where a damaged file stops making
    // sense; what came before it is still good.
    if (at + 4 + length > s.length) return;
    const data = s.subarray(at + 4, at + 4 + length);
    at += 4 + length;
    const more: Uint8Array[] = [];
    while (at + 4 <= s.length && u16(s, at) === CONTINUE) {
      const n = u16(s, at + 2);
      if (at + 4 + n > s.length) break;
      more.push(s.subarray(at + 4, at + 4 + n));
      at += 4 + n;
    }
    yield { type, offset, data, more };
  }
}

/** A record's data and its continuations, read as one sequence that knows where each part ends. */
class Parts {
  private i = 0;
  private at = 0;
  constructor(private readonly parts: Uint8Array[]) {}

  /** Moves past finished parts; false when there is nothing left at all. */
  private ready(): boolean {
    while (this.i < this.parts.length && this.at >= this.parts[this.i].length) {
      this.i++;
      this.at = 0;
    }
    return this.i < this.parts.length;
  }

  done(): boolean {
    return !this.ready();
  }

  byte(): number {
    if (!this.ready()) throw new CfbError("the workbook's strings are cut short");
    return this.parts[this.i][this.at++];
  }

  u16(): number {
    return this.byte() | (this.byte() << 8);
  }

  u32(): number {
    return (this.u16() | (this.u16() << 16)) >>> 0;
  }

  skip(n: number) {
    while (n > 0) {
      if (!this.ready()) throw new CfbError("the workbook's strings are cut short");
      const take = Math.min(n, this.parts[this.i].length - this.at);
      this.at += take;
      n -= take;
    }
  }

  /**
   * `count` characters, one or two bytes each as `highByte` says — and when
   * the characters run into the next part, that part begins with a fresh
   * option byte saying which it is for the rest of them.
   */
  chars(count: number, highByte: boolean): string {
    const out: string[] = [];
    let wide = highByte;
    let left = count;
    while (left > 0) {
      if (this.i >= this.parts.length) throw new CfbError("the workbook's strings are cut short");
      if (this.at >= this.parts[this.i].length) {
        this.i++;
        this.at = 0;
        if (this.i >= this.parts.length) throw new CfbError("the workbook's strings are cut short");
        wide = (this.parts[this.i][this.at++] & 0x01) !== 0;
        continue;
      }
      const part = this.parts[this.i];
      const room = part.length - this.at;
      const take = Math.min(left, wide ? Math.floor(room / 2) : room);
      if (take === 0) throw new CfbError("a string is split in the middle of a character");
      const bytes = part.subarray(this.at, this.at + take * (wide ? 2 : 1));
      out.push(wide ? decodeUtf16(bytes, true) : decodeLatin1(bytes));
      this.at += bytes.length;
      left -= take;
    }
    return out.join("");
  }

  /**
   * An XLUnicodeRichExtendedString: a count, an option byte, optional counts
   * of formatting runs and phonetic data, the characters, then those runs and
   * that data — which are skipped, but have to be got past.
   */
  string(): string {
    const count = this.u16();
    const flags = this.byte();
    const runs = flags & 0x08 ? this.u16() : 0;
    const extra = flags & 0x04 ? this.u32() : 0;
    const text = this.chars(count, (flags & 0x01) !== 0);
    this.skip(runs * 4);
    this.skip(extra);
    return text;
  }
}

/** An RK number: a 30-bit integer or the top of a double, possibly in hundredths. */
function rkValue(rk: number): number {
  let value: number;
  if (rk & 0x02) {
    value = rk >> 2;
  } else {
    const view = new DataView(new ArrayBuffer(8));
    view.setUint32(4, rk & 0xfffffffc, true);
    value = view.getFloat64(0, true);
  }
  return rk & 0x01 ? value / 100 : value;
}

const float64 = (b: Uint8Array, at: number) =>
  new DataView(b.buffer, b.byteOffset + at, 8).getFloat64(0, true);

type Sheet = { name: string; rows: Map<number, string[]> };

export async function xlsText(
  cfb: CompoundFile,
  maxChars: number,
): Promise<{ text: string; truncated: boolean }> {
  const workbook = await cfb.stream("Workbook", MAX_STREAM_BYTES);
  const stream = workbook ?? (await cfb.stream("Book", MAX_STREAM_BYTES));
  if (!stream) throw new CfbError("not an Excel workbook (no Workbook stream)");
  if (stream.length < 8 || u16(stream, 0) !== BOF) {
    throw new CfbError("not an Excel workbook (it does not start with a BOF record)");
  }

  // Excel 97 and later write "Workbook" and BOF version 0x0600; Excel 95
  // wrote "Book" and 0x0500, though other programs put other numbers there.
  const version = u16(stream, 4);
  const biff8 = workbook ? version !== 0x0500 : version === 0x0600;
  let decode8 = decodeWindows1252;
  /** The sheets the globals declare: where each one's BOF is, and its name. */
  const declared: { offset: number; name: string }[] = [];
  let sst: string[] = [];

  const out: string[] = [];
  let length = 0;
  let truncated = false;
  let sheet: Sheet | null = null;
  let sheetsSeen = 0;
  /** A sheet's charts are whole substreams inside it, BOF to EOF; their records are not cells. */
  let depth = 0;
  /** A FORMULA whose result is a string says so, and the string is the next STRING record. */
  let pendingString: { row: number; col: number } | null = null;
  let collected = 0;

  /** An old-style string: a count, then that many bytes in the file's code page. */
  const byteString = (b: Uint8Array, at: number, countBytes: 1 | 2) => {
    const count = countBytes === 1 ? b[at] : u16(b, at);
    return decode8(b.subarray(at + countBytes, at + countBytes + count));
  };

  const set = (row: number, col: number, value: string) => {
    if (!sheet || collected > maxChars) return;
    const v = value.trim();
    if (!v || col > 16383) return;
    let cells = sheet.rows.get(row);
    if (!cells) sheet.rows.set(row, (cells = []));
    cells[col] = csvCell(v);
    collected += v.length + 1;
  };

  const finish = (s: Sheet) => {
    const lines: string[] = [];
    for (const row of [...s.rows.keys()].sort((a, b) => a - b)) {
      const cells = Array.from(s.rows.get(row)!, (v) => v ?? "");
      if (cells.length > 0) lines.push(cells.join(","));
    }
    if (lines.length === 0) return;
    const block = `## Sheet: ${s.name}\n\n${lines.join("\n")}`;
    out.push(block);
    length += block.length + 2;
  };

  for (const rec of records(stream)) {
    const d = rec.data;
    if (CELL_RECORDS.has(rec.type)) pendingString = null;
    switch (rec.type) {
      case BOF: {
        depth++;
        if (depth > 1) break;
        const kind = u16(d, 2);
        if (kind === WORKSHEET) {
          const byOffset = declared.find((s) => s.offset === rec.offset);
          const name = byOffset?.name ?? declared[sheetsSeen]?.name ?? `Sheet ${sheetsSeen + 1}`;
          sheetsSeen++;
          sheet = { name, rows: new Map() };
          collected = length;
        }
        break;
      }
      case EOF:
        depth = Math.max(0, depth - 1);
        if (depth === 0 && sheet) {
          finish(sheet);
          sheet = null;
          if (collected > maxChars || length > maxChars) truncated = true;
        }
        break;
      case FILEPASS:
        throw new PasswordProtected();
      case CODEPAGE: {
        const cp = u16(d, 0);
        decode8 = cp === 1254 ? decodeWindows1254 : decodeWindows1252;
        break;
      }
      case BOUNDSHEET: {
        if (d.length < 8) break;
        const offset = u32(d, 0);
        const type = d[5];
        let name: string;
        if (biff8) {
          const count = d[6];
          name = new Parts([d.subarray(8)]).chars(count, (d[7] & 0x01) !== 0);
        } else {
          name = byteString(d, 6, 1);
        }
        // Chart sheets, macro sheets and VBA modules have no cells to read.
        if (type === 0) declared.push({ offset, name });
        break;
      }
      case SST: {
        const r = new Parts([d, ...rec.more]);
        r.skip(4);
        const unique = r.u32();
        sst = [];
        while (sst.length < unique && !r.done()) sst.push(r.string());
        break;
      }
      case STRING: {
        // No row or column of its own: it is the result of the FORMULA just
        // before it (a shared-formula or array record may come between).
        if (!pendingString || !sheet || depth !== 1) break;
        const text = biff8 ? new Parts([d, ...rec.more]).string() : byteString(d, 0, 2);
        set(pendingString.row, pendingString.col, text);
        pendingString = null;
        break;
      }
      default: {
        if (!sheet || depth !== 1 || d.length < 6) break;
        const row = u16(d, 0);
        const col = u16(d, 2);
        switch (rec.type) {
          case LABELSST:
            if (d.length >= 10) set(row, col, sst[u32(d, 6)] ?? "");
            break;
          case LABEL:
          case RSTRING:
            set(
              row,
              col,
              biff8 ? new Parts([d.subarray(6), ...rec.more]).string() : byteString(d, 6, 2),
            );
            break;
          case NUMBER:
            if (d.length >= 14) set(row, col, String(float64(d, 6)));
            break;
          case RK:
            if (d.length >= 10) set(row, col, String(rkValue(u32(d, 6))));
            break;
          case MULRK: {
            const n = Math.floor((d.length - 6) / 6);
            for (let i = 0; i < n; i++) set(row, col + i, String(rkValue(u32(d, 4 + i * 6 + 2))));
            break;
          }
          case FORMULA: {
            if (d.length < 14) break;
            if (d[12] !== 0xff || d[13] !== 0xff) {
              set(row, col, String(float64(d, 6)));
            } else if (d[6] === 0x00) {
              pendingString = { row, col };
            } else if (d[6] === 0x01) {
              set(row, col, d[8] ? "TRUE" : "FALSE");
            } else if (d[6] === 0x02) {
              set(row, col, ERRORS[d[8]] ?? "#ERROR");
            }
            break;
          }
          case BOOLERR:
            if (d.length >= 8) {
              set(row, col, d[7] ? (ERRORS[d[6]] ?? "#ERROR") : d[6] ? "TRUE" : "FALSE");
            }
            break;
        }
      }
    }
    if (truncated) break;
  }
  if (sheet) finish(sheet);
  // A workbook of chart sheets alone has no cells, and comes back empty: the
  // caller's "no readable text" is the true answer for it.
  return { text: out.join("\n\n"), truncated: truncated || length > maxChars };
}
