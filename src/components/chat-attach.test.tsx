import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AttachInput, ChatReceipts } from "./chat-attach";
import type { ChatUploadReceipt, ChatUploads } from "@/lib/use-chat-uploads";

const receipt = (over: Partial<ChatUploadReceipt> = {}): ChatUploadReceipt => ({
  id: "r1",
  name: "notes.md",
  documentId: "doc-1",
  bundleId: "chat-bundle",
  bundleName: "Ops Assistant — chat uploads",
  state: "done",
  progress: 100,
  indexed: true,
  indexStatus: "ready",
  indexProgress: null,
  indexError: null,
  reason: null,
  ...over,
});

function uploadsWith(
  receipts: ChatUploadReceipt[] = [],
  destinations = [{ id: "runbooks", name: "Runbooks" }],
  waitingFor: string | null = null,
): ChatUploads {
  return {
    receipts,
    destinations,
    addFiles: vi.fn(async () => {}),
    moveTo: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    dismiss: vi.fn(),
    settled: vi.fn(async () => {}),
    waitingFor,
  };
}

describe("AttachInput", () => {
  it("draws no picker for a viewer, who cannot write to the workspace", () => {
    const ref = { current: null as HTMLInputElement | null };
    render(<AttachInput uploads={uploadsWith()} canWrite={false} inputRef={ref} />);

    expect(screen.queryByLabelText(/choose documents/i)).not.toBeInTheDocument();
  });

  it("hands the picked files to the uploader", async () => {
    const user = userEvent.setup();
    const uploads = uploadsWith();
    const ref = { current: null as HTMLInputElement | null };
    render(<AttachInput uploads={uploads} canWrite inputRef={ref} />);

    const input = screen.getByLabelText(/choose documents/i);
    await user.upload(input, new File(["hello"], "notes.md", { type: "text/markdown" }));

    expect(uploads.addFiles).toHaveBeenCalledWith([expect.objectContaining({ name: "notes.md" })]);
  });

  it("exposes its picker through the ref it is given", () => {
    const ref = { current: null as HTMLInputElement | null };
    render(<AttachInput uploads={uploadsWith()} canWrite inputRef={ref} />);

    expect(ref.current).toBe(screen.getByLabelText(/choose documents/i));
  });
});

describe("ChatReceipts", () => {
  it("names an uploaded document and says it is retrievable", () => {
    render(<ChatReceipts uploads={uploadsWith([receipt()])} />);

    expect(screen.getByText("notes.md")).toBeInTheDocument();
    expect(screen.getByText(/^indexed$/i)).toBeInTheDocument();
  });

  it("says when a document is in but cannot be retrieved from", () => {
    render(
      <ChatReceipts uploads={uploadsWith([receipt({ indexed: false, indexStatus: null })])} />,
    );

    expect(screen.getByText(/not indexed/i)).toBeInTheDocument();
  });

  it("reads a queued file as indexing, not as unindexed", () => {
    render(
      <ChatReceipts uploads={uploadsWith([receipt({ indexed: false, indexStatus: "queued" })])} />,
    );

    expect(screen.getByText("Indexing…")).toBeInTheDocument();
    expect(screen.queryByText(/not indexed/i)).not.toBeInTheDocument();
  });

  it("shows how far the indexing job has got", () => {
    render(
      <ChatReceipts
        uploads={uploadsWith([
          receipt({
            indexed: false,
            indexStatus: "indexing",
            indexProgress: { done: 1, total: 4 },
          }),
        ])}
      />,
    );

    expect(screen.getByText("Indexing 25%")).toBeInTheDocument();
  });

  it("says not indexed when the job failed, with its error on hover", () => {
    render(
      <ChatReceipts
        uploads={uploadsWith([
          receipt({ indexed: false, indexStatus: "failed", indexError: "no text in it" }),
        ])}
      />,
    );

    expect(screen.getByText(/not indexed/i).closest("[title]")).toHaveAttribute(
      "title",
      "no text in it",
    );
  });

  it("says which file a send is waiting on", () => {
    render(
      <ChatReceipts
        uploads={uploadsWith(
          [receipt({ indexed: false, indexStatus: "indexing" })],
          [],
          "notes.md",
        )}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for notes.md to finish indexing…",
    );
  });

  it("shows the progress of a file still going up", () => {
    render(
      <ChatReceipts
        uploads={uploadsWith([receipt({ state: "uploading", progress: 42, documentId: null })])}
      />,
    );

    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("keeps a failure and its reason in view", () => {
    render(
      <ChatReceipts
        uploads={uploadsWith([
          receipt({ state: "failed", documentId: null, reason: "quota reached" }),
        ])}
      />,
    );

    expect(screen.getByText(/quota reached/i)).toBeInTheDocument();
  });

  it("removes the document behind a receipt", async () => {
    const user = userEvent.setup();
    const uploads = uploadsWith([receipt()]);
    render(<ChatReceipts uploads={uploads} />);

    await user.click(screen.getByRole("button", { name: /remove notes\.md/i }));

    expect(uploads.remove).toHaveBeenCalledWith("r1");
  });

  it("says which bundle the file went into", () => {
    render(<ChatReceipts uploads={uploadsWith([receipt()])} />);

    expect(screen.getByText(/Ops Assistant — chat uploads/)).toBeInTheDocument();
  });

  it("offers to move a finished upload into a bundle someone curates", async () => {
    const user = userEvent.setup();
    const uploads = uploadsWith([receipt()]);
    render(<ChatReceipts uploads={uploads} />);

    await user.click(screen.getByRole("button", { name: /^move notes\.md/i }));
    await user.click(screen.getByRole("button", { name: "Runbooks" }));

    expect(uploads.moveTo).toHaveBeenCalledWith("r1", "runbooks");
  });

  it("offers no move when there is nowhere to move it", () => {
    render(<ChatReceipts uploads={uploadsWith([receipt()], [])} />);

    expect(screen.queryByRole("button", { name: /^move notes\.md/i })).not.toBeInTheDocument();
  });

  it("offers no move for a file that is still going up", () => {
    render(
      <ChatReceipts uploads={uploadsWith([receipt({ state: "uploading", documentId: null })])} />,
    );

    expect(screen.queryByRole("button", { name: /^move notes\.md/i })).not.toBeInTheDocument();
  });
});
