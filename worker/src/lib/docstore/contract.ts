import { describe, it, expect } from "vitest";
import type { DocStore } from "./types";

/**
 * Encode a string to an ArrayBuffer for `DocStore.put`. Under TS 5.7+'s generic
 * TypedArray typing, `Uint8Array.buffer` is `ArrayBufferLike` (which includes
 * `SharedArrayBuffer`), so it doesn't structurally satisfy `ArrayBuffer` on its
 * own. The cast is safe: `TextEncoder.encode()` never produces a
 * `SharedArrayBuffer`-backed view in any real runtime, so nothing is masked.
 */
function bytes(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

/**
 * The behaviour every DocStore owes its callers. Both r2.test.ts and fs.test.ts
 * call this, so the two implementations cannot drift apart — which is the whole
 * risk of running one codebase on two runtimes.
 */
export function describeDocStoreContract(name: string, make: () => Promise<DocStore>) {
  describe(`DocStore contract: ${name}`, () => {
    it("returns null for a key that was never written", async () => {
      const store = await make();
      expect(await store.get("nope/missing.txt")).toBeNull();
    });

    it("round-trips bytes", async () => {
      const store = await make();
      await store.put("a/one.txt", bytes("hello covan"), { contentType: "text/plain" });

      const got = await store.get("a/one.txt");
      expect(got).not.toBeNull();
      expect(new TextDecoder().decode(await got!.arrayBuffer())).toBe("hello covan");
    });

    it("round-trips the content type", async () => {
      const store = await make();
      await store.put("a/two.pdf", bytes("%PDF-1.4"), { contentType: "application/pdf" });

      const got = await store.get("a/two.pdf");
      expect(got?.contentType).toBe("application/pdf");
    });

    it("exposes a readable body stream", async () => {
      const store = await make();
      await store.put("a/three.txt", bytes("streamed"), { contentType: "text/plain" });

      const got = await store.get("a/three.txt");
      const text = await new Response(got!.body).text();
      expect(text).toBe("streamed");
    });

    it("deletes a key", async () => {
      const store = await make();
      await store.put("a/four.txt", bytes("bye"), { contentType: "text/plain" });
      await store.delete("a/four.txt");

      expect(await store.get("a/four.txt")).toBeNull();
    });

    it("does not throw when deleting a key that is not there", async () => {
      const store = await make();
      await expect(store.delete("a/never-existed.txt")).resolves.toBeUndefined();
    });

    it("overwrites both bytes and content type for an existing key", async () => {
      const store = await make();
      await store.put("a/five.txt", bytes("original"), { contentType: "text/plain" });
      await store.put("a/five.txt", bytes("replaced"), { contentType: "application/json" });

      const got = await store.get("a/five.txt");
      expect(got).not.toBeNull();
      expect(new TextDecoder().decode(await got!.arrayBuffer())).toBe("replaced");
      expect(got?.contentType).toBe("application/json");
    });

    it("keeps keys with slashes distinct", async () => {
      const store = await make();
      await store.put("bundle-a/doc.txt", bytes("one"), { contentType: "text/plain" });
      await store.put("bundle-b/doc.txt", bytes("two"), { contentType: "text/plain" });

      const a = await store.get("bundle-a/doc.txt");
      expect(new TextDecoder().decode(await a!.arrayBuffer())).toBe("one");
    });
  });
}
