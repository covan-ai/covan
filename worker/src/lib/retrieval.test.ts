import { describe, expect, it, vi } from "vitest";
import { fakeDb } from "../test-support/fake-db";

// The embedding call fails, which retrieval treats as "nothing matched" and
// answers from stored document text instead — the path that hands the model a
// document's whole content, and the one this file is about.
vi.mock("./embeddings", () => ({
  embedTexts: async () => {
    throw new Error("no embedding model in this test");
  },
}));

import { retrieveForAgent } from "./retrieval";

/**
 * A document in Recently Deleted stops grounding answers.
 *
 * Through a person's own client the documents policy hides it. Slack and
 * routines retrieve with the service role, which no policy filters, and both
 * reads below — the names the model is told it can see, and the stored text it
 * is handed when no passage matched — returned trashed documents there: their
 * names in the manifest and their full text in the prompt.
 */
describe("retrieveForAgent", () => {
  it("asks for live documents only, in both reads", async () => {
    const fake = fakeDb({
      tables: {
        agent_bundles: { select: () => ({ data: [{ bundle_id: "b1" }], error: null }) },
        documents: {
          select: () => ({
            data: [{ id: "d1", name: "handbook.md", content: "Holidays: twenty-five days." }],
            error: null,
          }),
        },
        // The named document's own passages, read in order.
        document_chunks: { select: () => ({ data: [], error: null }) },
      },
    });

    await retrieveForAgent(
      fake.db as never,
      {} as never,
      "agent-1",
      "what does handbook.md say about holidays?",
      [{ role: "user", content: "what does handbook.md say about holidays?" }],
    );

    // The manifest, the newest twenty, and the one asked for by name.
    const reads = fake.callsTo("documents").filter((c) => c.op === "select");
    expect(reads.length).toBe(3);
    for (const read of reads) {
      expect(read.filters).toContainEqual({ column: "deleted_at", value: null, kind: "is" });
    }
  });
});
