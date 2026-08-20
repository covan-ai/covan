import { createReadStream } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { DocStore, StoredObject } from "./types";

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
  };
}
