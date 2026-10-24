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
    return {
      passages: [...passages].reverse().slice(0, keep),
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
});
