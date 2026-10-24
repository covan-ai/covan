import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../registry";
import { editDocumentTool, listDocumentsTool, readDocumentTool } from "./documents";

const findAgentDocument = vi.fn();
const listAgentDocuments = vi.fn();
const readDocumentText = vi.fn();
const saveDocumentText = vi.fn();
const affordable = vi.fn();
const mayChangeThings = vi.fn();

vi.mock("../../docs/edit", async (original) => {
  const real = await original<typeof import("../../docs/edit")>();
  return {
    ...real,
    findAgentDocument: (...a: unknown[]) => findAgentDocument(...a),
    listAgentDocuments: (...a: unknown[]) => listAgentDocuments(...a),
    readDocumentText: (...a: unknown[]) => readDocumentText(...a),
    saveDocumentText: (...a: unknown[]) => saveDocumentText(...a),
  };
});
vi.mock("../spend", () => ({ affordable: (...a: unknown[]) => affordable(...a) }));
vi.mock("../role", () => ({ mayChangeThings: (...a: unknown[]) => mayChangeThings(...a) }));

const DOC = {
  id: "doc-1",
  name: "Plan.md",
  bundle_id: "b-1",
  bundle_name: "Reports",
  workspace_id: "ws-1",
  r2_key: "b-1/k-Plan.md",
  content: "",
  size: 2048,
  connection_id: null,
  index_status: "ready",
  index_lease_until: null,
  created_at: null,
};

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    db: {},
    env: { DOCS_DIR: "/tmp/docs" },
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    sessionId: "sess-1",
    ...over,
  } as unknown as ToolContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  affordable.mockResolvedValue(null);
  mayChangeThings.mockResolvedValue(true);
  findAgentDocument.mockResolvedValue({ kind: "found", doc: DOC });
});

describe("list_documents", () => {
  it("lists ids, where each lives and whether it can be edited in place", async () => {
    listAgentDocuments.mockResolvedValue([DOC, { ...DOC, id: "doc-2", name: "Deck.pdf" }]);
    const result = await listDocumentsTool.run({}, ctx());
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.content).toContain("Plan.md (id: doc-1, in Reports, 2 KB, editable)");
    expect(result.content).toContain("Deck.pdf (id: doc-2, in Reports, 2 KB, read-only original");
  });

  it("says so when nothing matches", async () => {
    listAgentDocuments.mockResolvedValue([]);
    const result = await listDocumentsTool.run({ name: "budget" }, ctx());
    expect(result).toEqual({
      kind: "ok",
      content: 'No document in your knowledge has a name containing "budget".',
    });
  });
});

describe("read_document", () => {
  it("returns the whole text of a short document", async () => {
    readDocumentText.mockResolvedValue({ kind: "ok", text: "Hello", truncated: false });
    const result = await readDocumentTool.run({ document: "doc-1" }, ctx());
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.content).toContain(
        'Document "Plan.md" (id: doc-1, in Reports), the whole text',
      );
      expect(result.content).toContain("Hello");
    }
  });

  it("pages a long one and says where to read on", async () => {
    readDocumentText.mockResolvedValue({ kind: "ok", text: "x".repeat(40_000), truncated: true });
    const result = await readDocumentTool.run({ document: "doc-1", offset: 10_000 }, ctx());
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.content).toContain("characters 10000–40000, continues");
      expect(result.content).toContain("offset 40000");
    }
    expect(readDocumentText).toHaveBeenCalledWith(expect.anything(), DOC, 40_000);
  });

  it("passes a lookup failure back as an error", async () => {
    findAgentDocument.mockResolvedValue({ kind: "none", message: "no document named like x" });
    expect(await readDocumentTool.run({ document: "x" }, ctx())).toEqual({
      kind: "error",
      message: "no document named like x",
    });
  });

  it("is not offered where there is no document store", () => {
    expect(readDocumentTool.isConfigured({} as never)).toBe(false);
    expect(editDocumentTool.isConfigured({} as never)).toBe(false);
    expect(listDocumentsTool.isConfigured({} as never)).toBe(true);
  });
});

describe("edit_document", () => {
  it("applies exact edits to the stored text and saves the result", async () => {
    readDocumentText.mockResolvedValue({ kind: "ok", text: "Launch Monday", truncated: false });
    saveDocumentText.mockResolvedValue({ kind: "replaced", documentId: "doc-1", name: "Plan.md" });
    const result = await editDocumentTool.run(
      { document: "doc-1", edits: [{ find: "Monday", replace: "Friday" }] },
      ctx(),
    );
    expect(saveDocumentText).toHaveBeenCalledWith(expect.anything(), DOC, "Launch Friday");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.content).toContain("changed in 1 place");
  });

  it("rewrites whole when given content, without reading first", async () => {
    saveDocumentText.mockResolvedValue({ kind: "replaced", documentId: "doc-1", name: "Plan.md" });
    const result = await editDocumentTool.run({ document: "doc-1", content: "# New" }, ctx());
    expect(readDocumentText).not.toHaveBeenCalled();
    expect(saveDocumentText).toHaveBeenCalledWith(expect.anything(), DOC, "# New");
    if (result.kind === "ok") expect(result.content).toContain("rewritten");
  });

  it("tells the model where the copy went when the original cannot change", async () => {
    readDocumentText.mockResolvedValue({ kind: "ok", text: "a", truncated: false });
    saveDocumentText.mockResolvedValue({
      kind: "copied",
      documentId: "copy-1",
      name: "Plan (edited).md",
    });
    const result = await editDocumentTool.run(
      { document: "doc-1", edits: [{ find: "a", replace: "b" }] },
      ctx(),
    );
    if (result.kind === "ok") {
      expect(result.content).toContain('"Plan (edited).md" (id: copy-1)');
      expect(result.content).toContain("The original is unchanged");
    } else throw new Error("expected ok");
  });

  it("changes nothing when an edit does not match", async () => {
    readDocumentText.mockResolvedValue({ kind: "ok", text: "Launch Monday", truncated: false });
    const result = await editDocumentTool.run(
      { document: "doc-1", edits: [{ find: "Tuesday", replace: "Friday" }] },
      ctx(),
    );
    expect(result.kind).toBe("error");
    expect(saveDocumentText).not.toHaveBeenCalled();
  });

  it("refuses a viewer before touching anything", async () => {
    mayChangeThings.mockResolvedValue(false);
    const result = await editDocumentTool.run({ document: "doc-1", content: "x" }, ctx());
    expect(result.kind).toBe("error");
    if (result.kind === "error") expect(result.message).toMatch(/viewer/);
    expect(findAgentDocument).not.toHaveBeenCalled();
  });

  it("refuses when the workspace is out of credits", async () => {
    affordable.mockResolvedValue({ kind: "error", message: "out of credits" });
    expect(await editDocumentTool.run({ document: "doc-1", content: "x" }, ctx())).toEqual({
      kind: "error",
      message: "out of credits",
    });
  });

  it("refuses a document too long to have been read whole", async () => {
    readDocumentText.mockResolvedValue({ kind: "ok", text: "x", truncated: true });
    const result = await editDocumentTool.run(
      { document: "doc-1", edits: [{ find: "x", replace: "y" }] },
      ctx(),
    );
    expect(result.kind).toBe("error");
    expect(saveDocumentText).not.toHaveBeenCalled();
  });

  it("wants edits or content, and not both", async () => {
    expect((await editDocumentTool.run({ document: "doc-1" }, ctx())).kind).toBe("error");
    expect(
      (
        await editDocumentTool.run(
          { document: "doc-1", content: "a", edits: [{ find: "a", replace: "b" }] },
          ctx(),
        )
      ).kind,
    ).toBe("error");
  });
});
