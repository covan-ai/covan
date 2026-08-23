import { describe, it, expect } from "vitest";
import { startersFor, GENERAL_STARTERS } from "./chat-starters";

describe("startersFor", () => {
  it("falls back to the general prompts for an agent with no knowledge", () => {
    expect(startersFor([])).toEqual([...GENERAL_STARTERS]);
  });

  it("ignores a document that is still being indexed", () => {
    // Naming it would offer a question whose answer cannot cite it yet, which
    // is a worse first impression than not offering it at all.
    expect(startersFor([{ name: "handbook.md", indexed: false }])).toEqual([...GENERAL_STARTERS]);
  });

  it("names a real file once there is one to cite", () => {
    const starters = startersFor([{ name: "handbook.md", indexed: true }]);
    expect(starters[0]).toBe("What does handbook.md say?");
  });

  it("names the first indexed file, not the first file", () => {
    const starters = startersFor([
      { name: "still-uploading.pdf", indexed: false },
      { name: "handbook.md", indexed: true },
    ]);
    expect(starters[0]).toBe("What does handbook.md say?");
  });

  it("asks across the set when there is more than one document", () => {
    const starters = startersFor([
      { name: "handbook.md", indexed: true },
      { name: "contract.pdf", indexed: true },
    ]);
    expect(starters).toContain("What do these documents have in common?");
    expect(starters).not.toContain("Summarize what you know");
  });

  it("always offers exactly four", () => {
    // The empty state lays them out in a two-column grid; a fifth would leave
    // a widowed cell and a third would leave a hole.
    expect(startersFor([])).toHaveLength(4);
    expect(startersFor([{ name: "a.md", indexed: true }])).toHaveLength(4);
    expect(
      startersFor([
        { name: "a.md", indexed: true },
        { name: "b.md", indexed: true },
      ]),
    ).toHaveLength(4);
  });
});
