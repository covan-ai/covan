import { describe, expect, it } from "vitest";
import { CfbError, openCfb } from "./cfb";
import { extractFromBytes, UnreadableFile } from "./index";
import { makeCfb } from "../../../test-support/make-cfb";
import { makeDoc } from "../../../test-support/make-office97";

const reader = (bytes: Uint8Array) => async (offset: number, length: number) =>
  bytes.subarray(offset, offset + length);

/** Byte-for-byte, without asking the matcher to diff megabytes element by element. */
const same = (a: Uint8Array | null, b: Uint8Array) =>
  a !== null && a.length === b.length && a.every((v, i) => v === b[i]);

const filled = (n: number, seed: number) =>
  Uint8Array.from({ length: n }, (_, i) => (i * 7 + seed) & 0xff);

describe("compound files", () => {
  it("reads a small stream from the mini stream and a large one from ordinary sectors", async () => {
    const small = filled(700, 1);
    const large = filled(9_000, 2);
    const file = makeCfb({ Small: small, Large: large, Empty: new Uint8Array(0) });

    const cfb = await openCfb(reader(file), file.length);

    expect(await cfb.stream("Small", 1e6)).toEqual(small);
    expect(await cfb.stream("large", 1e6)).toEqual(large);
    expect(await cfb.stream("Empty", 1e6)).toEqual(new Uint8Array(0));
    expect(await cfb.stream("Missing", 1e6)).toBeNull();
  });

  // An embedded Word document has a WordDocument stream of its own, and it
  // is not the text of the document it is embedded in.
  it("finds only the root's own streams, not those inside a storage", async () => {
    const file = makeCfb({ "ObjectPool/WordDocument": filled(100, 3), Data: filled(10, 4) });
    const cfb = await openCfb(reader(file), file.length);
    expect(cfb.has("WordDocument")).toBe(false);
    expect(cfb.has("Data")).toBe(true);
  });

  // Over 109 FAT sectors, the rest are listed in DIFAT sectors.
  it("follows the DIFAT past the header's 109 FAT sectors", async () => {
    const large = filled(7_500_000, 5);
    const file = makeCfb({ Large: large });
    expect(new DataView(file.buffer).getUint32(0x48, true)).toBeGreaterThan(0);

    const cfb = await openCfb(reader(file), file.length);

    expect(same(await cfb.stream("Large", 1e8), large)).toBe(true);
  });

  it("reads only the stream it is asked for", async () => {
    const file = makeCfb({ Pictures: filled(400_000, 6), Text: filled(5_000, 7) });
    let asked = 0;
    const counting = async (offset: number, length: number) => {
      asked += length;
      return file.subarray(offset, offset + length);
    };
    const cfb = await openCfb(counting, file.length);
    await cfb.stream("Text", 1e6);
    expect(asked).toBeLessThan(file.length / 10);
  });

  it("refuses a stream larger than the ceiling", async () => {
    const file = makeCfb({ Big: filled(10_000, 8) });
    const cfb = await openCfb(reader(file), file.length);
    await expect(cfb.stream("Big", 5_000)).rejects.toThrow(/larger than allowed/);
  });

  // A chain that loops would otherwise be read forever.
  it("stops at a sector chain that loops back on itself", async () => {
    const file = makeCfb({ Looped: filled(5_000, 9) }, { loop: "Looped" });
    const cfb = await openCfb(reader(file), file.length);
    await expect(cfb.stream("Looped", 1e6)).rejects.toThrow(/loops/);
  });

  it("stops at a directory whose chain loops", async () => {
    const file = makeCfb({ A: filled(10, 1) });
    const view = new DataView(file.buffer);
    const dir = view.getUint32(0x30, true);
    const fatAt = (view.getUint32(0x4c, true) + 1) * 512;
    view.setUint32(fatAt + dir * 4, dir, true);
    await expect(openCfb(reader(file), file.length)).rejects.toBeInstanceOf(CfbError);
  });

  it("refuses a file cut short", async () => {
    const file = makeCfb({ Large: filled(20_000, 2) });
    const cut = file.subarray(0, 8_000);
    const read = async () => (await openCfb(reader(cut), cut.length)).stream("Large", 1e6);
    await expect(read()).rejects.toBeInstanceOf(CfbError);
  });

  it("says a broken or truncated old Office file is not what its name claims", async () => {
    const doc = makeDoc([{ text: "Merhaba\r", compressed: true }]);
    for (const bytes of [
      doc.subarray(0, 600),
      doc.subarray(0, 3_000),
      new TextEncoder().encode("certainly not a Word file"),
      new Uint8Array(4096),
    ]) {
      await expect(extractFromBytes("letter.doc", bytes, 1e6)).rejects.toBeInstanceOf(
        UnreadableFile,
      );
    }
  });
});
