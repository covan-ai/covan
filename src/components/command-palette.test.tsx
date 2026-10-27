import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/lib/api-client", () => ({
  api: { search: { messages: vi.fn().mockResolvedValue([]) } },
}));
vi.mock("@/hooks/use-inbox", () => ({
  useInboxCounts: () => ({ data: { unread: 3, needsYou: 3, running: 1, byAgent: {} } }),
}));
vi.mock("@/components/feedback-dialog", () => ({ FeedbackDialog: () => null }));
const startSession = vi.fn().mockResolvedValue({ id: "s9" });
vi.mock("@/lib/agents-store", () => ({
  useAgentsStore: () => ({
    agents: [
      { id: "a1", name: "Support", avatar: "headset" },
      { id: "a3", name: "Research", avatar: "owl" },
    ],
    sessions: [{ id: "s6", agentId: "a3", title: "Weekly competitor brief", state: "running" }],
    favorites: [],
    canWrite: true,
    startSession,
    startBrainstorm: vi.fn(),
  }),
}));

const { CommandPalette } = await import("./command-palette");

function open() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CommandPalette />
    </QueryClientProvider>,
  );
  act(() => {
    window.dispatchEvent(new Event("open-command-palette"));
  });
}

beforeEach(() => {
  navigate.mockReset();
  startSession.mockClear();
});

describe("the ⌘K palette", () => {
  it("lists agents — what is running, or to start a thread — then pages with their keys", () => {
    open();
    expect(screen.getByText("Running · Weekly competitor brief")).toBeInTheDocument();
    expect(screen.getByText("Start a thread")).toBeInTheDocument();
    expect(screen.getByText("3 need you")).toBeInTheDocument();
    expect(screen.getByText("G I")).toBeInTheDocument();
    expect(screen.getByText("New thread")).toBeInTheDocument();
  });

  it("keeps only the commands after a >", () => {
    open();
    fireEvent.change(screen.getByPlaceholderText(/type a command/), { target: { value: ">inv" } });
    expect(screen.queryByText("Support")).not.toBeInTheDocument();
    expect(screen.queryByText("Inbox")).not.toBeInTheDocument();
    expect(screen.getByText("Invite a member")).toBeInTheDocument();
  });

  it("goes to the use cases as a page", () => {
    open();
    fireEvent.click(screen.getByText("Use cases"));
    expect(navigate).toHaveBeenCalledWith({ to: "/routines/use-cases" });
  });

  it("opens the running thread of a working agent, and starts one for an idle agent", async () => {
    open();
    fireEvent.click(screen.getByText("Research"));
    expect(navigate).toHaveBeenCalledWith({
      to: "/agents/$agentId/chat",
      params: { agentId: "a3" },
      search: { s: "s6" },
    });
    open();
    fireEvent.click(screen.getAllByText("Support")[0]!);
    await vi.waitFor(() => expect(startSession).toHaveBeenCalledWith("a1"));
  });
});
