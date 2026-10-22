import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";
import type { ThreadRow } from "@/lib/api-client";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));

const table = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    sessions: {
      table: (...a: unknown[]) => table(...a),
      setVisibility: vi.fn(),
      remove: vi.fn(),
      rename: vi.fn(),
    },
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock("@/lib/agents-store", () => ({
  useAgentsStore: () => ({
    agents: [
      { id: "a1", name: "Support", avatar: "headset" },
      { id: "a2", name: "Research", avatar: null },
    ],
  }),
}));

const { ThreadsTable } = await import("./threads-table");

const row = (over: Partial<ThreadRow>): ThreadRow => ({
  id: "s1",
  agentId: "a1",
  title: "Refund policy for EU orders",
  kind: "chat",
  visibility: "private",
  ownerId: "u1",
  ownerName: "Mina Kaya",
  ownerAvatarUrl: null,
  isMine: true,
  routine: null,
  state: "needs_you",
  runningStep: null,
  unread: 0,
  lastActivityAt: Date.now() - 12 * 60 * 1000,
  createdAt: Date.now(),
  cost: 14,
  ...over,
});

function renderTable(ui: React.ReactElement) {
  return render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  table.mockReset().mockResolvedValue({
    rows: [
      row({}),
      row({
        id: "s2",
        agentId: "a2",
        title: "Weekly competitor brief",
        routine: { id: "r1", name: "Weekly competitor brief" },
        state: "running",
        runningStep: 3,
        isMine: false,
        cost: 18,
      }),
    ],
    total: 312,
    thisWeek: 48,
    allTime: 312,
    page: 1,
    pageSize: 25,
    unit: "credits",
  });
});

describe("the threads table", () => {
  it("shows each thread's agent, owner, state and cost, and says how many there are", async () => {
    renderTable(<ThreadsTable />);
    expect(await screen.findByText("Refund policy for EU orders")).toBeInTheDocument();
    expect(screen.getByText("Needs you")).toBeInTheDocument();
    expect(screen.getByText("Running · step 3")).toBeInTheDocument();
    expect(screen.getByText("Routine")).toBeInTheDocument();
    expect(screen.getByText("Credits")).toBeInTheDocument();
    expect(screen.getByText("Showing 2 of 312")).toBeInTheDocument();
  });

  it("asks again for a filter, and opens a thread from its row", async () => {
    renderTable(<ThreadsTable />);
    fireEvent.click(await screen.findByRole("button", { name: "Waiting" }));
    await waitFor(() =>
      expect(table).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: "waiting", page: 1 }),
      ),
    );
    fireEvent.click(screen.getByText("Weekly competitor brief"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/agents/$agentId/chat",
      params: { agentId: "a2" },
      search: { s: "s2" },
    });
  });

  it("drops the agent column and select inside one agent", async () => {
    renderTable(<ThreadsTable agentId="a1" />);
    await screen.findByText("Refund policy for EU orders");
    expect(screen.queryByText("Agent")).not.toBeInTheDocument();
    expect(table).toHaveBeenCalledWith(expect.objectContaining({ agentId: "a1" }));
  });
});
