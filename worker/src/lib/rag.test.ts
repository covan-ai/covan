import { describe, it, expect } from "vitest";
import {
  buildContextBlock,
  ragMinSimilarity,
  retrievalQuery,
  DEFAULT_RAG_MIN_SIMILARITY,
} from "./rag";

describe("buildContextBlock", () => {
  it("returns empty string when no chunks", () => {
    expect(buildContextBlock([])).toEqual({ text: "", used: [] });
  });

  it("includes document names and content", () => {
    const out = buildContextBlock([
      { documentName: "handbook.md", content: "vacation policy is 20 days" },
    ]);
    expect(out.text).toContain("handbook.md");
    expect(out.text).toContain("vacation policy is 20 days");
  });

  it("stops adding chunks once the budget is exhausted", () => {
    const big = "x".repeat(5000);
    const out = buildContextBlock(
      [
        { documentName: "a", content: big },
        { documentName: "b", content: big },
      ],
      5400,
    );
    expect(out.text).toContain("Document: a");
    expect(out.text).not.toContain("Document: b");
  });

  it("keeps the whole block inside the budget it was given", () => {
    // Framing used to be free: the header, the "Document: name" lines and the
    // separators were all added on top of the budget, so a block asked for
    // 4000 chars came back at 4300 and the cost of a turn was consistently
    // under-counted.
    const big = "x".repeat(5000);
    const out = buildContextBlock(
      [
        { documentName: "a", content: big },
        { documentName: "b", content: big },
      ],
      6000,
    );
    expect(out.text.length).toBeLessThanOrEqual(6000);
  });

  it("reports only the chunks it actually admitted", () => {
    // The whole reason `used` exists. Sources on a reply are drawn from this
    // list, and a document whose passage was dropped for space grounded
    // nothing — citing it puts a chip under an answer that never saw it.
    const big = "x".repeat(5000);
    const out = buildContextBlock(
      [
        { documentId: "d1", documentName: "a", content: big },
        { documentId: "d2", documentName: "b", content: big },
        { documentId: "d3", documentName: "c", content: big },
      ],
      5400,
    );
    expect(out.used.map((u) => u.documentId)).toEqual(["d1"]);
  });

  it("admits a short document whole rather than dropping it for a long one's leftovers", () => {
    const out = buildContextBlock(
      [
        { documentName: "short", content: "20 days" },
        { documentName: "long", content: "x".repeat(5000) },
      ],
      1200,
    );
    expect(out.text).toContain("20 days");
    expect(out.used.map((u) => u.documentName)).toEqual(["short", "long"]);
  });

  it("refuses to admit a fragment too small to answer anything", () => {
    // Sending forty characters of a document costs its framing, cannot answer
    // the question, and still claims the citation.
    const out = buildContextBlock(
      [
        { documentName: "a", content: "x".repeat(900) },
        { documentName: "b", content: "y".repeat(900) },
      ],
      1000,
    );
    expect(out.used.map((u) => u.documentName)).toEqual(["a"]);
  });

  it("marks a passage that was cut, so the model knows it did not end there", () => {
    const out = buildContextBlock([{ documentName: "a", content: "x".repeat(5000) }], 1000);
    expect(out.text).toContain("[truncated]");
  });

  it("skips a chunk with no content instead of citing an empty document", () => {
    const out = buildContextBlock([
      { documentId: "d1", documentName: "empty.md", content: "   " },
      { documentId: "d2", documentName: "real.md", content: "the answer" },
    ]);
    expect(out.used.map((u) => u.documentId)).toEqual(["d2"]);
    expect(out.text).not.toContain("empty.md");
  });

  it("returns nothing when the budget cannot even hold the header", () => {
    const out = buildContextBlock([{ documentName: "a", content: "hello" }], 10);
    expect(out).toEqual({ text: "", used: [] });
  });
});

describe("retrievalQuery", () => {
  it("embeds a self-contained question on its own", () => {
    const question = "What is the vacation policy for new joiners in the Istanbul office?";
    expect(retrievalQuery([{ role: "user", content: question }])).toBe(question);
  });

  it("carries the previous question into a follow-up that has no subject", () => {
    // "peki ikinci maddesi?" embeds near nothing on its own, so retrieval
    // returned nothing and the agent lost a document it had been reading
    // correctly one turn earlier.
    const out = retrievalQuery([
      { role: "user", content: "Summarize the vacation policy in handbook.md" },
      { role: "assistant", content: "It gives 20 days, accrued monthly, plus public holidays." },
      { role: "user", content: "peki ikinci maddesi?" },
    ]);
    expect(out).toContain("handbook.md");
    expect(out).toContain("peki ikinci maddesi?");
  });

  it("reaches past the assistant for the antecedent, not into it", () => {
    // The assistant's reply is long and full of its own vocabulary; letting it
    // into the vector would drown the question rather than complete it.
    const out = retrievalQuery([
      { role: "user", content: "What does the onboarding checklist cover?" },
      { role: "assistant", content: "Laptops, badges, payroll forms and the buddy programme." },
      { role: "user", content: "and the third one?" },
    ]);
    expect(out).toContain("onboarding checklist");
    expect(out).not.toContain("buddy programme");
  });

  it("leaves a short first question alone when there is nothing before it", () => {
    expect(retrievalQuery([{ role: "user", content: "hi" }])).toBe("hi");
  });

  it("caps what it hands the embedding model", () => {
    // A pasted contract is longer than text-embedding-3-small's own context
    // window: the call 400s, chat.ts logs "retrieval failed", and the answer
    // comes back ungrounded with nothing on screen to explain why.
    const out = retrievalQuery([{ role: "user", content: "x".repeat(50_000) }]);
    expect(out.length).toBeLessThanOrEqual(4000);
  });

  it("returns nothing for no turns at all", () => {
    expect(retrievalQuery([])).toBe("");
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
