import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../registry";

const retrieveForAgent = vi.fn();
vi.mock("../../retrieval", () => ({
  retrieveForAgent: (...a: unknown[]) => retrieveForAgent(...a),
}));

const record = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../../entitlements", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../entitlements")>()),
  entitlementsFor: () => ({ record: (...a: unknown[]) => record(...a) }),
}));

const { searchDocumentsTool } = await import("./search-documents");

const ctx = {
  db: {},
  env: {},
  workspaceId: "ws-1",
  agentId: "agent-1",
  userId: "user-1",
  sessionId: "session-1",
} as unknown as ToolContext;

describe("search_documents", () => {
  // The model decides to search, as often as it likes, and the route that
  // charged the turn never sees the query being embedded.
  it("charges the workspace for embedding the query", async () => {
    retrieveForAgent.mockResolvedValue({
      ragBlock: "Document: Handbook.md\nTwenty days.",
      sources: [{ id: "d1", name: "Handbook.md" }],
      embeddingTokens: 12,
    });

    await searchDocumentsTool.run({ query: "holidays" }, ctx);

    expect(record).toHaveBeenCalledTimes(1);
    const [workspaceId, spent] = record.mock.calls[0] as [string, Array<Record<string, unknown>>];
    expect(workspaceId).toBe("ws-1");
    expect(spent[0]).toMatchObject({ kind: "embedding", tokens: 12, purpose: "retrieval" });
  });

  it("charges for a search that found nothing, which was embedded all the same", async () => {
    record.mockClear();
    retrieveForAgent.mockResolvedValue({ ragBlock: "", sources: [], embeddingTokens: 9 });

    await searchDocumentsTool.run({ query: "nothing" }, ctx);

    expect(record).toHaveBeenCalledTimes(1);
  });

  // An answer grounded on a mid-turn search used to show no source chips: the
  // tool named the files to the model and nothing else heard about them.
  it("adds what it found to the reply's citations, once each", async () => {
    retrieveForAgent.mockResolvedValue({
      ragBlock: "Document: Pricing.md\nPro is $20.",
      sources: [
        { id: "d1", name: "Handbook.md" },
        { id: "d2", name: "Pricing.md" },
      ],
      embeddingTokens: 4,
    });
    const foundSources = [{ id: "d1", name: "Handbook.md" }];

    await searchDocumentsTool.run({ query: "pro price" }, { ...ctx, foundSources });

    expect(foundSources).toEqual([
      { id: "d1", name: "Handbook.md" },
      { id: "d2", name: "Pricing.md" },
    ]);
    // The question goes through as the question, not as history.
    expect(retrieveForAgent.mock.calls.at(-1)?.slice(3)).toEqual(["pro price", []]);
  });
});
