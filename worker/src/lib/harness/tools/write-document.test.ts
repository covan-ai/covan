import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeDb } from "../../../test-support/fake-db";
import type { ToolContext } from "../registry";
import { writeDocumentTool } from "./write-document";

const enqueueDocumentJob = vi.fn();
const affordable = vi.fn();
const spend = vi.fn();
const mayChangeThings = vi.fn();

vi.mock("../../docs/enqueue", () => ({
  enqueueDocumentJob: (...args: unknown[]) => enqueueDocumentJob(...args),
}));
vi.mock("../spend", () => ({
  affordable: (...args: unknown[]) => affordable(...args),
  spend: (...args: unknown[]) => spend(...args),
}));
vi.mock("../role", () => ({
  mayChangeThings: (...args: unknown[]) => mayChangeThings(...args),
}));

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  const fake = fakeDb({
    tables: {
      agents: { select: () => ({ data: { id: "agent-1", name: "Finance" }, error: null }) },
    },
  });
  return {
    db: fake.db,
    env: { DOCS_DIR: "/tmp/docs" },
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    sessionId: "sess-1",
    ...over,
  } as unknown as ToolContext;
}

const args = { title: "Q3 review", instruction: "Write up the quarter for the board." };

beforeEach(() => {
  vi.clearAllMocks();
  affordable.mockResolvedValue(null);
  mayChangeThings.mockResolvedValue(true);
  enqueueDocumentJob.mockResolvedValue({
    ok: true,
    job: { id: "job-1", title: "Q3 review" },
    embeddingTokens: 7,
  });
});

describe("write_document", () => {
  it("hands the request to the engine and tells the model not to write it itself", async () => {
    const result = await writeDocumentTool.run(args, ctx());

    expect(enqueueDocumentJob).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        agent: { id: "agent-1", name: "Finance" },
        userId: "user-1",
        sessionId: "sess-1",
        title: "Q3 review",
        instruction: "Write up the quarter for the board.",
        origin: "tool",
      }),
    );
    expect(result.kind).toBe("ok");
    expect(result.kind === "ok" && result.content).toContain("Do not write the document");
    expect(spend).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ kind: "embedding", tokens: 7 }),
    ]);
  });

  it("refuses a viewer before starting anything", async () => {
    mayChangeThings.mockResolvedValue(false);
    const result = await writeDocumentTool.run(args, ctx());
    expect(result.kind).toBe("error");
    expect(enqueueDocumentJob).not.toHaveBeenCalled();
  });

  it("refuses when the workspace has no credit left", async () => {
    affordable.mockResolvedValue({ kind: "error", message: "no credits" });
    const result = await writeDocumentTool.run(args, ctx());
    expect(result).toEqual({ kind: "error", message: "no credits" });
    expect(enqueueDocumentJob).not.toHaveBeenCalled();
  });

  it("needs a conversation to write from", async () => {
    const result = await writeDocumentTool.run(args, ctx({ sessionId: undefined }));
    expect(result.kind).toBe("error");
    expect(enqueueDocumentJob).not.toHaveBeenCalled();
  });

  it("needs both a title and an instruction", async () => {
    const result = await writeDocumentTool.run({ title: "Q3" }, ctx());
    expect(result.kind).toBe("error");
  });

  it("passes the engine's refusal on in words", async () => {
    enqueueDocumentJob.mockResolvedValue({ ok: false, status: 403, reason: "read only" });
    const result = await writeDocumentTool.run(args, ctx());
    expect(result).toEqual({
      kind: "error",
      message: "the document could not be started: read only",
    });
    expect(spend).not.toHaveBeenCalled();
  });

  it("is not offered where there is nowhere to file a document", () => {
    expect(writeDocumentTool.isConfigured({} as never)).toBe(false);
    expect(writeDocumentTool.isConfigured({ DOCS_DIR: "/tmp/docs" } as never)).toBe(true);
  });

  it("asks for a short brief, not the document, and to not start a listed one again", () => {
    const schema = writeDocumentTool.input as {
      properties: { instruction: { description: string; maxLength: number } };
    };
    expect(schema.properties.instruction.description).toContain("No more than 600 characters");
    expect(schema.properties.instruction.maxLength).toBe(2000);
    expect(writeDocumentTool.description).toContain("never put the content");
    expect(writeDocumentTool.description).toContain("do not call this again");
  });
});
