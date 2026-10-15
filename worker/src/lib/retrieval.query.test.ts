import { describe, expect, it, vi } from "vitest";
import { fakeDb } from "../test-support/fake-db";

const embedded: string[][] = [];
vi.mock("./embeddings", () => ({
  embedTexts: async (_env: unknown, texts: string[]) => {
    embedded.push(texts);
    return { vectors: texts.map(() => [0.1, 0.2]), tokens: 3 };
  },
}));

import { retrieveForAgent } from "./retrieval";

/**
 * What gets embedded when there is no conversation behind the question.
 *
 * The agent's `search_documents` tool and a routine's retrieval both call with
 * no history. The query used to be built from history alone, so both embedded
 * "" and sent no terms: the search the model chose to run never read the
 * words it chose to search for.
 */
describe("retrieveForAgent with no history", () => {
  it("searches with the question itself", async () => {
    embedded.length = 0;
    let rpcArgs: Record<string, unknown> | null = null;
    const fake = fakeDb({
      tables: {
        agent_bundles: { select: () => ({ data: [{ bundle_id: "b1" }], error: null }) },
        documents: { select: () => ({ data: [{ name: "pricing.md" }], error: null }) },
      },
      rpc: {
        match_chunks: (args) => {
          rpcArgs = args;
          return {
            data: [{ document_id: "d1", document_name: "pricing.md", content: "Pro is $20 a seat." }],
            error: null,
          };
        },
      },
    });

    const result = await retrieveForAgent(
      fake.db as never,
      { RAG_LEXICAL: "on" } as never,
      "agent-1",
      "enterprise seat pricing",
      [],
    );

    expect(embedded).toEqual([["enterprise seat pricing"]]);
    expect(rpcArgs).not.toBeNull();
    expect((rpcArgs as unknown as { p_query_terms: string[] }).p_query_terms.length).toBeGreaterThan(0);
    expect(result.sources).toEqual([{ id: "d1", name: "pricing.md" }]);
  });
});
