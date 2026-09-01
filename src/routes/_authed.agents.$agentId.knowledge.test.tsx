import { describe, it, expect, vi } from "vitest";
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
