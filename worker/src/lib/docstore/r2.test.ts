import { describeDocStoreContract } from "./contract";
import { r2DocStore } from "./r2";
import type { DocStore } from "./types";

/**
 * An in-memory stand-in for R2 covering exactly the surface r2DocStore uses.
 * Running the real binding would need miniflare; the contract test is about the
 * adapter's mapping, not about R2 itself.
 */
function fakeBucket() {
  const objects = new Map<string, { bytes: ArrayBuffer; contentType?: string }>();
  const uploads = new Map<
    string,
    { key: string; contentType?: string; parts: Map<number, Uint8Array> }
  >();
  return {
    async get(key: string, opts?: { range?: { offset: number; length: number } }) {
      const hit = objects.get(key);
      if (!hit) return null;
      if (opts?.range) {
        const { offset, length } = opts.range;
        const slice = hit.bytes.slice(offset, offset + length);
        return { size: hit.bytes.byteLength, arrayBuffer: async () => slice };
      }
      return {
        body: new Response(hit.bytes).body!,
        httpMetadata: { contentType: hit.contentType },
        arrayBuffer: async () => hit.bytes,
      };
    },
    async put(key: string, bytes: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }) {
      objects.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async head(key: string) {
      const hit = objects.get(key);
      return hit ? { size: hit.bytes.byteLength } : null;
    },
    async createMultipartUpload(key: string, opts?: { httpMetadata?: { contentType?: string } }) {
      const uploadId = crypto.randomUUID();
      uploads.set(uploadId, {
        key,
        contentType: opts?.httpMetadata?.contentType,
        parts: new Map(),
      });
      return { uploadId };
    },
    resumeMultipartUpload(key: string, uploadId: string) {
      const live = () => {
        const upload = uploads.get(uploadId);
        if (!upload || upload.key !== key) throw new Error("no such upload");
        return upload;
      };
      return {
        async uploadPart(partNumber: number, body: ArrayBuffer) {
          live().parts.set(partNumber, new Uint8Array(body));
          return { partNumber, etag: `etag-${partNumber}` };
        },
        async complete(parts: Array<{ partNumber: number; etag: string }>) {
          const upload = live();
          const chunks = [...parts]
            .sort((a, b) => a.partNumber - b.partNumber)
            .map((p) => upload.parts.get(p.partNumber)!);
          const joined = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
          let at = 0;
          for (const c of chunks) {
            joined.set(c, at);
            at += c.byteLength;
          }
          objects.set(key, { bytes: joined.buffer, contentType: upload.contentType });
          uploads.delete(uploadId);
        },
        async abort() {
          live();
          uploads.delete(uploadId);
        },
      };
    },
  };
}

describeDocStoreContract("r2", async (): Promise<DocStore> =>
  r2DocStore(fakeBucket() as unknown as R2Bucket),
);
