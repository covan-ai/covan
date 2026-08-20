import { describe, it, expect } from "vitest";
import { buildContextBlock } from "./rag";

describe("buildContextBlock", () => {
  it("returns empty string when no chunks", () => {
    expect(buildContextBlock([])).toBe("");
  });

  it("includes document names and content", () => {
    const out = buildContextBlock([
      { documentName: "handbook.md", content: "vacation policy is 20 days" },
    ]);
    expect(out).toContain("handbook.md");
    expect(out).toContain("vacation policy is 20 days");
  });

  it("stops adding chunks once the budget is exhausted", () => {
    const big = "x".repeat(5000);
    const out = buildContextBlock(
      [
        { documentName: "a", content: big },
        { documentName: "b", content: big },
      ],
      6000,
    );
    // second chunk's full content should not fully fit
    expect(out.length).toBeLessThanOrEqual(6000 + 500); // + framing overhead
    expect(out).toContain("a");
  });
});
