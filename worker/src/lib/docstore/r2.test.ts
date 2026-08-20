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
  return {
    async get(key: string) {
      const hit = objects.get(key);
      if (!hit) return null;
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
  };
}

describeDocStoreContract(
  "r2",
  async (): Promise<DocStore> => r2DocStore(fakeBucket() as unknown as R2Bucket),
);
