/**
 * Just enough of a zip reader to get the text out of an Office file.
 *
 * `.docx`, `.pptx`, `.xlsx` and `.odt` are zip archives of XML. Their text is
 * in one or a few small entries, and the archive's index — the central
 * directory — is at the very end. So this reads the tail, finds the entries it
 * was asked for, and fetches only their bytes: a 90 MB deck whose bulk is
 * images costs the few hundred kilobytes of its slide XML, not 90 MB of a
 * Worker's 128.
 *
 * Inflating uses `DecompressionStream("deflate-raw")`, which Workers, Node and
 * Bun all have, so there is no dependency and nothing to bundle. Every entry
 * is inflated under a ceiling (`maxBytes`), because a zip states its own sizes
 * and a hostile one can state anything: a few kilobytes that inflate to
 * gigabytes is the oldest trick there is.
 *
 * Not supported, because no Office file needs them: zip64 (archives over
 * 4 GB), encryption, and compression methods other than stored and deflate.
 */

/** Reads `length` bytes at `offset` of the archive. */
export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;

export type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
};

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** The end record is 22 bytes, and may be followed by a comment of up to 65,535. */
const EOCD_SEARCH = 22 + 0xffff;

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number) =>
  (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** The archive's entries, from its central directory. */
export async function listZip(read: RangeReader, size: number): Promise<ZipEntry[]> {
  if (size < 22) throw new ZipError("too short to be a zip archive");
  const tailStart = Math.max(0, size - EOCD_SEARCH);
  const tail = await read(tailStart, size - tailStart);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("not a zip archive (no end-of-directory record)");

  const count = u16(tail, eocd + 10);
  const dirSize = u32(tail, eocd + 12);
  const dirOffset = u32(tail, eocd + 16);
  if (dirOffset === 0xffffffff || count === 0xffff) {
    throw new ZipError("zip64 archives are not supported");
  }
  if (dirOffset + dirSize > size) throw new ZipError("the archive's directory is past its end");

  const dir = await read(dirOffset, dirSize);
  const entries: ZipEntry[] = [];
  let at = 0;
  const utf8 = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (at + 46 > dir.length || u32(dir, at) !== CENTRAL_SIGNATURE) {
      throw new ZipError("the archive's directory is damaged");
    }
    const nameLength = u16(dir, at + 28);
    const extraLength = u16(dir, at + 30);
    const commentLength = u16(dir, at + 32);
    entries.push({
      method: u16(dir, at + 10),
      compressedSize: u32(dir, at + 20),
      uncompressedSize: u32(dir, at + 24),
      localHeaderOffset: u32(dir, at + 42),
      // Office writes UTF-8 names (and ASCII ones, which are the same bytes).
      name: utf8.decode(dir.subarray(at + 46, at + 46 + nameLength)),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's bytes, inflated, refusing to grow past `maxBytes`. */
export async function readZipEntry(
  read: RangeReader,
  entry: ZipEntry,
  maxBytes: number,
): Promise<Uint8Array> {
  const header = await read(entry.localHeaderOffset, 30);
  if (header.length < 30 || u32(header, 0) !== LOCAL_SIGNATURE) {
    throw new ZipError(`${entry.name}: damaged entry header`);
  }
  const dataStart = entry.localHeaderOffset + 30 + u16(header, 26) + u16(header, 28);
  const data = await read(dataStart, entry.compressedSize);

  if (entry.method === 0) {
    if (data.length > maxBytes) throw new ZipError(`${entry.name}: larger than allowed`);
    return data;
  }
  if (entry.method !== 8) {
    throw new ZipError(`${entry.name}: compression method ${entry.method} is not supported`);
  }
  return inflateRaw(data, maxBytes, entry.name);
}

async function inflateRaw(data: Uint8Array, maxBytes: number, name: string): Promise<Uint8Array> {
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  // Not awaited: the writable side only settles as the readable side drains,
  // so waiting here would wait forever on anything larger than its buffer.
  writer.write(data as unknown as BufferSource).catch(() => {});
  writer.close().catch(() => {});

  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ZipError(`${name}: inflates past the allowed size`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof ZipError) throw err;
    throw new ZipError(`${name}: could not be inflated (${(err as Error).message})`);
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
