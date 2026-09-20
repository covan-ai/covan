import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useParams: () => ({ agentId: "agent-1" }),
  }),
  // The tab links to the workspace Knowledge page; the router is mocked away,
  // so the link is an anchor.
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const listDocuments = vi.fn();

// `bundles.citations` is here because the tab renders RevisitPanel, and
// `bundles.documents` because opening a bundle in the explorer asks for its
// contents. Answering with nothing to revisit keeps these tests about the tab.
vi.mock("@/lib/api-client", () => ({
  api: {
    documents: { download: vi.fn() },
    bundles: {
      citations: vi.fn().mockResolvedValue({ since: null, counts: {} }),
      documents: (id: string) => listDocuments(id),
    },
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const store = {
  agents: [
    {
      id: "agent-1",
      name: "GTM Agent",
      bundleIds: ["bundle-1"],
      documents: [
        {
          id: "doc-1",
          name: "pitch-deck.pdf",
          size: 4096,
          createdAt: Date.parse("2026-09-01T00:00:00.000Z"),
          chunkCount: 12,
          indexed: true,
          bundleId: "bundle-1",
        },
      ],
    },
  ],
  bundles: [{ id: "bundle-1", name: "GTM knowledge", description: null, documentCount: 1 }],
  uploadToBundle: vi.fn(),
  removeDocument: vi.fn(),
  createBundle: vi.fn(),
  updateBundle: vi.fn(),
  attachBundle: vi.fn(),
  detachBundle: vi.fn(),
  removeBundle: vi.fn(),
  reindexDocument: vi.fn(),
  moveDocument: vi.fn(),
  canWrite: true,
};

vi.mock("@/lib/agents-store", () => ({
  useAgentsStore: () => store,
  bundleDocumentsKey: (id: string) => ["bundle-documents", id],
}));

/** Puts the workspace back to one bundle with one document in it. */
function withKnowledge() {
  store.bundles = [{ id: "bundle-1", name: "GTM knowledge", description: null, documentCount: 1 }];
  store.agents[0].bundleIds = ["bundle-1"];
  listDocuments.mockReset().mockResolvedValue([]);
}

/** A workspace nobody has uploaded anything to yet. */
function withNothing() {
  store.bundles = [];
  store.agents[0].bundleIds = [];
  listDocuments.mockReset().mockResolvedValue([]);
}

// Imported once rather than per test. The mocks above are hoisted, so the module
// is safe to pull in from a hook — and on a slow checkout the first import of the
// route and everything under it costs seconds, which the first test was paying
// out of its own timeout.
let Component: () => React.ReactElement;

beforeAll(async () => {
  const { Route } = await import("./_authed.agents.$agentId.knowledge");
  Component = (Route as unknown as { component: () => React.ReactElement }).component;
});

function renderTab(canWrite: boolean) {
  store.canWrite = canWrite;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

describe("the Knowledge tab", () => {
  beforeEach(withKnowledge);

  // The tab opens on the one folder only an agent has: every document in every
  // bundle attached to it. It is the list the tab has always shown.
  it("opens on everything the agent reads", async () => {
    renderTab(true);

    expect(screen.getByText("pitch-deck.pdf")).toBeInTheDocument();
    expect(screen.getByText("Indexed")).toBeInTheDocument();
    // No request for a bundle's contents: this list came with the agent.
    expect(listDocuments).not.toHaveBeenCalled();
  });

  // A viewer can read every bundle and everything in it, which is what the
  // read-only notice promises. Uploading, moving and deleting are a member's.
  it("shows a viewer the documents without the controls that change them", async () => {
    renderTab(false);

    expect(screen.getByText("pitch-deck.pdf")).toBeInTheDocument();
    expect(screen.queryByText(/drop files into/i)).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("New bundle")).not.toBeInTheDocument();
  });

  it("gives a member the upload well and a way to make another bundle", async () => {
    renderTab(true);

    expect(screen.getByPlaceholderText("New bundle")).toBeInTheDocument();
    // Uploading needs a bundle, and "everything this agent reads" is a view
    // rather than a place — so the well says which bundle is missing.
    expect(screen.getByText("Pick a bundle to upload into")).toBeInTheDocument();
  });

  it("offers a member move, reindex and delete on a document, and a viewer none of them", async () => {
    renderTab(true);
    await userEvent.click(screen.getByLabelText(/actions for pitch-deck\.pdf/i));

    expect(screen.getByRole("menuitem", { name: /^open$/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /reindex/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeInTheDocument();
  });

  it("leaves a viewer's menu with only the things reading a document needs", async () => {
    renderTab(false);
    await userEvent.click(screen.getByLabelText(/actions for pitch-deck\.pdf/i));

    expect(screen.getByRole("menuitem", { name: /download/i })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /reindex/i })).not.toBeInTheDocument();
  });

  // The gap the explorer closes. A bundle nobody has attached used to be a name
  // and a count: its documents came through the agent, and an unattached bundle
  // reaches no agent. Now it opens.
  it("opens a bundle no agent has attached", async () => {
    store.bundles = [
      ...store.bundles,
      { id: "bundle-2", name: "Old pricing", description: null, documentCount: 1 },
    ];
    listDocuments.mockResolvedValue([
      {
        id: "doc-9",
        name: "pricing-2024.csv",
        size: 900,
        createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
        chunkCount: 3,
        indexed: true,
        bundleId: "bundle-2",
      },
    ]);

    renderTab(true);
    expect(screen.getByText("Not attached")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /open old pricing/i }));

    expect(listDocuments).toHaveBeenCalledWith("bundle-2");
    expect(await screen.findByText("pricing-2024.csv")).toBeInTheDocument();
    // And uploading now knows where it is going.
    expect(screen.getByText("Drop files into Old pricing")).toBeInTheDocument();
  });

  it("splits the rail into what this agent reads and what it does not", async () => {
    store.bundles = [
      ...store.bundles,
      { id: "bundle-2", name: "Old pricing", description: null, documentCount: 1 },
    ];
    renderTab(true);

    expect(screen.getByText("Attached")).toBeInTheDocument();
    expect(screen.getByText("Not attached")).toBeInTheDocument();
    // The switch is how a bundle crosses between the two groups, and it is the
    // only control on this tab that changes what the agent knows.
    expect(screen.getByLabelText(/attach old pricing to gtm agent/i)).toBeInTheDocument();
  });
});

// covan#45: an empty workspace is the one screen where the product looks like a
// chat window, and the reason is that nobody has told it anything yet. "No
// bundles yet" is true and useless — there is a specific answer to "what now".
describe("a workspace with nothing in it", () => {
  beforeEach(withNothing);

  it("tells a member what to upload first, instead of that there is nothing", async () => {
    renderTab(true);

    expect(screen.getByText("Start with four files")).toBeInTheDocument();
    expect(screen.getByText("The handbook")).toBeInTheDocument();
    expect(screen.getByText("The answer you have typed twice")).toBeInTheDocument();
    expect(screen.queryByText("No bundles yet")).not.toBeInTheDocument();
  });

  it("gives a viewer the explorer's own empty rail, because they cannot act on it", async () => {
    // A checklist you are not allowed to complete is worse than a blank: it
    // reads as your job until you try, and the upload control is not there.
    renderTab(false);

    expect(screen.getByText(/no bundles yet/i)).toBeInTheDocument();
    expect(screen.queryByText("Start with four files")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("New bundle")).not.toBeInTheDocument();
  });
});

// The neighbouring answer to the same question, for the team that does not have
// the four files above either. "Start with four files" names documents you
// already wrote; this names six you can fill in when you have written none.
describe("the starter templates on the Knowledge tab", () => {
  beforeEach(withKnowledge);

  it("opens itself for the agent that has nothing yet", async () => {
    const documents = store.agents[0].documents;
    store.agents[0].documents = [];
    try {
      renderTab(true);

      expect(screen.getByLabelText(/download company-overview\.md/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/download faq\.md/i)).toBeInTheDocument();
    } finally {
      store.agents[0].documents = documents;
    }
  });

  it("collapses once there are real documents, rather than competing with them", async () => {
    renderTab(true);

    expect(screen.queryByLabelText(/download company-overview\.md/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show the six templates/i })).toBeInTheDocument();
  });

  it("is not offered to a viewer, who could not upload the result", async () => {
    renderTab(false);

    expect(screen.queryByText(/nothing to upload yet/i)).not.toBeInTheDocument();
  });
});
