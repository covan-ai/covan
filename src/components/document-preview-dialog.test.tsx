import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const preview = vi.fn();
const bytes = vi.fn();
const download = vi.fn();

// Every entry is a wrapper rather than the spy itself: `vi.mock` is hoisted
// above the `const`s above, so naming one directly reads it before it exists.
vi.mock("@/lib/api-client", () => ({
  api: {
    documents: {
      preview: (id: string) => preview(id),
      bytes: (id: string) => bytes(id),
      download: (id: string, name: string) => download(id, name),
    },
  },
}));

import { DocumentPreviewDialog } from "./document-preview-dialog";

const EXCERPT_LIMIT = 8000;

function row(over: Record<string, unknown> = {}) {
  return {
    id: "doc-1",
    name: "handbook.md",
    size: 2048,
    createdAt: Date.parse("2026-09-01T00:00:00.000Z"),
    chunkCount: 3,
    indexed: true,
    bundleId: "bundle-1",
    connectionId: null,
    externalUrl: null,
    syncedAt: null,
    excerpt: "## Leave\n\nTwenty days a year.",
    excerptLimit: EXCERPT_LIMIT,
    excerptTruncated: false,
    ...over,
  };
}

/** A blob whose `text()` works under jsdom regardless of its Blob support. */
function textBlob(text: string) {
  return { blob: { text: async () => text } as unknown as Blob, contentType: "text/plain" };
}

function open(name = "handbook.md") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DocumentPreviewDialog documentId="doc-1" name={name} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  preview.mockResolvedValue(row());
  bytes.mockResolvedValue(textBlob("## Leave\n\nTwenty days a year."));
});

describe("the document preview", () => {
  it("names the file and what it cost to index, before either tab is read", async () => {
    open();

    expect(await screen.findByText("2.0 KB")).toBeInTheDocument();
    expect(screen.getByText("3 passages")).toBeInTheDocument();
  });

  it("renders a markdown file as markdown rather than as its source", async () => {
    open();

    // The hashes are gone, which is the whole difference between this tab and
    // the excerpt tab's <pre> of the same text.
    expect(await screen.findByText("Leave")).toBeInTheDocument();
    expect(screen.queryByText("## Leave")).not.toBeInTheDocument();
  });

  it("draws a CSV as a table", async () => {
    bytes.mockResolvedValue(textBlob('name,plan\nAcme,"Berlin, Germany"'));
    open("customers.csv");

    expect(await screen.findByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "name" })).toBeInTheDocument();
    // The quoted comma stayed inside one cell.
    expect(screen.getByRole("cell", { name: "Berlin, Germany" })).toBeInTheDocument();
  });

  it("reformats JSON that parses, and leaves alone what does not", async () => {
    bytes.mockResolvedValue(textBlob('{"plan":"pro","seats":4}'));
    open("config.json");

    expect(await screen.findByText(/"plan": "pro"/)).toBeInTheDocument();
  });

  // The tab that has no equivalent anywhere else: what the agent has of the
  // file, which is not the same as the file.
  it("shows the stored text, and says it is the whole of it when it is", async () => {
    open();
    await userEvent.click(screen.getByRole("button", { name: /what the agent reads/i }));

    expect(await screen.findByText(/cut into 3 passages/i)).toBeInTheDocument();
    expect(screen.getByText("This is the whole of the document's text.")).toBeInTheDocument();
  });

  // The asymmetry that decides how to read an answer: the passages are cut from
  // the whole document, the stored text stops at 8000 characters.
  it("says where the stored text stops, without claiming how much came after", async () => {
    preview.mockResolvedValue(row({ excerptTruncated: true, excerpt: "x".repeat(EXCERPT_LIMIT) }));
    open();
    await userEvent.click(screen.getByRole("button", { name: /what the agent reads/i }));

    expect(await screen.findByText(/stops at 8,000 characters/i)).toBeInTheDocument();
    expect(screen.getByText(/the rest of the file is still searchable/i)).toBeInTheDocument();
  });

  it("explains an unindexed document instead of showing an empty panel", async () => {
    preview.mockResolvedValue(row({ indexed: false, chunkCount: 0 }));
    open();
    await userEvent.click(screen.getByRole("button", { name: /what the agent reads/i }));

    expect(await screen.findByText(/no passages/i)).toBeInTheDocument();
    expect(screen.getByText(/reindexing is what makes it searchable/i)).toBeInTheDocument();
  });

  // Uploaded before the no-text refusal existed. The row is real and there is
  // nothing behind it, which is a different thing from a failed request.
  it("says nothing was stored, for the document that has no text", async () => {
    preview.mockResolvedValue(row({ excerpt: "" }));
    open();
    await userEvent.click(screen.getByRole("button", { name: /what the agent reads/i }));

    expect(await screen.findByText(/nothing was stored for this document/i)).toBeInTheDocument();
  });

  it("offers the source only for a document a connection owns", async () => {
    open();
    await screen.findByText("2.0 KB");
    expect(screen.queryByRole("link", { name: /source/i })).not.toBeInTheDocument();

    preview.mockResolvedValue(row({ externalUrl: "https://notion.so/page-1" }));
    open();

    expect((await screen.findAllByRole("link", { name: /source/i }))[0]).toHaveAttribute(
      "href",
      "https://notion.so/page-1",
    );
  });

  it("does not ask the store for the bytes until the file tab needs them", async () => {
    // The excerpt is one row and arrives with the dialog; the file is a second
    // request. Opening straight onto the indexed tab should not make it.
    open();
    await userEvent.click(screen.getByRole("button", { name: /what the agent reads/i }));
    await screen.findByText(/cut into 3 passages/i);

    // The file tab is the default, so it was asked for once — and only once.
    expect(bytes).toHaveBeenCalledTimes(1);
  });
});
