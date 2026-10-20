import { makeCfb } from "./make-cfb";

/**
 * Minimal Word, Excel and PowerPoint 97-2003 files, built from their parts.
 *
 * Each builder writes only what a reader of text needs — a Word header and
 * piece table, BIFF8 records, PowerPoint record trees — wrapped in a real
 * compound file by `makeCfb`. They are written from the specifications
 * ([MS-DOC], [MS-XLS], [MS-PPT]) rather than captured from Office, so a test
 * says exactly which structure it exercises.
 */

export const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
export const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

export const utf16 = (s: string) => [...s].flatMap((c) => le16(c.charCodeAt(0)));
/** One byte per character: Latin-1, with the few Windows-1252 punctuation marks a test uses. */
export function bytes8(s: string): number[] {
  const extra: Record<string, number> = { "€": 0x80, "“": 0x93, "”": 0x94, "–": 0x96, Ž: 0x8e };
  return [...s].map((c) => {
    const code = c.charCodeAt(0);
    if (code < 0x100) return code;
    if (extra[c] !== undefined) return extra[c];
    throw new Error(`${c} has no single-byte form`);
  });
}

// ---- Word -----------------------------------------------------------------------

export type DocPiece = { text: string; compressed: boolean };

/**
 * A `.doc` whose text is `pieces`, in that order. The WordDocument stream is
 * padded past the mini-stream cutoff, as Word's always is, and the table
 * stream is small, so both of a compound file's ways of storing a stream are
 * read.
 */
export function makeDoc(
  pieces: DocPiece[],
  options: { encrypted?: boolean; ccpText?: number; ccpFtn?: number } = {},
): Uint8Array {
  // The header (FIB) takes the first 900 bytes; text starts after it.
  const word: number[] = new Array(1024).fill(0);
  const placed: { cp: number; fc: number }[] = [];
  let cp = 0;
  for (const p of pieces) {
    while (word.length % 2) word.push(0);
    const offset = word.length;
    word.push(...(p.compressed ? bytes8(p.text) : utf16(p.text)));
    placed.push({ cp, fc: p.compressed ? (offset * 2) | 0x40000000 : offset });
    cp += p.text.length;
  }
  while (word.length < 5000) word.push(0);

  const put = (at: number, bytes: number[]) => bytes.forEach((b, i) => (word[at + i] = b));
  put(0, le16(0xa5ec));
  put(2, le16(0x00c1));
  put(0x0a, le16(0x0200 | (options.encrypted ? 0x0100 : 0)));
  put(32, le16(14));
  put(62, le16(22));
  put(64 + 3 * 4, le32(options.ccpText ?? cp));
  put(64 + 4 * 4, le32(options.ccpFtn ?? 0));
  put(152, le16(93));

  // A property block first, as Word writes one, so the reader has to skip it.
  const plc = [
    ...[...placed.map((p) => p.cp), cp].flatMap(le32),
    ...placed.flatMap((p) => [0, 0, ...le32(p.fc), 0, 0]),
  ];
  const clx = [0x01, ...le16(2), 0xaa, 0xbb, 0x02, ...le32(plc.length), ...plc];
  const table = [0, 0, 0, 0, ...clx];
  put(154 + 33 * 8, le32(4));
  put(154 + 33 * 8 + 4, le32(clx.length));

  return makeCfb({ WordDocument: new Uint8Array(word), "1Table": new Uint8Array(table) });
}

// ---- Excel ----------------------------------------------------------------------

export function biff(type: number, data: number[]): number[] {
  return [...le16(type), ...le16(data.length), ...data];
}

const cell = (row: number, col: number) => [...le16(row), ...le16(col), ...le16(0x0f)];

export const xl = {
  bof: (kind: number) =>
    biff(0x0809, [...le16(0x0600), ...le16(kind), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  eof: () => biff(0x000a, []),
  labelSst: (row: number, col: number, index: number) =>
    biff(0x00fd, [...cell(row, col), ...le32(index)]),
  number: (row: number, col: number, value: number) => {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, value, true);
    return biff(0x0203, [...cell(row, col), ...b]);
  },
  rk: (row: number, col: number, rk: number) => biff(0x027e, [...cell(row, col), ...le32(rk)]),
  mulrk: (row: number, col: number, rks: number[]) =>
    biff(0x00bd, [
      ...le16(row),
      ...le16(col),
      ...rks.flatMap((rk) => [...le16(0x0f), ...le32(rk)]),
      ...le16(col + rks.length - 1),
    ]),
  label: (row: number, col: number, text: string) =>
    biff(0x0204, [...cell(row, col), ...le16(text.length), 0x01, ...utf16(text)]),
  /** A formula whose cached result is a string, and the STRING record holding it. */
  formulaString: (row: number, col: number, text: string) => [
    ...biff(0x0006, [...cell(row, col), 0x00, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0]),
    ...biff(0x0207, [...le16(text.length), 0x01, ...utf16(text)]),
  ],
  boolerr: (row: number, col: number, value: number, isError: boolean) =>
    biff(0x0205, [...cell(row, col), value, isError ? 1 : 0]),
};

/**
 * A workbook stream: globals (BOF, the sheet list, `globals` — an SST, say —
 * and EOF), then each sheet's BOF, `cells` and EOF. Each BOUNDSHEET points at
 * its sheet's BOF, which takes a second pass once the globals' length is known.
 */
export function makeWorkbook(
  sheets: { name: string; cells: number[][] }[],
  globals: number[][] = [],
): Uint8Array {
  const boundsheet = (offset: number, name: string) =>
    biff(0x0085, [...le32(offset), 0, 0, name.length, 0x01, ...utf16(name)]);
  const bodies = sheets.map((s) => [...xl.bof(0x0010), ...s.cells.flat(), ...xl.eof()]);
  const head = (offsets: number[]) => [
    ...xl.bof(0x0005),
    ...biff(0x0042, le16(1200)),
    ...sheets.flatMap((s, i) => boundsheet(offsets[i], s.name)),
    ...globals.flat(),
    ...xl.eof(),
  ];
  const length = head(sheets.map(() => 0)).length;
  const offsets: number[] = [];
  let at = length;
  for (const b of bodies) {
    offsets.push(at);
    at += b.length;
  }
  return new Uint8Array([...head(offsets), ...bodies.flat()]);
}

export const makeXls = (workbook: Uint8Array) => makeCfb({ Workbook: workbook });

// ---- PowerPoint -----------------------------------------------------------------

export function pptAtom(type: number, data: number[], instance = 0): number[] {
  return [...le16(instance << 4), ...le16(type), ...le32(data.length), ...data];
}

export function pptContainer(type: number, children: number[][], instance = 0): number[] {
  const data = children.flat();
  return [...le16((instance << 4) | 0x0f), ...le16(type), ...le32(data.length), ...data];
}

export const textChars = (s: string) => pptAtom(0x0fa0, utf16(s));
export const textBytes = (s: string) => pptAtom(0x0fa8, bytes8(s));
export const slidePersist = (persistId: number, slideId: number) =>
  pptAtom(0x03f3, [...le32(persistId), 0, 0, 0, 0, 0, 0, 0, 0, ...le32(slideId), 0, 0, 0, 0]);
export const notesAtom = (slideId: number) => pptAtom(0x03f1, [...le32(slideId), 0, 0, 0, 0]);
export const persistDirectory = (first: number, offsets: number[]) =>
  pptAtom(0x1772, [...le32(first | (offsets.length << 20)), ...offsets.flatMap(le32)]);

export const makePpt = (stream: number[], extra: Record<string, Uint8Array> = {}) =>
  makeCfb({ "PowerPoint Document": new Uint8Array(stream), ...extra });
