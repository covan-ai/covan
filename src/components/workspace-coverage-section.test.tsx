import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import type { CoverageResponse, RevisitDocument } from "@/lib/api-client";

const h = vi.hoisted(() => ({ workspace: vi.fn(), documents: vi.fn() }));

vi.mock("@/lib/api-client", () => ({
  api: { coverage: { workspace: h.workspace, documents: h.documents } },
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("@/components/document-preview-dialog", () => ({
  DocumentPreviewDialog: ({ name }: { name: string }) => <div role="dialog">{name}</div>,
}));

import { WorkspaceCoverageSection } from "./workspace-coverage-section";

const response = (patch: Partial<CoverageResponse> = {}): CoverageResponse => ({
  available: true,
  days: 30,
  totals: { answers: 100, covered: 62, fallback: 31, ungrounded: 7, unrecorded: 0 },
  agents: [
    {
      agentId: "agent-2",
      name: "Research",
      emoji: null,
      avatar: "owl",
      answers: 40,
      covered: 34,
      fallback: 5,
      ungrounded: 1,
    },
    {
      agentId: "agent-1",
      name: "Support",
      emoji: null,
      avatar: "headset",
      answers: 60,
      covered: 20,
      fallback: 36,
      ungrounded: 4,
    },
    {
      agentId: "agent-3",
      name: "Quiet",
      emoji: null,
      avatar: null,
      answers: 0,
      covered: 0,
      fallback: 0,
      ungrounded: 0,
    },
  ],
  ...patch,
});

const DOC: RevisitDocument = {
  documentId: "d1",
  name: "Refund policy v3.pdf",
  bundleId: "b1",
  bundleName: "Policies",
  createdAt: Date.now() - 425 * 86_400_000,
  uses: 61,
  readBy: [{ agentId: "agent-1", name: "Support", avatar: "headset" }],
};

function renderSection() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <WorkspaceCoverageSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  h.workspace.mockResolvedValue(response());
  h.documents.mockResolvedValue({ days: 30, documents: [DOC] });
});

describe("WorkspaceCoverageSection", () => {
  it("draws one bar per agent asked anything, most asked first, and counts the rest", async () => {
    renderSection();
    const bars = await screen.findAllByRole("img");
    expect(bars.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Support: 33% found a passage, 60% fell back to whole documents, 7% nothing close",
      "Research: 85% found a passage, 13% fell back to whole documents, 3% nothing close",
    ]);
    expect(screen.getByText("60 asked · 67% not covered")).toBeInTheDocument();
    expect(screen.getByText("40 asked · 15%")).toBeInTheDocument();
    expect(screen.getByText(/1 agent nobody asked anything/)).toBeInTheDocument();
  });

  it("names the three buckets in a legend", async () => {
    renderSection();
    await screen.findAllByRole("img");
    for (const label of ["Found a passage", "Fell back to whole documents", "Nothing close"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("points at the one agent missing more than a third, with somewhere to go", async () => {
    renderSection();
    expect(
      await screen.findByText(
        /more than half of what support is asked is not in what it was given/i,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Add documents to Support" })).toHaveAttribute(
      "href",
      "/agents/$agentId/knowledge",
    );
  });

  it("points at nobody when every agent stands on what it was given", async () => {
    h.workspace.mockResolvedValue(
      response({
        agents: [
          {
            agentId: "agent-2",
            name: "Research",
            emoji: null,
            avatar: "owl",
            answers: 40,
            covered: 34,
            fallback: 5,
            ungrounded: 1,
          },
        ],
      }),
    );
    renderSection();
    await screen.findAllByRole("img");
    expect(screen.queryByText(/is not in what it was given/i)).not.toBeInTheDocument();
  });

  it("lists the documents worth revisiting and opens one", async () => {
    const user = userEvent.setup();
    renderSection();
    const table = await screen.findByRole("table", { name: /documents worth revisiting/i });
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(
      /Refund policy v3\.pdf.*13 months.*61.*Support/,
    );
    await user.click(within(table).getByRole("button", { name: /open refund policy/i }));
    expect(screen.getByRole("dialog")).toHaveTextContent("Refund policy v3.pdf");
  });

  it("asks again for one agent and another window", async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findAllByRole("img");

    await user.click(screen.getByRole("combobox", { name: "Window" }));
    await user.click(await screen.findByRole("option", { name: "Last 7 days" }));
    await waitFor(() => expect(h.workspace).toHaveBeenCalledWith(7));

    await user.click(screen.getByRole("combobox", { name: "Agent" }));
    await user.click(await screen.findByRole("option", { name: "Support" }));
    await waitFor(() => expect(h.workspace).toHaveBeenCalledWith(7, "agent-1"));
    await waitFor(() => expect(h.documents).toHaveBeenCalledWith(7, "agent-1"));
  });

  it("says nothing was asked rather than drawing empty bars", async () => {
    h.workspace.mockResolvedValue(
      response({
        totals: { answers: 0, covered: 0, fallback: 0, ungrounded: 0, unrecorded: 0 },
        agents: [],
      }),
    );
    renderSection();
    expect(await screen.findByText(/nothing in this window/i)).toBeInTheDocument();
  });

  it("shows the title alone before the migration behind it exists", async () => {
    h.workspace.mockResolvedValue(response({ available: false }));
    renderSection();
    expect(screen.getByRole("heading", { name: "Coverage" })).toBeInTheDocument();
    await waitFor(() => expect(h.workspace).toHaveBeenCalled());
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});
