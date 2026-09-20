import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";

const listDocuments = vi.fn();

vi.mock("@/lib/api-client", () => ({
  api: {
    documents: { download: vi.fn(), preview: vi.fn(), bytes: vi.fn() },
    bundles: {
      documents: (id: string) => listDocuments(id),
      citations: vi.fn().mockResolvedValue({ since: null, counts: { "doc-2": 4 } }),
    },
  },
}));
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));

const BUNDLES = [
  { id: "bundle-1", name: "GTM knowledge", description: "What sales asks", documentCount: 2 },
  { id: "bundle-2", name: "Old pricing", description: null, documentCount: 0 },
];

const store = {
  bundles: BUNDLES,
  // Who reads which bundle is a join over these, and the explorer does it in
  // the browser rather than asking for it per document.
  agents: [] as { id: string; name: string; bundleIds: string[] }[],
  canWrite: true,
  uploadToBundle: vi.fn(),
  removeDocument: vi.fn().mockResolvedValue(undefined),
  createBundle: vi.fn(),
  updateBundle: vi.fn().mockResolvedValue({ id: "bundle-1", name: "Sales knowledge" }),
  attachBundle: vi.fn(),
  detachBundle: vi.fn(),
  removeBundle: vi.fn(),
  reindexDocument: vi.fn().mockResolvedValue({ chunkCount: 9 }),
  moveDocument: vi.fn().mockResolvedValue(undefined),
};

vi.mock("@/lib/agents-store", () => ({
  useAgentsStore: () => store,
  bundleDocumentsKey: (id: string) => ["bundle-documents", id],
}));

const DAY = 24 * 60 * 60 * 1000;

const documents = [
  {
    id: "doc-1",
    name: "zebra-notes.md",
    size: 512,
    createdAt: Date.now() - 2 * DAY,
    chunkCount: 3,
    indexed: true,
    bundleId: "bundle-1",
  },
  {
    id: "doc-2",
    name: "annual-report.pdf",
    size: 4 * 1024 * 1024,
    createdAt: Date.now() - 200 * DAY,
    chunkCount: 0,
    indexed: false,
    bundleId: "bundle-1",
  },
];

let KnowledgeExplorer: typeof import("./knowledge-explorer").KnowledgeExplorer;

beforeEach(async () => {
  vi.clearAllMocks();
  store.canWrite = true;
  store.bundles = BUNDLES;
  store.agents = [];
  store.updateBundle.mockResolvedValue({ id: "bundle-1", name: "Sales knowledge" });
  store.moveDocument.mockResolvedValue(undefined);
  listDocuments.mockResolvedValue(documents);
  ({ KnowledgeExplorer } = await import("./knowledge-explorer"));
});

function renderExplorer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <KnowledgeExplorer />
    </QueryClientProvider>,
  );
}

/**
 * The document rows, in the order they are drawn.
 *
 * The name is the row's first span; the ones after it are the columns that fold
 * into the line under it on a narrow screen, and they are in `textContent` too.
 */
function fileNames(): string[] {
  return screen
    .getAllByLabelText(/^Open .*\.(md|pdf|csv|json|txt)$/i)
    .map((el) => el.querySelector("span")?.textContent?.trim() ?? "");
}

describe("the Knowledge explorer, on the workspace page", () => {
  // Without an agent there is no "everything this agent reads", so the first
  // bundle is the folder it opens on — a page that opened on nothing would make
  // picking a bundle a step before seeing any file at all.
  it("opens the first bundle and lists what is in it", async () => {
    renderExplorer();

    expect(listDocuments).toHaveBeenCalledWith("bundle-1");
    expect(await screen.findByText("annual-report.pdf")).toBeInTheDocument();
    expect(screen.getByText("zebra-notes.md")).toBeInTheDocument();
  });

  it("says what a file is, in the units the file is in", async () => {
    renderExplorer();
    await screen.findByText("annual-report.pdf");

    // Not "4096 KB", which is the column nobody compares.
    expect(screen.getByText("4.0 MB")).toBeInTheDocument();
    expect(screen.getByText("512 B")).toBeInTheDocument();
  });

  it("separates a file whose passages can be matched from one whose cannot", async () => {
    renderExplorer();
    await screen.findByText("annual-report.pdf");

    const indexed = screen.getByLabelText(/open zebra-notes\.md/i).closest("div") as HTMLElement;
    const not = screen.getByLabelText(/open annual-report\.pdf/i).closest("div") as HTMLElement;
    expect(within(indexed).getByText("Indexed")).toBeInTheDocument();
    expect(within(not).getByText("Not indexed")).toBeInTheDocument();
  });

  it("filters by name, and says so rather than looking empty", async () => {
    renderExplorer();
    await screen.findByText("annual-report.pdf");

    await userEvent.type(screen.getByLabelText(/search files by name/i), "zebra");

    expect(screen.getByText("zebra-notes.md")).toBeInTheDocument();
    expect(screen.queryByText("annual-report.pdf")).not.toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText(/search files by name/i));
    await userEvent.type(screen.getByLabelText(/search files by name/i), "nothing-like-this");

    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
  });

  it("sorts by a column, and turns it around on a second press", async () => {
    renderExplorer();
    await screen.findByText("annual-report.pdf");

    // Name, ascending, is where it starts.
    expect(fileNames()).toEqual(["annual-report.pdf", "zebra-notes.md"]);

    await userEvent.click(screen.getByRole("button", { name: /sort by size/i }));
    expect(fileNames()).toEqual(["zebra-notes.md", "annual-report.pdf"]);

    await userEvent.click(screen.getByRole("button", { name: /sort by size/i }));
    expect(fileNames()).toEqual(["annual-report.pdf", "zebra-notes.md"]);
  });

  it("moves a document into another bundle from the row menu", async () => {
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    await userEvent.click(screen.getByLabelText(/actions for zebra-notes\.md/i));
    await userEvent.click(screen.getByRole("menuitem", { name: /move to/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Old pricing" }));

    expect(store.moveDocument).toHaveBeenCalledWith("doc-1", "bundle-2");
  });

  // The bundle it is already in is not offered, because moving a file to where
  // it is is not a thing anybody means to do.
  it("does not offer the bundle the document is already in", async () => {
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    await userEvent.click(screen.getByLabelText(/actions for zebra-notes\.md/i));
    await userEvent.click(screen.getByRole("menuitem", { name: /move to/i }));

    expect(await screen.findByRole("menuitem", { name: "Old pricing" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "GTM knowledge" })).not.toBeInTheDocument();
  });

  it("renames a bundle in place", async () => {
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    await userEvent.click(screen.getByLabelText(/actions for gtm knowledge/i));
    await userEvent.click(screen.getByRole("menuitem", { name: /rename/i }));

    const field = screen.getByLabelText(/rename gtm knowledge/i);
    await userEvent.clear(field);
    await userEvent.type(field, "Sales knowledge{Enter}");

    expect(store.updateBundle).toHaveBeenCalledWith("bundle-1", { name: "Sales knowledge" });
  });

  it("switches to a grid without losing the filter", async () => {
    renderExplorer();
    await screen.findByText("annual-report.pdf");

    await userEvent.type(screen.getByLabelText(/search files by name/i), "zebra");
    await userEvent.click(screen.getByLabelText(/grid view/i));

    expect(screen.getByText("zebra-notes.md")).toBeInTheDocument();
    expect(screen.queryByText("annual-report.pdf")).not.toBeInTheDocument();
    // The extension, not a thumbnail this component cannot actually produce.
    expect(screen.getByText("MD")).toBeInTheDocument();
  });

  it("empties out gracefully for a bundle with nothing in it", async () => {
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    listDocuments.mockResolvedValue([]);
    await userEvent.click(screen.getByRole("button", { name: /open old pricing/i }));

    expect(await screen.findByText("Nothing here yet")).toBeInTheDocument();
    expect(screen.getByText("Drop files into Old pricing")).toBeInTheDocument();
  });

  it("gives a viewer the files and none of the controls that change them", async () => {
    store.canWrite = false;
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    expect(screen.queryByText(/drop files into/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("New bundle")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/actions for gtm knowledge/i)).not.toBeInTheDocument();
  });

  // Without an agent there is nothing to attach to, so the switch has no meaning
  // and is not drawn — the same component, one fewer control.
  it("has no attach switch when it is not standing on an agent", async () => {
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(screen.queryByText("Not attached")).not.toBeInTheDocument();
  });

  it("counts how many answers stand on a document", async () => {
    renderExplorer();
    await screen.findByText("annual-report.pdf");

    const row = screen.getByLabelText(/open annual-report\.pdf/i).closest("div");
    expect(within(row as HTMLElement).getByTitle(/how many answers cite/i)).toHaveTextContent("4");
  });
});

/**
 * Picking several files and doing one thing to all of them.
 *
 * The drag itself is not tested through the DOM: dnd-kit decides what a drop
 * landed on from measured rectangles, and every rectangle in jsdom is zero by
 * zero, so a passing test there would prove the collision detector picked the
 * first droppable rather than the right one. What the drop *means* —  which
 * documents go, and where — is `dropPayload`, and it has its own tests in
 * `lib/knowledge-selection.test.ts`. What is below is everything that is not
 * the pointer: the ticking, the bar, and the batch.
 */
describe("selecting more than one file", () => {
  const tick = (name: string) => screen.getByLabelText(`Select ${name}`);

  it("acts on every ticked file, and says so once", async () => {
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    await userEvent.click(tick("zebra-notes.md"));
    await userEvent.click(tick("annual-report.pdf"));
    expect(screen.getByText("2 selected")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^move to$/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Old pricing" }));

    expect(store.moveDocument).toHaveBeenCalledTimes(2);
    expect(store.moveDocument).toHaveBeenCalledWith("doc-1", "bundle-2");
    expect(store.moveDocument).toHaveBeenCalledWith("doc-2", "bundle-2");
    expect(toast.success).toHaveBeenCalledWith("Moved 2 files to Old pricing");
  });

  // The case the batch exists for: 0024 refuses a move whose passages cannot
  // follow. Half the files moved, and saying "something went wrong" would
  // leave somebody to work out which half.
  it("names the file that refused and how many got through", async () => {
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    store.moveDocument
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("could not move this document's indexed passages"));

    await userEvent.click(tick("annual-report.pdf"));
    await userEvent.click(tick("zebra-notes.md"));
    await userEvent.click(screen.getByRole("button", { name: /^move to$/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Old pricing" }));

    expect(toast.success).not.toHaveBeenCalled();
    const said = (toast.error as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(said).toContain("Moved 1 of 2 to Old pricing.");
    expect(said).toContain("could not move this document's indexed passages");
  });

  it("deletes the whole selection behind one confirmation", async () => {
    const confirmed = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    await userEvent.click(tick("zebra-notes.md"));
    await userEvent.click(screen.getByRole("button", { name: /select all 2/i }));
    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));

    expect(confirmed).toHaveBeenCalledTimes(1);
    expect(confirmed.mock.calls[0][0]).toContain("2 files");
    expect(store.removeDocument).toHaveBeenCalledWith("doc-1");
    expect(store.removeDocument).toHaveBeenCalledWith("doc-2");
    expect(toast.success).toHaveBeenCalledWith("Deleted 2 files");
    confirmed.mockRestore();
  });

  it("takes the rows between two clicks when the second is shift-clicked", async () => {
    // One instance for the whole test, because the direct API forgets that
    // Shift is being held between calls.
    const user = userEvent.setup();
    listDocuments.mockResolvedValue([
      ...documents,
      { ...documents[0], id: "doc-3", name: "handbook.md" },
    ]);
    renderExplorer();
    await screen.findByText("handbook.md");

    // Sorted by name: annual-report.pdf, handbook.md, zebra-notes.md.
    await user.click(tick("annual-report.pdf"));
    await user.keyboard("{Shift>}");
    await user.click(tick("zebra-notes.md"));
    await user.keyboard("{/Shift}");

    expect(screen.getByText("3 selected")).toBeInTheDocument();
  });

  it("puts the selection away when another bundle is opened", async () => {
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    await userEvent.click(tick("zebra-notes.md"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();

    listDocuments.mockResolvedValue([]);
    await userEvent.click(screen.getByRole("button", { name: /open old pricing/i }));

    expect(screen.queryByText("1 selected")).not.toBeInTheDocument();
  });

  it("gives a viewer no way to tick a file at all", async () => {
    store.canWrite = false;
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    expect(screen.queryByLabelText(/^select /i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^drag /i)).not.toBeInTheDocument();
  });
});

/**
 * What a knowledge base needs once it is too big to read: which files are not
 * working, and which bundles nothing can reach.
 */
describe("finding what is wrong in a folder full of files", () => {
  it("offers a filter only for a problem this folder actually has", async () => {
    renderExplorer();
    await screen.findByText("annual-report.pdf");

    // One file has no passages; one was uploaded 200 days ago. Both are the
    // same file here, and each filter counts it once.
    await userEvent.click(screen.getByRole("button", { name: /needs indexing, 1 file/i }));
    expect(screen.getByText("annual-report.pdf")).toBeInTheDocument();
    expect(screen.queryByText("zebra-notes.md")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^all$/i }));
    expect(screen.getByText("zebra-notes.md")).toBeInTheDocument();
  });

  // A filter left on from another folder is the one thing an empty pane does
  // not explain by itself, so it says so and says how to get out of it.
  it("explains an empty pane that a filter emptied", async () => {
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    // Only the 200-day-old file is stale, and it is not the one searched for.
    await userEvent.click(screen.getByRole("button", { name: /older than 90 days, 1 file/i }));
    await userEvent.type(screen.getByLabelText(/search files by name/i), "zebra");

    expect(screen.getByText("Nothing matches")).toBeInTheDocument();
    // Both reasons, because either one alone would be a half-truth.
    expect(
      screen.getByText(/no file called "zebra" is older than ninety days/i),
    ).toBeInTheDocument();
    // Still there to press, although nothing is under it any more.
    expect(screen.getByRole("button", { name: /^all$/i })).toBeInTheDocument();
  });

  it("says which agents read the open bundle", async () => {
    store.agents = [
      { id: "a1", name: "Ada", bundleIds: ["bundle-1"] },
      { id: "a2", name: "Ops bot", bundleIds: ["bundle-1"] },
    ];
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    expect(screen.getByText("Read by Ada and Ops bot.")).toBeInTheDocument();
  });

  // The failure this answers: files uploaded into a bundle nobody ever
  // attached, which look filed away and can never ground an answer.
  it("marks the bundle no agent reads, in the rail and in the pane", async () => {
    store.agents = [{ id: "a1", name: "Ada", bundleIds: ["bundle-1"] }];
    renderExplorer();
    await screen.findByText("zebra-notes.md");

    const rail = screen.getByLabelText(/open old pricing/i);
    expect(rail).toHaveTextContent("no agent reads it");

    listDocuments.mockResolvedValue([]);
    await userEvent.click(rail);
    expect(await screen.findByText(/no agent reads this bundle yet/i)).toBeInTheDocument();
  });

  it("gives the rail a search of its own once there are too many bundles", async () => {
    store.bundles = Array.from({ length: 9 }, (_, i) => ({
      id: `bundle-${i}`,
      name: i === 8 ? "Pricing" : `Bundle ${i}`,
      description: null,
      documentCount: 0,
    }));
    listDocuments.mockResolvedValue([]);
    renderExplorer();

    const find = await screen.findByLabelText(/find a bundle by name/i);
    await userEvent.type(find, "pricing");

    expect(screen.getByLabelText("Open Pricing")).toBeInTheDocument();
    expect(screen.queryByLabelText("Open Bundle 0")).not.toBeInTheDocument();

    await userEvent.clear(find);
    await userEvent.type(find, "nothing-like-this");
    expect(screen.getByText(/no bundle is called "nothing-like-this"/i)).toBeInTheDocument();
  });
});
