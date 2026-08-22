import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useChatUploads } from "./use-chat-uploads";

const ensureChatBundle = vi.fn();
const uploadToBundle = vi.fn();
const removeDocument = vi.fn();

vi.mock("@/lib/agents-store", () => ({
  useAgentsStore: () => ({ ensureChatBundle, uploadToBundle, removeDocument }),
}));

const error = vi.fn();
const warning = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => error(...args),
    warning: (...args: unknown[]) => warning(...args),
    success: vi.fn(),
  },
}));

const agent = { id: "agent-1", name: "Ops Assistant" };

const fileNamed = (name: string, body = "hello") => new File([body], name, { type: "text/plain" });

const indexedDoc = (name: string) => ({
  id: `doc-${name}`,
  name,
  size: 5,
  chunkCount: 3,
  indexed: true,
});

beforeEach(() => {
  ensureChatBundle.mockReset().mockResolvedValue({ id: "bundle-1" });
  uploadToBundle.mockReset();
  removeDocument.mockReset().mockResolvedValue(undefined);
  error.mockReset();
  warning.mockReset();
});

describe("useChatUploads", () => {
  it("uploads into the agent's chat bundle, resolving it first", async () => {
    uploadToBundle.mockResolvedValue(indexedDoc("notes.md"));
    const { result } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("notes.md")]);
    });

    expect(ensureChatBundle).toHaveBeenCalledWith(agent);
    expect(uploadToBundle).toHaveBeenCalledWith("bundle-1", expect.any(File), expect.any(Function));
  });

  it("refuses a file the server would refuse anyway, without resolving a bundle", async () => {
    const { result } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("deck.pptx")]);
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining("deck.pptx"));
    expect(ensureChatBundle).not.toHaveBeenCalled();
    expect(uploadToBundle).not.toHaveBeenCalled();
  });

  it("leaves a receipt naming the uploaded document", async () => {
    uploadToBundle.mockResolvedValue(indexedDoc("notes.md"));
    const { result } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("notes.md")]);
    });

    await waitFor(() => {
      expect(result.current.receipts).toHaveLength(1);
    });
    expect(result.current.receipts[0]).toMatchObject({
      name: "notes.md",
      documentId: "doc-notes.md",
      state: "done",
      indexed: true,
    });
  });

  it("says so when a document uploaded but embedded nothing", async () => {
    uploadToBundle.mockResolvedValue({ ...indexedDoc("odd.md"), chunkCount: 0, indexed: false });
    const { result } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("odd.md")]);
    });

    // Retrieval cannot match a passage in it, so the reply will not be grounded
    // on it. Saying nothing here is how a file ends up trusted for an answer it
    // never contributed to.
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("odd.md"));
    expect(result.current.receipts[0].indexed).toBe(false);
  });

  it("keeps the failure on screen instead of a toast that scrolls away", async () => {
    uploadToBundle.mockRejectedValue(new Error("quota reached"));
    const { result } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("notes.md")]);
    });

    await waitFor(() => {
      expect(result.current.receipts[0]).toMatchObject({
        state: "failed",
        reason: "quota reached",
      });
    });
  });

  it("removes the document and its receipt together", async () => {
    uploadToBundle.mockResolvedValue(indexedDoc("notes.md"));
    const { result } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("notes.md")]);
    });
    await act(async () => {
      await result.current.remove(result.current.receipts[0].id);
    });

    expect(removeDocument).toHaveBeenCalledWith("agent-1", "doc-notes.md");
    expect(result.current.receipts).toHaveLength(0);
  });

  it("uploads several dropped files in one go", async () => {
    uploadToBundle.mockImplementation(async (_b: string, f: File) => indexedDoc(f.name));
    const { result } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("a.md"), fileNamed("b.csv")]);
    });

    expect(uploadToBundle).toHaveBeenCalledTimes(2);
    // The bundle is resolved once, not once per file — two files must not race
    // into two bundles.
    expect(ensureChatBundle).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.receipts).toHaveLength(2));
  });
});
