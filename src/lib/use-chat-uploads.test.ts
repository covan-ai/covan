import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useChatUploads } from "./use-chat-uploads";

const ensureChatBundle = vi.fn();
const uploadToBundle = vi.fn();
const removeDocument = vi.fn();
const moveDocument = vi.fn();

const bundles = [
  {
    id: "bundle-1",
    name: "Ops Assistant — chat uploads",
    description: "covan:chat-uploads:agent-1",
    documentCount: 0,
    createdAt: 0,
    shared: false,
    mine: true,
  },
  { id: "runbooks", name: "Runbooks", description: null, documentCount: 3, createdAt: 0 },
];

// The agents list as the store last read it. Tests change it and rerender,
// which is what the store's poll does while a document is being indexed.
type LiveDoc = {
  id: string;
  indexed: boolean;
  indexStatus: "queued" | "indexing" | "ready" | "partial" | "failed" | null;
  indexProgress?: { done: number; total: number } | null;
  indexError?: string | null;
};
let agents: { id: string; documents: LiveDoc[] }[] = [];

vi.mock("@/lib/agents-store", () => ({
  useAgentsStore: () => ({
    ensureChatBundle,
    uploadToBundle,
    removeDocument,
    moveDocument,
    bundles,
    agents,
  }),
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
  indexStatus: "ready" as const,
});

// What the upload route actually answers since indexing became a job: stored,
// listed, and not yet searchable.
const queuedDoc = (name: string) => ({
  id: `doc-${name}`,
  name,
  size: 5,
  chunkCount: 0,
  indexed: false,
  indexStatus: "queued" as const,
});

const live = (docs: LiveDoc[]) => {
  agents = [{ id: "agent-1", documents: docs }];
};

beforeEach(() => {
  agents = [];
  ensureChatBundle.mockReset().mockResolvedValue({ id: "bundle-1" });
  uploadToBundle.mockReset();
  removeDocument.mockReset().mockResolvedValue(undefined);
  moveDocument.mockReset().mockResolvedValue(undefined);
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
      await result.current.addFiles([fileNamed("setup.exe")]);
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining("setup.exe"));
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

  it("reads a fresh upload as indexing, not as unindexed, and warns of nothing yet", async () => {
    uploadToBundle.mockResolvedValue(queuedDoc("notes.md"));
    const { result } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("notes.md")]);
    });

    expect(result.current.receipts[0]).toMatchObject({
      state: "done",
      indexed: false,
      indexStatus: "queued",
    });
    // Queued is not a failure. The warning this used to raise here was wrong
    // for every upload, and the chip it left said "Not indexed" for good.
    expect(warning).not.toHaveBeenCalled();
  });

  it("follows the indexing job through the store until the file is searchable", async () => {
    uploadToBundle.mockResolvedValue(queuedDoc("notes.md"));
    const { result, rerender } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("notes.md")]);
    });

    live([
      {
        id: "doc-notes.md",
        indexed: false,
        indexStatus: "indexing",
        indexProgress: { done: 1, total: 4 },
      },
    ]);
    rerender();
    expect(result.current.receipts[0]).toMatchObject({
      indexStatus: "indexing",
      indexProgress: { done: 1, total: 4 },
      indexed: false,
    });

    live([{ id: "doc-notes.md", indexed: true, indexStatus: "ready" }]);
    rerender();
    expect(result.current.receipts[0]).toMatchObject({ indexStatus: "ready", indexed: true });
    expect(warning).not.toHaveBeenCalled();
  });

  it("warns once when the indexing job fails, and keeps its error", async () => {
    uploadToBundle.mockResolvedValue(queuedDoc("odd.md"));
    const { result, rerender } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("odd.md")]);
    });
    live([
      { id: "doc-odd.md", indexed: false, indexStatus: "failed", indexError: "no text in it" },
    ]);
    rerender();
    rerender();

    // Retrieval cannot match a passage in it, so the reply will not be grounded
    // on it. Saying nothing here is how a file ends up trusted for an answer it
    // never contributed to.
    expect(result.current.receipts[0]).toMatchObject({
      indexed: false,
      indexStatus: "failed",
      indexError: "no text in it",
    });
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("odd.md"));
  });

  it("holds a send until the file being indexed is searchable", async () => {
    uploadToBundle.mockResolvedValue(queuedDoc("notes.md"));
    const { result, rerender } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("notes.md")]);
    });

    let done = false;
    let wait!: Promise<void>;
    act(() => {
      wait = result.current.settled(5_000).then(() => {
        done = true;
      });
    });
    await waitFor(() => expect(result.current.waitingFor).toBe("notes.md"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
    });
    expect(done).toBe(false);

    live([{ id: "doc-notes.md", indexed: true, indexStatus: "ready" }]);
    rerender();
    await act(async () => {
      await wait;
    });
    expect(done).toBe(true);
    expect(result.current.waitingFor).toBeNull();
  });

  it("stops holding a send once the wait runs out", async () => {
    uploadToBundle.mockResolvedValue(queuedDoc("notes.md"));
    const { result } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("notes.md")]);
    });
    await act(async () => {
      await result.current.settled(300);
    });

    expect(result.current.receipts[0].indexStatus).toBe("queued");
    expect(result.current.waitingFor).toBeNull();
  });

  it("does not wait at all when nothing is still coming", async () => {
    uploadToBundle.mockResolvedValue(indexedDoc("notes.md"));
    const { result } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("notes.md")]);
    });
    const started = Date.now();
    await act(async () => {
      await result.current.settled();
    });

    expect(Date.now() - started).toBeLessThan(200);
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

    expect(removeDocument).toHaveBeenCalledWith("doc-notes.md");
    expect(result.current.receipts).toHaveLength(0);
  });

  it("offers every bundle except the one the file is already in", async () => {
    const { result } = renderHook(() => useChatUploads(agent));

    // The chat bundle is where it landed; offering it as a destination would be
    // offering to do nothing.
    expect(result.current.destinations).toEqual([{ id: "runbooks", name: "Runbooks" }]);
  });

  it("moves a document into a bundle someone curates, and says where it went", async () => {
    uploadToBundle.mockResolvedValue(indexedDoc("notes.md"));
    const { result } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("notes.md")]);
    });
    await act(async () => {
      await result.current.moveTo(result.current.receipts[0].id, "runbooks");
    });

    expect(moveDocument).toHaveBeenCalledWith("doc-notes.md", "runbooks");
    expect(result.current.receipts[0].bundleName).toBe("Runbooks");
  });

  it("leaves the receipt where it was when the move fails", async () => {
    uploadToBundle.mockResolvedValue(indexedDoc("notes.md"));
    moveDocument.mockRejectedValue(new Error("could not move this document's indexed passages"));
    const { result } = renderHook(() => useChatUploads(agent));

    await act(async () => {
      await result.current.addFiles([fileNamed("notes.md")]);
    });
    await act(async () => {
      await result.current.moveTo(result.current.receipts[0].id, "runbooks");
    });

    expect(error).toHaveBeenCalledWith(expect.stringContaining("passages"));
    expect(result.current.receipts[0].bundleName).toBe("Ops Assistant — chat uploads");
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
