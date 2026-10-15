import { createReadStream } from "node:fs";
import { appendFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { DocStore, StoredObject, UploadedPart } from "./types";

/** A multipart upload's id is ours, so it is always a UUID — checked, because it names a directory. */
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The self-hosted store: one file per object under `root`, plus a
 * `<key>.meta.json` sidecar holding the content type, which the filesystem
 * cannot carry on its own but documents.ts reads back on download.
 */
export function fsDocStore(root: string): DocStore {
  const base = resolve(root);

  /** Keys come from server-generated UUID paths, but verify anyway. */
  const pathFor = (key: string): string => {
    const full = resolve(base, key);
    if (full !== base && !full.startsWith(base + sep)) {
      throw new Error(`key resolves outside the store root: ${key}`);
    }
    return full;
  };

  const metaFor = (key: string): string => pathFor(key) + ".meta.json";

  /**
   * Where an unfinished upload's parts wait: beside the store's objects, under
   * a name no generated key can have (keys start with a bundle id).
   */
  const partsDir = (uploadId: string): string => {
    if (!UPLOAD_ID.test(uploadId)) throw new Error(`not an upload id: ${uploadId}`);
    return resolve(base, ".multipart", uploadId);
  };

  return {
    async get(key: string): Promise<StoredObject | null> {
      const file = pathFor(key);

      // Existence check only — no content read here. A missing object (ENOENT)
      // is the one case the contract promises `null` for; every other failure
      // (permission denied, the key resolving to a directory, ...) is a real
      // problem the caller needs to see, not something to paper over as "not
      // found". A misconfigured Docker volume mount is exactly this shape of
      // bug, and silently returning `null` would send an operator chasing a
      // missing-document report instead of a permissions fix.
      try {
        await stat(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }

      let contentType: string | undefined;
      try {
        const raw = await readFile(metaFor(key), "utf8");
        contentType = JSON.parse(raw).contentType;
      } catch {
        // No sidecar: either it predates the sidecar, or it's unreadable for
        // some benign reason. Content type is optional; the object itself
        // already proved it exists via the stat above.
      }

      return {
        contentType,
        // Neither accessor reads the file until the caller actually wants the
        // bytes — most callers use exactly one of `body` or `arrayBuffer()`,
        // so reading eagerly here would mean every `get()` reads the whole
        // object twice for no reason.
        get body(): ReadableStream<Uint8Array> {
          // Node's `stream/web` ReadableStream (from Readable.toWeb) and the
          // whatwg-standard one from @cloudflare/workers-types (this worker's
          // only DOM-ish lib, since tsconfig omits "dom") don't structurally
          // overlap enough for TS to accept a direct cast — their BYOB reader
          // shapes differ. Both are spec-compliant ReadableStreams at runtime,
          // so routing through `unknown` is safe here.
          return Readable.toWeb(createReadStream(file)) as unknown as ReadableStream<Uint8Array>;
        },
        async arrayBuffer(): Promise<ArrayBuffer> {
          const bytes = await readFile(file);
          return bytes.buffer.slice(
            bytes.byteOffset,
            bytes.byteOffset + bytes.byteLength,
          ) as ArrayBuffer;
        },
      };
    },

    async put(key: string, body: ArrayBuffer, opts: { contentType: string }): Promise<void> {
      const file = pathFor(key);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, Buffer.from(body));
      await writeFile(metaFor(key), JSON.stringify({ contentType: opts.contentType }));
    },

    async delete(key: string): Promise<void> {
      await rm(pathFor(key), { force: true });
      await rm(metaFor(key), { force: true });
    },

    async getRange(key, offset, length) {
      let handle;
      try {
        handle = await open(pathFor(key), "r");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      try {
        const { size } = await handle.stat();
        const start = Math.max(0, Math.min(offset, size));
        const want = Math.max(0, Math.min(length, size - start));
        const bytes = new Uint8Array(want);
        let read = 0;
        while (read < want) {
          const { bytesRead } = await handle.read(bytes, read, want - read, start + read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        return { bytes: read === want ? bytes : bytes.subarray(0, read), size };
      } finally {
        await handle.close();
      }
    },

    async createMultipart(key, opts) {
      pathFor(key); // refuse a key outside the root before anything is written
      const uploadId = crypto.randomUUID();
      const dir = partsDir(uploadId);
      await mkdir(dir, { recursive: true });
      await writeFile(resolve(dir, "upload.json"), JSON.stringify({ key, ...opts }));
      return uploadId;
    },

    async uploadPart(key, uploadId, partNumber, body): Promise<UploadedPart> {
      if (!Number.isInteger(partNumber) || partNumber < 1) {
        throw new Error(`not a part number: ${partNumber}`);
      }
      const dir = partsDir(uploadId);
      const meta = JSON.parse(await readFile(resolve(dir, "upload.json"), "utf8")) as {
        key: string;
      };
      if (meta.key !== key) throw new Error("this upload is for another key");
      await writeFile(resolve(dir, `${partNumber}.part`), Buffer.from(body));
      return { partNumber, etag: String(partNumber) };
    },

    async completeMultipart(key, uploadId, parts) {
      const dir = partsDir(uploadId);
      const meta = JSON.parse(await readFile(resolve(dir, "upload.json"), "utf8")) as {
        key: string;
        contentType: string;
      };
      if (meta.key !== key) throw new Error("this upload is for another key");
      const file = pathFor(key);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, Buffer.alloc(0));
      // One part at a time, so a 100 MB file is never in memory at once.
      for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
        await appendFile(file, await readFile(resolve(dir, `${part.partNumber}.part`)));
      }
      await writeFile(metaFor(key), JSON.stringify({ contentType: meta.contentType }));
      await rm(dir, { recursive: true, force: true });
    },

    async abortMultipart(_key, uploadId) {
      await rm(partsDir(uploadId), { recursive: true, force: true });
    },
  };
}
