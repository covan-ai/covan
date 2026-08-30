/**
 * A ZIP writer, by hand, because the alternative was worse.
 *
 * An export has to be one file — a person who is leaving should get one thing,
 * not a folder of eleven — and it has to hold two kinds of content that cannot
 * share a format: structured rows, which want JSON, and document bytes, which
 * are whatever the person uploaded. A container is the only way to have both.
 *
 * Nothing here compresses. Every entry is stored, method 0, which sounds
 * wasteful until you count what is actually in the archive: the JSON compresses
 * well and is small, and the documents are mostly PDFs and images that are
 * already compressed. What deflate would buy is a few percent on the small half,
 * paid for with a compression library that has to work on both runtimes and a
 * dependency in a Worker that is otherwise dependency-light. Every unzip
 * implementation in existence reads stored entries.
 *
 * The output streams. Entries arrive one at a time and each is written and
 * dropped, so peak memory is one entry rather than the whole archive — which
 * matters because a document is capped at 10 MB (`routes/bundles.ts`) but a
 * workspace holding two hundred of them is not capped at anything.
 *
 * Not implemented, deliberately: Zip64. It would be needed past 4 GB of
 * archive, or more than 65,535 entries, and `writeZip` refuses rather than
 * silently emitting an archive whose offsets have wrapped — a truncated export
 * that opens is worse than one that never existed.
 */

/** One file in the archive. `data` is held only while it is written. */
export type ZipEntry = { name: string; data: Uint8Array };

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

/** UTF-8 names. Bit 11, and the reason the archive survives a Turkish filename. */
const FLAG_UTF8 = 0x0800;

/**
 * A fixed DOS timestamp — 1980-01-01 00:00, the epoch of the format itself.
 *
 * Real modification times are in `manifest.json` and in every row's own
 * `created_at`. Putting a clock in the header instead would make two exports of
 * an unchanged workspace differ byte for byte, which costs the one property
 * worth having here: you can diff two archives, or hash one, and have the
 * answer mean something.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const MAX_ENTRIES = 0xffff;
const MAX_SIZE = 0xffffffff;

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Little-endian writer over a fixed-size buffer. */
function writer(size: number) {
  const buf = new Uint8Array(size);
  const view = new DataView(buf.buffer);
  let at = 0;
  return {
    u16(v: number) {
      view.setUint16(at, v, true);
      at += 2;
    },
    u32(v: number) {
      view.setUint32(at, v >>> 0, true);
      at += 4;
    },
    bytes(v: Uint8Array) {
      buf.set(v, at);
      at += v.length;
    },
    done() {
      return buf;
    },
  };
}

/**
 * Writes the archive, one entry at a time, into a stream.
 *
 * Takes an async iterable rather than an array so the caller can fetch each
 * document only when it is about to be written — the difference between holding
 * one document in memory and holding all of them.
 */
export function writeZip(entries: AsyncIterable<ZipEntry>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      type Central = { name: Uint8Array; crc: number; size: number; offset: number };
      const central: Central[] = [];
      let offset = 0;

      const push = (chunk: Uint8Array) => {
        controller.enqueue(chunk);
        offset += chunk.length;
      };

      try {
        for await (const entry of entries) {
          const name = encoder.encode(entry.name);
          const size = entry.data.length;

          // Checked before the CRC is computed, not after: the guards are about
          // an archive too big to address, and hashing a gigabyte to then refuse
          // to write it is work done for nothing.
          if (central.length >= MAX_ENTRIES) {
            throw new Error(
              `Export has more than ${MAX_ENTRIES} entries, which needs Zip64. ` +
                `Split the workspace, or add Zip64 support to lib/export/zip.ts.`,
            );
          }
          if (offset + size > MAX_SIZE) {
            throw new Error(
              `Export would exceed 4 GB, which needs Zip64. ` +
                `Add Zip64 support to lib/export/zip.ts rather than shipping a truncated archive.`,
            );
          }

          const crc = crc32(entry.data);
          const header = writer(30 + name.length);
          header.u32(LOCAL_SIG);
          header.u16(20); // version needed
          header.u16(FLAG_UTF8);
          header.u16(0); // stored
          header.u16(DOS_TIME);
          header.u16(DOS_DATE);
          header.u32(crc);
          header.u32(size); // compressed
          header.u32(size); // uncompressed
          header.u16(name.length);
          header.u16(0); // extra
          header.bytes(name);

          central.push({ name, crc, size, offset });
          push(header.done());
          push(entry.data);
        }

        const cdStart = offset;
        for (const e of central) {
          const rec = writer(46 + e.name.length);
          rec.u32(CENTRAL_SIG);
          rec.u16(20); // version made by
          rec.u16(20); // version needed
          rec.u16(FLAG_UTF8);
          rec.u16(0); // stored
          rec.u16(DOS_TIME);
          rec.u16(DOS_DATE);
          rec.u32(e.crc);
          rec.u32(e.size);
          rec.u32(e.size);
          rec.u16(e.name.length);
          rec.u16(0); // extra
          rec.u16(0); // comment
          rec.u16(0); // disk
          rec.u16(0); // internal attrs
          rec.u32(0); // external attrs
          rec.u32(e.offset);
          rec.bytes(e.name);
          push(rec.done());
        }

        const eocd = writer(22);
        eocd.u32(EOCD_SIG);
        eocd.u16(0); // this disk
        eocd.u16(0); // disk with central directory
        eocd.u16(central.length);
        eocd.u16(central.length);
        eocd.u32(offset - cdStart);
        eocd.u32(cdStart);
        eocd.u16(0); // comment length
        push(eocd.done());

        controller.close();
      } catch (e) {
        // Aborts the response mid-body, which a client sees as a truncated
        // download rather than as a complete archive. That is the point: by the
        // time the first byte is out there is no status code left to change.
        controller.error(e);
      }
    },
  });
}
