import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useParams: () => ({ agentId: "agent-1" }),
  }),
}));

// `bundles.citations` is here because the tab now renders RevisitPanel, which
// asks for it. Answering with nothing to revisit keeps these two tests about
// what they were about — the panel has its own file.
vi.mock("@/lib/api-client", () => ({
  api: {
    documents: { download: vi.fn() },
    bundles: { citations: vi.fn().mockResolvedValue({ since: null, counts: {} }) },
  },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const store = {
  agents: [
    {
      id: "agent-1",
      name: "GTM Agent",
      bundleIds: ["bundle-1"],
      documents: [
        { id: "doc-1", name: "pitch-deck.pdf", size: 4096, chunkCount: 12, indexed: true },
      ],
    },
  ],
  bundles: [{ id: "bundle-1", name: "GTM knowledge", description: null, documentCount: 1 }],
  uploadToBundle: vi.fn(),
  removeDocument: vi.fn(),
  createBundle: vi.fn(),
  attachBundle: vi.fn(),
  detachBundle: vi.fn(),
  removeBundle: vi.fn(),
  reindexDocument: vi.fn(),
  canWrite: true,
};

vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => store }));

/** Puts the workspace back to one bundle with one document in it. */
function withKnowledge() {
  store.bundles = [{ id: "bundle-1", name: "GTM knowledge", description: null, documentCount: 1 }];
  store.agents[0].bundleIds = ["bundle-1"];
}

/** A workspace nobody has uploaded anything to yet. */
function withNothing() {
  store.bundles = [];
  store.agents[0].bundleIds = [];
}

async function renderTab(canWrite: boolean) {
  store.canWrite = canWrite;
  const { Route } = await import("./_authed.agents.$agentId.knowledge");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

describe("the Knowledge tab", () => {
  beforeEach(withKnowledge);
  // The read-only notice promises a viewer "can read every bundle attached to
  // this agent and everything in it". The document list used to sit inside the
  // `canWrite` branch alongside the upload form, so a viewer read the promise
  // and then saw nothing it was about.
  it("shows a viewer the documents behind the agent, without the controls that change them", async () => {
    await renderTab(false);

    expect(screen.getByText("pitch-deck.pdf")).toBeInTheDocument();
    expect(screen.getByText("Indexed")).toBeInTheDocument();
    expect(screen.queryByLabelText(/remove pitch-deck\.pdf/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/reindex pitch-deck\.pdf/i)).not.toBeInTheDocument();
  });

  it("gives a member the same documents and the controls too", async () => {
    await renderTab(true);

    expect(screen.getByText("pitch-deck.pdf")).toBeInTheDocument();
    expect(screen.getByLabelText(/remove pitch-deck\.pdf/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/reindex pitch-deck\.pdf/i)).toBeInTheDocument();
  });
});

// covan#45: an empty workspace is the one screen where the product looks like a
// chat window, and the reason is that nobody has told it anything yet. "No
// bundles yet" is true and useless — there is a specific answer to "what now".
describe("a workspace with nothing in it", () => {
  beforeEach(withNothing);

  it("tells a member what to upload first, instead of that there is nothing", async () => {
    await renderTab(true);

    expect(screen.getByText("Start with four files")).toBeInTheDocument();
    expect(screen.getByText("The handbook")).toBeInTheDocument();
    expect(screen.getByText("The answer you have typed twice")).toBeInTheDocument();
    expect(screen.queryByText("No bundles yet")).not.toBeInTheDocument();
  });

  it("gives a viewer the plain empty state, because they cannot act on the list", async () => {
    // A checklist you are not allowed to complete is worse than a blank: it
    // reads as your job until you try, and the upload control is not there.
    await renderTab(false);

    expect(screen.getByText("No bundles yet")).toBeInTheDocument();
    expect(screen.queryByText("Start with four files")).not.toBeInTheDocument();
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
      await renderTab(true);

      expect(screen.getByLabelText(/download company-overview\.md/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/download faq\.md/i)).toBeInTheDocument();
    } finally {
      store.agents[0].documents = documents;
    }
  });

  it("collapses once there are real documents, rather than competing with them", async () => {
    await renderTab(true);

    expect(screen.queryByLabelText(/download company-overview\.md/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /show the six templates/i })).toBeInTheDocument();
  });

  it("is not offered to a viewer, who could not upload the result", async () => {
    await renderTab(false);

    expect(screen.queryByText(/nothing to upload yet/i)).not.toBeInTheDocument();
  });
});
