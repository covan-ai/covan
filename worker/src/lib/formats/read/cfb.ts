import type { RangeReader } from "./zip";

/**
 * Just enough of a Compound File reader to get the text out of an old Office
 * file.
 *
 * `.doc`, `.xls` and `.ppt` — Office 97 to 2003 — are not zips. Each is a
 * Compound File Binary ([MS-CFB]): a little FAT file system inside one file,
 * with a directory of named streams ("WordDocument", "Workbook", "PowerPoint
 * Document") whose bytes are scattered over fixed-size sectors and chained
 * together by a sector allocation table. This reads the header, the table and
 * the directory, and then only the streams it is asked for — a 40 MB deck
 * whose bulk is the "Pictures" stream costs its few hundred kilobytes of text
 * records.
 *
 * A compound file states its own layout and a hostile one can state anything:
 * chains that loop, sectors past the end, a table claiming a billion entries.
 * So every sector number is checked against the file's real size, every chain
 * is walked with a visited bitmap, and every stream is read under a ceiling
 * (`maxBytes`). Anything that does not hold together is a `CfbError`, which
 * `extractText` turns into the same "this does not read as a .doc file" a
 * broken zip gets. Nothing here can loop forever or allocate more than the
 * file could honestly need.
 *
 * Not supported, because no Office file needs it: writing, and streams inside
 * storages other than the root (an embedded object's own streams are its
 * business, not the document's).
 */

export class CfbError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CfbError";
  }
}

/**
 * The file is encrypted. Its own error rather than a `CfbError`, because the
 * person needs a different sentence: the file is fine, it is just locked.
 */
export class PasswordProtected extends Error {
  constructor() {
    super("password-protected");
    this.name = "PasswordProtected";
  }
}

export const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
export const u32 = (b: Uint8Array, at: number) =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
/** Sector numbers above this are markers (end of chain, free, FAT, DIFAT), not sectors. */
const MAXREGSECT = 0xfffffffa;
const NOSTREAM = 0xffffffff;
/** FAT sector numbers held in the header itself; the rest are in DIFAT sectors. */
const HEADER_DIFAT = 109;
const DIR_ENTRY = 128;
const MINI_SECTOR = 64;
/** A real directory has tens of entries; a few thousand is a document full of embedded objects. */
const MAX_DIRECTORY_BYTES = 4 * 1024 * 1024;
/**
 * The mini stream holds every stream under 4,096 bytes, one after another.
 * Kilobytes in a real file; it is read whole the first time a small stream
 * is asked for, so it gets a ceiling of its own.
 */
const MAX_MINI_STREAM_BYTES = 16 * 1024 * 1024;
/**
 * Sectors in a chain are mostly contiguous, so a run of them is one read. A
 * small forward gap is read through rather than split, which keeps a stream
 * interleaved with another to a handful of reads; a run is capped so no one
 * read is large.
 */
const GAP_SECTORS = 8;
const MAX_RUN_SECTORS = 2048;

export function isCfb(head: Uint8Array): boolean {
  return SIGNATURE.every((b, i) => head[i] === b);
}

export type CompoundFile = {
  /** Whether the root storage holds a stream of this name (compared as CFB does, ignoring case). */
  has(name: string): boolean;
  /** A root-level stream's bytes, or null when there is none. Throws past `maxBytes`. */
  stream(name: string, maxBytes: number): Promise<Uint8Array | null>;
};

type Entry = { name: string; type: number; start: number; size: number };

/** Opens the compound file of `size` bytes behind `read`. */
export async function openCfb(read: RangeReader, size: number): Promise<CompoundFile> {
  if (size < 512) throw new CfbError("too short to be an Office 97-2003 file");
  const header = await read(0, 512);
  if (header.length < 512 || !isCfb(header)) {
    throw new CfbError("not an Office 97-2003 file (no compound file header)");
  }
  if (u16(header, 0x1c) !== 0xfffe) throw new CfbError("the file header is damaged");
  const major = u16(header, 0x1a);
  const shift = u16(header, 0x1e);
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12))) {
    throw new CfbError(`compound file version ${major} is not supported`);
  }
  if (u16(header, 0x20) !== 6) throw new CfbError("the file header is damaged");
  const sectorSize = 1 << shift;
  // Sector n starts at (n + 1) × sectorSize: the header fills sector "-1".
  const sectorCount = Math.ceil(Math.max(0, size - sectorSize) / sectorSize);
  const perSector = sectorSize / 4;

  const numFat = u32(header, 0x2c);
  const firstDir = u32(header, 0x30);
  const miniCutoff = u32(header, 0x38);
  const firstMiniFat = u32(header, 0x3c);
  const firstDifat = u32(header, 0x44);
  // A FAT needs one entry per sector of the file. Some slack is allowed; a
  // header claiming far more is lying about a file that is not there.
  if (numFat === 0 || numFat > 2 * Math.ceil(sectorCount / perSector) + 16) {
    throw new CfbError("the sector table's size does not match the file");
  }

  /**
   * The bytes of `sectors`, in order. Short only when the very last sector
   * runs past the end of the file, which some writers do to the final one.
   */
  async function readSectors(sectors: number[]): Promise<Uint8Array> {
    const out = new Uint8Array(sectors.length * sectorSize);
    let length = 0;
    let i = 0;
    while (i < sectors.length) {
      const first = sectors[i];
      let j = i + 1;
      while (
        j < sectors.length &&
        sectors[j] > sectors[j - 1] &&
        sectors[j] - sectors[j - 1] <= GAP_SECTORS &&
        sectors[j] - first < MAX_RUN_SECTORS
      ) {
        j++;
      }
      const from = (first + 1) * sectorSize;
      const to = Math.min(size, (sectors[j - 1] + 2) * sectorSize);
      const bytes = await read(from, to - from);
      for (let k = i; k < j; k++) {
        const at = (sectors[k] - first) * sectorSize;
        const piece = bytes.subarray(at, at + sectorSize);
        if (piece.length < sectorSize && k !== sectors.length - 1) {
          throw new CfbError("the file is cut short");
        }
        out.set(piece, k * sectorSize);
        length = k * sectorSize + piece.length;
      }
      i = j;
    }
    return out.subarray(0, length);
  }

  const checkSector = (n: number) => {
    if (n >= sectorCount) throw new CfbError("a sector is past the end of the file");
  };

  // ---- The FAT, found through the DIFAT ----
  const fatSectors: number[] = [];
  for (let i = 0; i < HEADER_DIFAT && fatSectors.length < numFat; i++) {
    fatSectors.push(u32(header, 0x4c + i * 4));
  }
  let difat = firstDifat;
  let hops = 0;
  while (fatSectors.length < numFat) {
    if (difat > MAXREGSECT) throw new CfbError("the sector table is incomplete");
    checkSector(difat);
    if (++hops > sectorCount) throw new CfbError("the sector table's index loops");
    const d = await readSectors([difat]);
    if (d.length < sectorSize) throw new CfbError("the file is cut short");
    for (let i = 0; i < perSector - 1 && fatSectors.length < numFat; i++) {
      fatSectors.push(u32(d, i * 4));
    }
    difat = u32(d, sectorSize - 4);
  }
  fatSectors.forEach(checkSector);
  const fatBytes = await readSectors(fatSectors);
  if (fatBytes.length < numFat * sectorSize) throw new CfbError("the file is cut short");
  const fat = new Uint32Array(numFat * perSector);
  for (let i = 0; i < fat.length; i++) fat[i] = u32(fatBytes, i * 4);

  /**
   * The sectors of the chain starting at `start`, stopping after `limit` —
   * the most the caller can use, so a chain longer than its stream costs
   * nothing past that. A chain that comes back to a sector it has already
   * been through is a loop, and a loop in a sector table is a damaged or
   * hostile file, never a real one.
   */
  function chain(start: number, limit: number, table: Uint32Array, count: number): number[] {
    const out: number[] = [];
    const seen = new Uint8Array(count);
    let n = start;
    while (n <= MAXREGSECT && out.length < limit) {
      if (n >= count || n >= table.length) throw new CfbError("a sector chain leaves the file");
      if (seen[n]) throw new CfbError("a sector chain loops back on itself");
      seen[n] = 1;
      out.push(n);
      n = table[n];
    }
    return out;
  }

  // ---- The directory ----
  const dirChain = chain(firstDir, MAX_DIRECTORY_BYTES / sectorSize, fat, sectorCount);
  const dir = await readSectors(dirChain);
  const entryCount = Math.floor(dir.length / DIR_ENTRY);
  if (entryCount === 0) throw new CfbError("the file has no directory");

  const entryAt = (id: number) => {
    const at = id * DIR_ENTRY;
    const nameBytes = Math.min(64, u16(dir, at + 0x40));
    let name = "";
    for (let i = 0; i + 1 < nameBytes - 1; i += 2) {
      const c = u16(dir, at + i);
      if (c === 0) break;
      name += String.fromCharCode(c);
    }
    // Version 3 files may leave garbage in the high half of the size; the
    // specification says to ignore it.
    const sizeLow = u32(dir, at + 0x78);
    const sizeHigh = major === 3 ? 0 : u32(dir, at + 0x7c);
    return {
      name,
      type: dir[at + 0x42],
      start: u32(dir, at + 0x74),
      size: sizeLow + sizeHigh * 2 ** 32,
      left: u32(dir, at + 0x44),
      right: u32(dir, at + 0x48),
      child: u32(dir, at + 0x4c),
    };
  };

  const root = entryAt(0);
  if (root.type !== 5) throw new CfbError("the file's directory is damaged");

  // The root's own children only: a tree of left and right siblings under
  // its `child`. An embedded Word document keeps a "WordDocument" stream of
  // its own one storage down, and that one is not this document's text.
  const streams = new Map<string, Entry>();
  const visited = new Uint8Array(entryCount);
  const pending = [root.child];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (id === NOSTREAM) continue;
    if (id >= entryCount || visited[id]) throw new CfbError("the file's directory is damaged");
    visited[id] = 1;
    const e = entryAt(id);
    if (e.type === 2) {
      const key = e.name.toUpperCase();
      if (!streams.has(key)) {
        streams.set(key, { name: e.name, type: e.type, start: e.start, size: e.size });
      }
    }
    pending.push(e.left, e.right);
  }

  // ---- The mini stream, read only when a small stream is asked for ----
  let mini: { fat: Uint32Array; data: Uint8Array } | null = null;
  async function miniStream() {
    if (mini) return mini;
    if (root.size > MAX_MINI_STREAM_BYTES) {
      throw new CfbError("the file's small-stream store is too large");
    }
    const dataSectors = Math.ceil(root.size / sectorSize);
    const data = (await readSectors(chain(root.start, dataSectors, fat, sectorCount))).subarray(
      0,
      root.size,
    );
    if (data.length < root.size) throw new CfbError("the file is cut short");
    const miniCount = Math.floor(root.size / MINI_SECTOR);
    // One four-byte entry per mini sector is all the table can usefully hold.
    const miniFatSectors = chain(
      firstMiniFat,
      Math.ceil((miniCount * 4) / sectorSize),
      fat,
      sectorCount,
    );
    const miniFatBytes = await readSectors(miniFatSectors);
    const table = new Uint32Array(Math.floor(miniFatBytes.length / 4));
    for (let i = 0; i < table.length; i++) table[i] = u32(miniFatBytes, i * 4);
    mini = { fat: table, data };
    return mini;
  }

  return {
    has(name) {
      return streams.has(name.toUpperCase());
    },

    async stream(name, maxBytes) {
      const entry = streams.get(name.toUpperCase());
      if (!entry) return null;
      if (entry.size > maxBytes) throw new CfbError(`${entry.name}: larger than allowed`);
      if (entry.size === 0) return new Uint8Array(0);

      if (entry.size < miniCutoff) {
        const { fat: miniFat, data } = await miniStream();
        const count = Math.floor(data.length / MINI_SECTOR);
        const sectors = chain(entry.start, Math.ceil(entry.size / MINI_SECTOR), miniFat, count);
        const out = new Uint8Array(sectors.length * MINI_SECTOR);
        sectors.forEach((n, i) =>
          out.set(data.subarray(n * MINI_SECTOR, (n + 1) * MINI_SECTOR), i * MINI_SECTOR),
        );
        if (out.length < entry.size) throw new CfbError(`${entry.name}: ends early`);
        return out.subarray(0, entry.size);
      }

      const sectors = chain(entry.start, Math.ceil(entry.size / sectorSize), fat, sectorCount);
      const bytes = await readSectors(sectors);
      if (bytes.length < entry.size) throw new CfbError(`${entry.name}: ends early`);
      return bytes.subarray(0, entry.size);
    },
  };
}
