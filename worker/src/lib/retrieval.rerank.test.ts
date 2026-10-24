import { describe, expect, it, vi } from "vitest";
import { fakeDb } from "../test-support/fake-db";

vi.mock("./embeddings", () => ({
  embedTexts: async (_env: unknown, texts: string[]) => ({
    vectors: texts.map(() => [0.1, 0.2]),
    tokens: 3,
  }),
}));

const rerankCalls: Array<{ model: string; query: string; count: number; keep: number }> = [];
vi.mock("./rerank", () => ({
  RERANK_CANDIDATES: 30,
  rerankPassages: async (
    _env: unknown,
    model: string,
    query: string,
    passages: { content: string }[],
    keep: number,
  ) => {
    rerankCalls.push({ model, query, count: passages.length, keep });
    // Scores the last passage 3 and the rest 1, and puts it first.
    const reordered = [...passages].reverse().slice(0, keep);
    return {
      passages: reordered.map((p, i) => ({ ...p, rerankScore: i === 0 ? 3 : 1 })),
      spend: { kind: "completion", model, promptTokens: 50, completionTokens: 5 },
      reranked: true,
    };
  },
}));

import { retrieveForAgent } from "./retrieval";

/**
 * With `RAG_RERANK_MODEL` set, the search hands over thirty candidates and the
 * reranker's order is what retrieval returns; unset, nothing changes.
 */
describe("retrieveForAgent with a reranker", () => {
  function setup() {
    let matchCount: unknown = null;
    const rows = ["first", "second", "third"].map((content, i) => ({
      document_id: `d${i}`,
      document_name: "a.md",
      content,
      similarity: 0.5,
    }));
    const fake = fakeDb({
      tables: {
        agent_bundles: { select: () => ({ data: [{ bundle_id: "b1" }], error: null }) },
        documents: { select: () => ({ data: [{ name: "a.md" }], error: null }) },
      },
      rpc: {
        match_chunks: (args) => {
          matchCount = args.p_match_count;
          return { data: rows, error: null };
        },
      },
    });
    return { fake, matchCount: () => matchCount };
  }

  it("asks the search for thirty candidates and returns the reranker's order", async () => {
    rerankCalls.length = 0;
    const { fake, matchCount } = setup();
    const r = await retrieveForAgent(
      fake.db as never,
      { RAG_RERANK_MODEL: "gpt-5-nano" } as never,
      "agent-1",
      "fesih süresi",
      [],
    );
    expect(matchCount()).toBe(30);
    expect(rerankCalls).toEqual([
      { model: "gpt-5-nano", query: "fesih süresi", count: 3, keep: 10 },
    ]);
    expect(r.passages.map((p) => p.content)).toEqual(["third", "second", "first"]);
    expect(r.rerankSpend).toMatchObject({ kind: "completion", model: "gpt-5-nano" });
  });

  it("leaves the search alone when no reranker is configured", async () => {
    rerankCalls.length = 0;
    const { fake, matchCount } = setup();
    const r = await retrieveForAgent(fake.db as never, {} as never, "agent-1", "q", []);
    expect(matchCount()).toBe(10);
    expect(rerankCalls).toHaveLength(0);
    expect(r.passages.map((p) => p.content)).toEqual(["first", "second", "third"]);
    expect(r.rerankSpend).toBeNull();
  });

  it("cites what the reranker said answers the question, not what sat closest", async () => {
    // "third" is the weakest by similarity and the one the reranker scores 3;
    // the other two are only on the topic. Without the reranker's say, the
    // chips would name the two that do not answer.
    const fake = fakeDb({
      tables: {
        agent_bundles: { select: () => ({ data: [{ bundle_id: "b1" }], error: null }) },
        documents: {
          select: () => ({ data: [{ name: "en.md" }, { name: "tr.md" }], error: null }),
        },
      },
      rpc: {
        match_chunks: () => ({
          data: [
            { document_id: "tr1", document_name: "tr.md", content: "first", similarity: 0.62 },
            { document_id: "tr2", document_name: "tr.md", content: "second", similarity: 0.6 },
            { document_id: "en", document_name: "en.md", content: "third", similarity: 0.3 },
          ],
          error: null,
        }),
      },
    });
    const r = await retrieveForAgent(
      fake.db as never,
      { RAG_RERANK_MODEL: "gpt-4.1-mini" } as never,
      "agent-1",
      "q",
      [],
    );
    expect(r.sources).toEqual([{ id: "en", name: "en.md" }]);
  });
});
