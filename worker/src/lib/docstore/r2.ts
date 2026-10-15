import type { DocStore, StoredObject, UploadedPart } from "./types";

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
    async getRange(key, offset, length) {
      if (length <= 0) {
        const head = await bucket.head(key);
        return head ? { bytes: new Uint8Array(0), size: head.size } : null;
      }
      const obj = await bucket.get(key, { range: { offset, length } });
      if (!obj) return null;
      return { bytes: new Uint8Array(await obj.arrayBuffer()), size: obj.size };
    },
    async createMultipart(key, opts) {
      const upload = await bucket.createMultipartUpload(key, {
        httpMetadata: { contentType: opts.contentType },
      });
      return upload.uploadId;
    },
    async uploadPart(key, uploadId, partNumber, body): Promise<UploadedPart> {
      const part = await bucket.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, body);
      return { partNumber: part.partNumber, etag: part.etag };
    },
    async completeMultipart(key, uploadId, parts) {
      await bucket.resumeMultipartUpload(key, uploadId).complete(parts);
    },
    async abortMultipart(key, uploadId) {
      try {
        await bucket.resumeMultipartUpload(key, uploadId).abort();
      } catch {
        // Already completed, aborted or expired: nothing is left to abort.
      }
    },
  };
}
