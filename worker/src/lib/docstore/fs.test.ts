import { describeDocStoreContract } from "./contract";
import { fsDocStore } from "./fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, it, expect } from "vitest";
import type { DocStore } from "./types";

const roots: string[] = [];

describeDocStoreContract("fs", async (): Promise<DocStore> => {
  const root = await mkdtemp(join(tmpdir(), "covan-docstore-"));
  roots.push(root);
  return fsDocStore(root);
});

describe("fsDocStore path safety", () => {
  it("refuses a key that escapes the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "covan-docstore-"));
    roots.push(root);
    const store = fsDocStore(root);
    // Same ArrayBufferLike vs ArrayBuffer wrinkle documented in contract.ts's
    // `bytes()` helper: the cast is safe, TextEncoder never yields a
    // SharedArrayBuffer-backed view.
    const bytes = new TextEncoder().encode("nope").buffer as ArrayBuffer;

    await expect(store.put("../escaped.txt", bytes, { contentType: "text/plain" })).rejects.toThrow(
      /outside/i,
    );
  });
});

afterAll(async () => {
  await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
});
