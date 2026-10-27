import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

/**
 * An agent's Knowledge tab (A32): which of the workspace's folders it reads,
 * how much each was used, what else it reaches, what is worth revisiting and
 * how much of what it was asked was not covered.
 */

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useParams: () => ({ agentId: "a1" }),
  }),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/components/top-bar", () => ({
  TopBarPortal: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/document-preview-dialog", () => ({
  DocumentPreviewDialog: ({ name }: { name: string }) => <div role="dialog">{name}</div>,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const h = vi.hoisted(() => ({
  knowledgeUsage: vi.fn(),
  documents: vi.fn(),
  isAdmin: true,
}));
vi.mock("@/lib/api-client", () => ({
  api: {
    agents: { knowledgeUsage: h.knowledgeUsage },
    coverage: { documents: h.documents },
  },
}));
vi.mock("@/lib/workspace-role", () => ({ useWorkspaceRole: () => ({ isAdmin: h.isAdmin }) }));
vi.mock("@/hooks/use-connections", () => ({
  useConnectionGrants: () => ({ data: { grants: [] } }),
  useConnections: () => ({
    data: { connections: [{ id: "c1", provider: "google_drive", bundleId: "product" }] },
  }),
  useToolConnections: () => ({
    data: {
      connections: [
        { id: "t1", label: "Gmail", transport: "composio", toolkitSlug: "gmail", status: "active" },
      ],
    },
  }),
}));
vi.mock("@/hooks/use-routines", () => ({
  useRoutines: () => ({ data: [{ id: "r1", outputBundleId: "reports" }] }),
}));

const support = {
  id: "a1",
  name: "Support",
  avatar: "headset",
  bundleIds: ["policies", "product"],
  webSearch: true,
  browserOff: true,
  connectionsOff: [] as string[],
  myAccess: "edit" as "use" | "edit" | "manage",
};
const research = { ...support, id: "a2", name: "Research", bundleIds: ["contracts"] };
const store = {
  agents: [support, research],
  bundles: [
    { id: "policies", name: "Policies", documentCount: 9, description: null, createdAt: 0 },
    { id: "contracts", name: "Contracts", documentCount: 18, description: null, createdAt: 0 },
    { id: "product", name: "Product", documentCount: 54, description: null, createdAt: 0 },
    { id: "reports", name: "Reports", documentCount: 31, description: null, createdAt: 0 },
  ],
  attachBundle: vi.fn(async () => true),
  detachBundle: vi.fn(),
  createBundle: vi.fn(),
  uploadToBundle: vi.fn(),
};
vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => store }));

const { Route } = await import("./_authed.agents.$agentId.knowledge");

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  return render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  support.myAccess = "edit";
  h.isAdmin = true;
  h.knowledgeUsage.mockResolvedValue({
    byBundle: { policies: { replies: 61 } },
    answers: 100,
    grounding: { covered: 58, fallback: 30, ungrounded: 12 },
    notCoveredPct: 42,
  });
  h.documents.mockResolvedValue({
    days: 30,
    documents: [
      {
        documentId: "d1",
        name: "Refund policy v3.pdf",
        bundleId: "policies",
        bundleName: "Policies",
        createdAt: Date.now() - 425 * 86_400_000,
        uses: 61,
        readBy: [],
      },
    ],
  });
});

describe("an agent's Knowledge tab", () => {
  it("lists every folder, what it reads first, with how each is used", async () => {
    renderTab();
    expect(screen.getByRole("heading", { name: "What Support reads" })).toBeInTheDocument();
    const rows = screen.getAllByRole("listitem").slice(0, 4);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining("Policies"),
      expect.stringContaining("Product"),
      expect.stringContaining("Contracts"),
      expect.stringContaining("Reports"),
    ]);
    expect(await screen.findByText("9 files · used in 61 replies this month")).toBeInTheDocument();
    expect(screen.getByText("54 files · synced from Google Drive")).toBeInTheDocument();
    expect(screen.getByText("18 files · read by Research")).toBeInTheDocument();
    expect(screen.getByText("31 files · written by routines")).toBeInTheDocument();
  });

  it("switches a folder on and off for this agent", async () => {
    renderTab();
    await userEvent.click(screen.getByRole("switch", { name: "Support reads Contracts" }));
    expect(store.attachBundle).toHaveBeenCalledWith("a1", "contracts");
    await userEvent.click(screen.getByRole("switch", { name: "Support reads Policies" }));
    expect(store.detachBundle).toHaveBeenCalledWith("a1", "policies");
  });

  it("shows somebody who may only use the agent what it reads, without the switches", () => {
    support.myAccess = "use";
    renderTab();
    expect(screen.getByRole("switch", { name: "Support reads Policies" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: /new folder/i })).not.toBeInTheDocument();
  });

  it("names what else it reaches, as the Tools switches leave it", () => {
    renderTab();
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("The web, when asked")).toBeInTheDocument();
    // The browser is switched off for this agent.
    expect(screen.queryByText("Pages in a browser")).not.toBeInTheDocument();
  });

  it("lists what is worth revisiting, and opens it", async () => {
    renderTab();
    await userEvent.click(await screen.findByRole("button", { name: "Open Refund policy v3.pdf" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Refund policy v3.pdf");
    expect(screen.getByText(/13 months · 61 replies/)).toBeInTheDocument();
  });

  it("says how much of what it was asked was not covered", async () => {
    renderTab();
    expect(
      await screen.findByRole("img", {
        name: "Support, last 30 days: 58% found a passage, 30% fell back to whole documents, 12% nothing close",
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/42% of what Support was asked/)).toBeInTheDocument();
  });

  it("points a member nowhere they cannot go", async () => {
    h.isAdmin = false;
    renderTab();
    await screen.findByText(/42% of what Support was asked/);
    expect(within(document.body).queryByRole("link", { name: "Coverage" })).not.toBeInTheDocument();
  });
});
