/**
 * A Compound File Binary ([MS-CFB], version 3) holding `streams`, for the
 * readers of `.doc`, `.xls` and `.ppt`.
 *
 * Laid out the way Office lays one out, so the reader's real paths run:
 * streams under 4,096 bytes go in the mini stream with its own allocation
 * table, larger ones in ordinary 512-byte sectors, and a file big enough to
 * need more than 109 FAT sectors gets DIFAT sectors to list the rest. A name
 * with a slash ("ObjectPool/WordDocument") is a stream inside a storage.
 *
 * `loop` names a stream whose second sector is made to point back at its
 * first — a sector chain that never ends, which a reader must not follow
 * forever.
 */

const SECTOR = 512;
const MINI = 64;
const CUTOFF = 4096;
const FREE = 0xffffffff;
const END = 0xfffffffe;
const FATSECT = 0xfffffffd;
const DIFSECT = 0xfffffffc;
const NOSTREAM = 0xffffffff;

type Node = {
  name: string;
  type: 1 | 2 | 5;
  data: Uint8Array;
  children: Node[];
  id: number;
  start: number;
};

export function makeCfb(
  streams: Record<string, Uint8Array>,
  options: { loop?: string } = {},
): Uint8Array {
  const root: Node = {
    name: "Root Entry",
    type: 5,
    data: new Uint8Array(0),
    children: [],
    id: 0,
    start: END,
  };
  for (const [path, data] of Object.entries(streams)) {
    const parts = path.split("/");
    let parent = root;
    for (const storage of parts.slice(0, -1)) {
      let next = parent.children.find((c) => c.name === storage && c.type === 1);
      if (!next) {
        next = { name: storage, type: 1, data: new Uint8Array(0), children: [], id: 0, start: END };
        parent.children.push(next);
      }
      parent = next;
    }
    parent.children.push({ name: parts.at(-1)!, type: 2, data, children: [], id: 0, start: END });
  }

  const nodes: Node[] = [];
  const number = (n: Node) => {
    n.id = nodes.length;
    nodes.push(n);
    n.children.forEach(number);
  };
  number(root);
  const leaves = nodes.filter((n) => n.type === 2);
  const small = leaves.filter((n) => n.data.length > 0 && n.data.length < CUTOFF);
  const big = leaves.filter((n) => n.data.length >= CUTOFF);

  // ---- The mini stream and its table ----
  const miniFat: number[] = [];
  const miniChunks: Uint8Array[] = [];
  for (const n of small) {
    const count = Math.ceil(n.data.length / MINI);
    n.start = miniFat.length;
    for (let i = 0; i < count; i++) miniFat.push(i === count - 1 ? END : miniFat.length + 1);
    const padded = new Uint8Array(count * MINI);
    padded.set(n.data);
    miniChunks.push(padded);
  }
  const miniLength = miniFat.length * MINI;

  // ---- Sector counts, then the FAT that has to cover them all ----
  const sectorsFor = (bytes: number) => Math.ceil(bytes / SECTOR);
  const dirSectors = sectorsFor(nodes.length * 128);
  const miniFatSectors = sectorsFor(miniFat.length * 4);
  const miniStreamSectors = sectorsFor(miniLength);
  const bigSectors = big.map((n) => sectorsFor(n.data.length));
  const dataSectors =
    dirSectors + miniFatSectors + miniStreamSectors + bigSectors.reduce((a, b) => a + b, 0);
  let fatCount = 1;
  let difatCount = 0;
  for (;;) {
    const total = dataSectors + fatCount + difatCount;
    const f = Math.ceil(total / (SECTOR / 4));
    const d = f > 109 ? Math.ceil((f - 109) / (SECTOR / 4 - 1)) : 0;
    if (f === fatCount && d === difatCount) break;
    fatCount = f;
    difatCount = d;
  }
  const total = dataSectors + fatCount + difatCount;
  const fat = new Array<number>(fatCount * (SECTOR / 4)).fill(FREE);
  const file = new Uint8Array((1 + total) * SECTOR);
  const view = new DataView(file.buffer);
  const at = (sector: number) => (sector + 1) * SECTOR;

  let next = 0;
  const allocate = (count: number, mark?: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(next++);
    out.forEach((s, i) => (fat[s] = mark ?? (i === out.length - 1 ? END : out[i + 1])));
    return out;
  };
  const write = (sectors: number[], bytes: Uint8Array) =>
    sectors.forEach((s, i) => file.set(bytes.subarray(i * SECTOR, (i + 1) * SECTOR), at(s)));

  const fatSectors = allocate(fatCount, FATSECT);
  const difatSectors = allocate(difatCount, DIFSECT);
  const dir = allocate(dirSectors);
  const miniFatAt = allocate(miniFatSectors);
  const miniStreamAt = allocate(miniStreamSectors);
  for (const [i, n] of big.entries()) {
    const sectors = allocate(bigSectors[i]);
    n.start = sectors[0];
    write(sectors, n.data);
    if (options.loop === n.name && sectors.length > 2) fat[sectors[1]] = sectors[0];
  }

  // ---- Mini stream data and table ----
  const miniData = new Uint8Array(miniStreamSectors * SECTOR);
  let o = 0;
  for (const c of miniChunks) {
    miniData.set(c, o);
    o += c.length;
  }
  write(miniStreamAt, miniData);
  const miniFatBytes = new Uint8Array(miniFatSectors * SECTOR).fill(0xff);
  const mv = new DataView(miniFatBytes.buffer);
  miniFat.forEach((v, i) => mv.setUint32(i * 4, v, true));
  write(miniFatAt, miniFatBytes);
  root.start = miniStreamAt[0] ?? END;

  // ---- Directory ----
  const dirBytes = new Uint8Array(dirSectors * SECTOR);
  const dv = new DataView(dirBytes.buffer);
  for (let i = nodes.length; i < dirSectors * 4; i++) {
    dv.setUint32(i * 128 + 0x44, NOSTREAM, true);
    dv.setUint32(i * 128 + 0x48, NOSTREAM, true);
    dv.setUint32(i * 128 + 0x4c, NOSTREAM, true);
  }
  for (const n of nodes) {
    const e = n.id * 128;
    for (let i = 0; i < n.name.length; i++) dv.setUint16(e + i * 2, n.name.charCodeAt(i), true);
    dv.setUint16(e + 0x40, (n.name.length + 1) * 2, true);
    dirBytes[e + 0x42] = n.type;
    dirBytes[e + 0x43] = 1;
    dv.setUint32(e + 0x44, NOSTREAM, true);
    dv.setUint32(e + 0x48, NOSTREAM, true);
    dv.setUint32(e + 0x4c, n.children[0]?.id ?? NOSTREAM, true);
    dv.setUint32(e + 0x74, n.type === 2 && n.data.length === 0 ? END : n.start, true);
    dv.setUint32(e + 0x78, n.type === 5 ? miniLength : n.data.length, true);
  }
  // Siblings as a chain of right links: not a balanced red-black tree, but a
  // valid one to walk, which is all a reader does with it.
  for (const n of nodes) {
    n.children.forEach((c, i) => {
      const right = n.children[i + 1];
      if (right) dv.setUint32(c.id * 128 + 0x48, right.id, true);
    });
  }
  write(dir, dirBytes);

  // ---- FAT, DIFAT and header ----
  const fatBytes = new Uint8Array(fatCount * SECTOR);
  const fv = new DataView(fatBytes.buffer);
  fat.forEach((v, i) => fv.setUint32(i * 4, v, true));
  write(fatSectors, fatBytes);

  const perDifat = SECTOR / 4 - 1;
  difatSectors.forEach((s, k) => {
    const base = at(s);
    for (let i = 0; i < perDifat; i++) {
      const f = fatSectors[109 + k * perDifat + i];
      view.setUint32(base + i * 4, f ?? FREE, true);
    }
    view.setUint32(base + perDifat * 4, difatSectors[k + 1] ?? END, true);
  });

  file.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  view.setUint16(0x18, 0x003e, true);
  view.setUint16(0x1a, 3, true);
  view.setUint16(0x1c, 0xfffe, true);
  view.setUint16(0x1e, 9, true);
  view.setUint16(0x20, 6, true);
  view.setUint32(0x2c, fatCount, true);
  view.setUint32(0x30, dir[0], true);
  view.setUint32(0x38, CUTOFF, true);
  view.setUint32(0x3c, miniFatAt[0] ?? END, true);
  view.setUint32(0x40, miniFatSectors, true);
  view.setUint32(0x44, difatSectors[0] ?? END, true);
  view.setUint32(0x48, difatCount, true);
  for (let i = 0; i < 109; i++) view.setUint32(0x4c + i * 4, fatSectors[i] ?? FREE, true);
  return file;
}
