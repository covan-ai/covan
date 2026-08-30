import { describe, it, expect } from "vitest";
import { buildContextBlock, ragMinSimilarity, DEFAULT_RAG_MIN_SIMILARITY } from "./rag";

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

describe("the similarity floor", () => {
  it("is 0.25 unless the operator says otherwise", () => {
    expect(ragMinSimilarity({})).toBe(DEFAULT_RAG_MIN_SIMILARITY);
    expect(ragMinSimilarity({ RAG_MIN_SIMILARITY: "" })).toBe(DEFAULT_RAG_MIN_SIMILARITY);
  });

  it("is whatever they set it to", () => {
    expect(ragMinSimilarity({ RAG_MIN_SIMILARITY: "0.4" })).toBe(0.4);
    expect(ragMinSimilarity({ RAG_MIN_SIMILARITY: " 0.15 " })).toBe(0.15);
  });

  it("takes 0, which means no floor at all", () => {
    // The behaviour before migration 0005 added the argument, and a legitimate
    // thing to want while tuning a new model — so it must not be read as unset.
    expect(ragMinSimilarity({ RAG_MIN_SIMILARITY: "0" })).toBe(0);
  });

  it.each(["nope", "-0.1", "1.5", "25%"])("refuses %s", (value) => {
    // 25 is the shape of the mistake worth catching: someone reading 0.25 as a
    // percentage sets 25, and every chunk falls below a floor no chunk can
    // reach. Retrieval then returns nothing, forever, without erroring once.
    expect(() => ragMinSimilarity({ RAG_MIN_SIMILARITY: value })).toThrow(/RAG_MIN_SIMILARITY/);
  });
});
