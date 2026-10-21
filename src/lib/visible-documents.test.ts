import { describe, it, expect } from "vitest";
import { hiddenByPrivacy, visibleDocuments } from "./visible-documents";

const bundles = [
  { id: "team", shared: true },
  { id: "mine", shared: false },
  { id: "old" }, // an older response: undefined means shared
];
const docs = [
  { id: "d1", name: "handbook.md", bundleId: "team" },
  { id: "d2", name: "notes.md", bundleId: "mine" },
  { id: "d3", name: "legacy.pdf", bundleId: "old" },
  { id: "d4", name: "loose.txt" },
  { id: "d5", name: "elsewhere.txt", bundleId: "unknown" },
];

describe("visibleDocuments", () => {
  it("keeps everything in a private conversation", () => {
    expect(visibleDocuments(docs, bundles, false)).toHaveLength(5);
  });

  it("leaves a private folder's documents out of a shared conversation", () => {
    // What the server's sharedOnly scope does, so the count under the
    // composer is the count the answer was actually drawn from.
    expect(visibleDocuments(docs, bundles, true).map((d) => d.id)).toEqual([
      "d1",
      "d3",
      "d4",
      "d5",
    ]);
  });

  it("reads an undefined shared flag, a missing bundle and an unknown one as shared", () => {
    const kept = visibleDocuments(docs, bundles, true).map((d) => d.id);
    expect(kept).toContain("d3");
    expect(kept).toContain("d4");
    expect(kept).toContain("d5");
  });
});

describe("hiddenByPrivacy", () => {
  it("counts what a shared conversation cannot read, and nothing in a private one", () => {
    expect(hiddenByPrivacy(docs, bundles, true)).toBe(1);
    expect(hiddenByPrivacy(docs, bundles, false)).toBe(0);
  });
});
