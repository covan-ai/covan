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
            data: [
              {
                document_id: "d1",
                document_name: "pricing.md",
                content: "Pro is $20 a seat.",
                similarity: 0.6,
              },
            ],
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
    expect(
      (rpcArgs as unknown as { p_query_terms: string[] }).p_query_terms.length,
    ).toBeGreaterThan(0);
    expect(result.sources).toEqual([{ id: "d1", name: "pricing.md" }]);
  });
});

/**
 * What the model reads and what the answer is shown as coming from. Both
 * passages below are put in front of the model; only the one that clearly
 * bears on the question is a source chip.
 */
describe("retrieveForAgent's sources", () => {
  it("reads a weak or keyword-only passage but does not cite it", async () => {
    const fake = fakeDb({
      tables: {
        agent_bundles: { select: () => ({ data: [{ bundle_id: "b1" }], error: null }) },
        documents: {
          select: () => ({
            data: [{ name: "remote-policy.pdf" }, { name: "Fjord - Wikipedia.html" }],
            error: null,
          }),
        },
      },
      rpc: {
        match_chunks: () => ({
          data: [
            {
              document_id: "d1",
              document_name: "remote-policy.pdf",
              content: "Remote work is allowed three days a week. ".repeat(6),
              similarity: 0.61,
            },
            {
              document_id: "d2",
              document_name: "Fjord - Wikipedia.html",
              content: "A fjord is a long, narrow inlet. Work on the survey began in 1890. ".repeat(
                4,
              ),
              similarity: null,
            },
          ],
          error: null,
        }),
      },
    });

    const result = await retrieveForAgent(
      fake.db as never,
      {} as never,
      "agent-1",
      "Summarize the remote work policy",
      [],
    );

    expect(result.ragBlock).toContain("Fjord - Wikipedia.html");
    expect(result.sources).toEqual([{ id: "d1", name: "remote-policy.pdf" }]);
  });
});

/**
 * Whose knowledge a service-role read may stand on (0106).
 *
 * Slack and routines read with the service role, which no policy narrows, so
 * the scope is the only thing keeping somebody's private bundle out of a reply
 * everybody can read — the file names in the manifest as much as the passages.
 */
describe("retrieveForAgent with a knowledge scope", () => {
  function world() {
    let rpcArgs: Record<string, unknown> | null = null;
    const fake = fakeDb({
      tables: {
        agent_bundles: {
          select: () => ({
            data: [{ bundle_id: "shared" }, { bundle_id: "mine" }, { bundle_id: "theirs" }],
            error: null,
          }),
        },
        knowledge_bundles: {
          select: () => ({
            data: [
              { id: "shared", scope: "workspace", created_by: "u-other" },
              { id: "mine", scope: "owner", created_by: "u-me" },
              { id: "theirs", scope: "owner", created_by: "u-other" },
            ],
            error: null,
          }),
        },
        documents: { select: () => ({ data: [{ name: "a.md" }], error: null }) },
      },
      rpc: {
        match_chunks: (args) => {
          rpcArgs = args;
          return { data: [], error: null };
        },
      },
    });
    const docBundles = () =>
      fake
        .callsTo("documents")
        .flatMap((c) => c.filters.filter((f) => f.kind === "in").map((f) => f.value));
    return { fake, docBundles, rpc: () => rpcArgs };
  }

  it("reads shared bundles and the viewer's own, for a private routine", async () => {
    const { fake, docBundles, rpc } = world();
    await retrieveForAgent(fake.db as never, {} as never, "agent-1", "pay", [], { viewer: "u-me" });
    expect(docBundles()[0]).toEqual(["shared", "mine"]);
    expect(rpc()).toMatchObject({ p_viewer: "u-me" });
  });

  it("reads shared bundles only, for a reply other people read", async () => {
    const { fake, docBundles, rpc } = world();
    await retrieveForAgent(fake.db as never, {} as never, "agent-1", "pay", [], {
      sharedOnly: true,
    });
    expect(docBundles()[0]).toEqual(["shared"]);
    expect(rpc()).toMatchObject({ p_shared_only: true });
  });

  it("asks nothing extra through a person's own client", async () => {
    const { fake, rpc } = world();
    await retrieveForAgent(fake.db as never, {} as never, "agent-1", "pay", []);
    expect(fake.callsTo("knowledge_bundles")).toEqual([]);
    expect(rpc()).not.toHaveProperty("p_viewer");
    expect(rpc()).not.toHaveProperty("p_shared_only");
  });
});

/**
 * "Summarise handbook.md" with nothing matched used to ground on the first
 * 8,000 characters of the excerpt, cut to the 4,000-character block.
 */
describe("retrieveForAgent asked about one document by name", () => {
  it("reads that document in order, past the excerpt, under a larger budget", async () => {
    const passage = (i: number) => `Section ${i}. ` + "Leave rules apply. ".repeat(40);
    const fake = fakeDb({
      tables: {
        agent_bundles: { select: () => ({ data: [{ bundle_id: "b1" }], error: null }) },
        documents: {
          select: (ctx) =>
            ctx.columns === "name"
              ? { data: [{ name: "handbook.md" }], error: null }
              : {
                  data: [{ id: "d1", name: "handbook.md", content: "Short excerpt." }],
                  error: null,
                },
        },
        document_chunks: {
          select: () => ({
            data: Array.from({ length: 12 }, (_, i) => ({
              content: passage(i),
              chunk_index: i,
              generation: 1,
            })),
            error: null,
          }),
        },
      },
      rpc: { match_chunks: () => ({ data: [], error: null }) },
    });

    const result = await retrieveForAgent(
      fake.db as never,
      { RAG_LEXICAL: "on" } as never,
      "agent-1",
      "summarise handbook.md for me",
      [],
    );

    expect(result.ragBlock).toContain("Section 0.");
    expect(result.ragBlock).toContain("Section 9.");
    expect(result.ragBlock.length).toBeGreaterThan(8_000);
    expect(result.grounding).toBe("documents");
  });
});

/**
 * With a passage index bound (0116) the nearest passages come from it, and
 * Postgres is handed their ids to read under its own policies.
 */
describe("retrieveForAgent with a passage index", () => {
  const passage = {
    document_id: "d1",
    document_name: "pricing.md",
    content: "Pro is $20 a seat.",
    similarity: 0.7,
  };

  function withRanked(onRanked: (args: Record<string, unknown>) => void) {
    return fakeDb({
      tables: {
        agent_bundles: { select: () => ({ data: [{ bundle_id: "b1" }], error: null }) },
        documents: { select: () => ({ data: [{ name: "pricing.md" }], error: null }) },
      },
      rpc: {
        match_chunks: () => {
          throw new Error("the column is not the index here");
        },
        match_passages_ranked: (args) => {
          onRanked(args);
          return { data: [passage], error: null };
        },
      },
    });
  }

  it("asks the index among the readable bundles, then Postgres for those ids", async () => {
    let ranked: Record<string, unknown> | null = null;
    const fake = withRanked((args) => (ranked = args));
    const query = vi.fn().mockResolvedValue({
      matches: [
        { id: "c2", score: 0.8 },
        { id: "c1", score: 0.6 },
      ],
    });

    const result = await retrieveForAgent(
      fake.db as never,
      { PASSAGES: { query } } as never,
      "agent-1",
      "seat pricing",
      [],
    );

    expect(query.mock.calls[0][1]).toMatchObject({ filter: { bundle_id: "b1" } });
    expect(ranked).toMatchObject({
      p_agent_id: "agent-1",
      p_vector_ids: ["c2", "c1"],
      p_vector_similarities: [0.8, 0.6],
    });
    expect(ranked).not.toHaveProperty("p_query_embedding");
    expect(result.sources).toEqual([{ id: "d1", name: "pricing.md" }]);
  });

  it("searches by words alone when the index cannot be reached", async () => {
    let ranked: Record<string, unknown> | null = null;
    const fake = withRanked((args) => (ranked = args));
    const query = vi.fn().mockRejectedValue(new Error("index down"));

    await retrieveForAgent(
      fake.db as never,
      { PASSAGES: { query } } as never,
      "agent-1",
      "seat pricing",
      [],
    );

    expect(ranked).toMatchObject({ p_vector_ids: [], p_vector_similarities: [] });
  });
});
