import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const download = vi.fn();
const exportDocument = vi.fn();
const toastError = vi.fn();

vi.mock("@/lib/api-client", () => ({
  api: { documents: { download, export: exportDocument } },
}));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const { saveDocument, isMarkdownName, printPath } = await import("./document-export");

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("saveDocument", () => {
  it("downloads Markdown as the stored file", async () => {
    await saveDocument("doc-1", "Q3.md", "md");
    expect(download).toHaveBeenCalledWith("doc-1", "Q3.md");
    expect(exportDocument).not.toHaveBeenCalled();
  });

  it("asks the server for Word and PDF", async () => {
    exportDocument.mockResolvedValue("saved");
    await saveDocument("doc-1", "Q3.md", "docx");
    await saveDocument("doc-1", "Q3.md", "pdf");
    expect(exportDocument.mock.calls).toEqual([
      ["doc-1", "docx"],
      ["doc-1", "pdf"],
    ]);
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("prints in this tab when the server has no browser to print with", async () => {
    exportDocument.mockResolvedValue("print");
    await saveDocument("doc-1", "Q3.md", "pdf");
    const frame = document.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe(printPath("doc-1"));
  });

  it("says so when the export fails, rather than failing quietly", async () => {
    exportDocument.mockRejectedValue(new Error("failed to make the PDF"));
    await saveDocument("doc-1", "Q3.md", "pdf");
    expect(toastError).toHaveBeenCalledWith("Couldn't save the document: failed to make the PDF");
  });
});

describe("isMarkdownName", () => {
  it("knows a Markdown file by its name", () => {
    expect(isMarkdownName("Q3.md")).toBe(true);
    expect(isMarkdownName("notes.MARKDOWN")).toBe(true);
    expect(isMarkdownName("deck.pdf")).toBe(false);
  });
});
