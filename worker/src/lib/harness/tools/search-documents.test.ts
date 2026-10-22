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

const listConnections = vi.fn();
vi.mock("../connections", () => ({
  listConnections: (...a: unknown[]) => listConnections(...a),
  connectionsOffFor: async () => new Set<string>(),
}));

const { searchDocumentsTool, NO_PASSAGE_MATCHED } = await import("./search-documents");

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
    expect(retrieveForAgent.mock.calls.at(-1)?.slice(3)).toEqual(["pro price", [], {}]);
  });

  // A search in a shared conversation reads what the conversation's own
  // retrieval reads: shared knowledge only (0106).
  it("searches only the knowledge the conversation may stand on", async () => {
    retrieveForAgent.mockResolvedValue({ ragBlock: "", sources: [], embeddingTokens: 1 });

    await searchDocumentsTool.run(
      { query: "salary" },
      { ...ctx, knowledgeScope: { sharedOnly: true } },
    );

    expect(retrieveForAgent.mock.calls.at(-1)?.[5]).toEqual({ sharedOnly: true });
  });

  // A person who connected Notion and asked about their Notion page was told,
  // twice, that the documents did not cover it — and never sent to Notion.
  it("names the connected apps when a search finds nothing", async () => {
    retrieveForAgent.mockResolvedValue({ ragBlock: "", sources: [], embeddingTokens: 1 });
    listConnections.mockResolvedValue([
      { label: "Notion", transport: "composio" },
      { label: "Warehouse", transport: "sql" },
    ]);

    const result = await searchDocumentsTool.run({ query: "who am I" }, ctx);

    expect(result.kind).toBe("ok");
    const content = (result as { content: string }).content;
    expect(content).toContain("Connected here: Notion.");
    expect(content).toContain("find_tool");
    expect(content).not.toContain("Warehouse");
  });

  it("says only that nothing matched when there are no connected apps", async () => {
    retrieveForAgent.mockResolvedValue({ ragBlock: "", sources: [], embeddingTokens: 1 });
    listConnections.mockResolvedValue([]);

    const result = await searchDocumentsTool.run({ query: "who am I" }, ctx);

    expect(result).toEqual({ kind: "ok", content: NO_PASSAGE_MATCHED });
  });

  it("still answers when the connections cannot be read", async () => {
    retrieveForAgent.mockResolvedValue({ ragBlock: "", sources: [], embeddingTokens: 1 });
    listConnections.mockRejectedValue(new Error("down"));

    const result = await searchDocumentsTool.run({ query: "who am I" }, ctx);

    expect(result).toEqual({ kind: "ok", content: NO_PASSAGE_MATCHED });
  });

  it("does not read the connections when the search found something", async () => {
    listConnections.mockClear();
    retrieveForAgent.mockResolvedValue({
      ragBlock: "Document: Handbook.md\nTwenty days.",
      sources: [{ id: "d1", name: "Handbook.md" }],
      embeddingTokens: 2,
    });

    await searchDocumentsTool.run({ query: "holidays" }, ctx);

    expect(listConnections).not.toHaveBeenCalled();
  });
});
