import { describe, expect, it } from "vitest";
import { chunked, readAllPages } from "./batch";

describe("chunked", () => {
  it("cuts a list into hundreds, the last one short", () => {
    const sizes = chunked(Array.from({ length: 250 }, (_, i) => i)).map((c) => c.length);
    expect(sizes).toEqual([100, 100, 50]);
  });

  it("gives nothing for nothing", () => {
    expect(chunked([])).toEqual([]);
  });
});

describe("readAllPages", () => {
  it("asks again until a page comes back short", async () => {
    const all = Array.from({ length: 2500 }, (_, i) => i);
    const asked: Array<[number, number]> = [];
    const rows = await readAllPages(async (from, to) => {
      asked.push([from, to]);
      return { data: all.slice(from, to + 1), error: null };
    });
    expect(rows).toHaveLength(2500);
    expect(asked).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("says it could not tell, rather than answering none", async () => {
    expect(await readAllPages(async () => ({ data: null, error: { message: "x" } }))).toBeNull();
  });
});
