import { describe, it, expect } from "vitest";
import { dropPayload, rangeSelect } from "./knowledge-selection";

const order = ["a", "b", "c", "d"];

describe("rangeSelect", () => {
  it("takes everything between the anchor and the row that was shift-clicked", () => {
    expect([...rangeSelect(order, "b", "d", new Set())]).toEqual(["b", "c", "d"]);
  });

  it("reads the range the same way when it is clicked upwards", () => {
    // Anchor below the target: the same three rows, still in list order.
    expect([...rangeSelect(order, "d", "b", new Set())]).toEqual(["b", "c", "d"]);
  });

  // The range is added to what was already ticked rather than replacing it,
  // which is how a set that is not contiguous gets collected.
  it("keeps what was already selected", () => {
    expect([...rangeSelect(order, "c", "d", new Set(["a"]))].sort()).toEqual(["a", "c", "d"]);
  });

  it("selects the one row when there is no anchor to reach back to", () => {
    expect([...rangeSelect(order, null, "c", new Set())]).toEqual(["c"]);
  });

  // The anchor was filtered away by a search, or deleted. Not a crash and not
  // the whole list: the row that was clicked.
  it("selects the one row when the anchor is no longer in the list", () => {
    expect([...rangeSelect(order, "zzz", "c", new Set())]).toEqual(["c"]);
  });
});

describe("dropPayload", () => {
  const documents = [
    { id: "a", bundleId: "one" },
    { id: "b", bundleId: "one" },
    { id: "c", bundleId: "one" },
  ];

  it("moves only the row that was dragged when it is not part of the selection", () => {
    const payload = dropPayload("c", "two", new Set(["a", "b"]), documents);
    expect(payload.map((d) => d.id)).toEqual(["c"]);
  });

  it("takes the whole selection when the dragged row is in it", () => {
    const payload = dropPayload("a", "two", new Set(["a", "b"]), documents);
    expect(payload.map((d) => d.id)).toEqual(["a", "b"]);
  });

  // Dropping a file on the folder it is already in is not a move, and in a
  // batch it would be counted as one.
  it("leaves out documents that are already in the target bundle", () => {
    const mixed = [
      { id: "a", bundleId: "one" },
      { id: "b", bundleId: "two" },
    ];
    const payload = dropPayload("a", "two", new Set(["a", "b"]), mixed);
    expect(payload.map((d) => d.id)).toEqual(["a"]);
  });

  it("is empty when the only thing dragged is already there", () => {
    expect(dropPayload("b", "two", new Set(), [{ id: "b", bundleId: "two" }])).toEqual([]);
  });
});
