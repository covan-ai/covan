import type { DocStore, StoredObject } from "./types";

/**
 * The production store. A thin mapping onto the R2 binding — R2 already has the
 * exact semantics the interface promises, including a null return for a missing
 * key and a delete that tolerates absence.
 */
export function r2DocStore(bucket: R2Bucket): DocStore {
  return {
    async get(key: string): Promise<StoredObject | null> {
      const obj = await bucket.get(key);
      if (!obj) return null;
      return {
        body: obj.body as ReadableStream<Uint8Array>,
        contentType: obj.httpMetadata?.contentType,
        arrayBuffer: () => obj.arrayBuffer(),
      };
    },
    async put(key: string, body: ArrayBuffer, opts: { contentType: string }): Promise<void> {
      await bucket.put(key, body, { httpMetadata: { contentType: opts.contentType } });
    },
    async delete(key: string): Promise<void> {
      await bucket.delete(key);
    },
  };
}
