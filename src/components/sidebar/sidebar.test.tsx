import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type React from "react";

let pathname = "/app";
let search: Record<string, string> = {};
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children: React.ReactNode; to: string }) => (
    <a href={to} {...(rest as object)}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname, search } }),
}));

const queries: Record<string, unknown> = {};
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({ data: queries[queryKey[0]!] }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("@/hooks/use-inbox", () => ({
  useInboxCounts: () => ({
    data: {
      unread: 3,
      needsYou: 1,
      running: 1,
      byAgent: { a2: { unread: 0, needsYou: 0, running: 1 } },
    },
  }),
}));
let credits: unknown = null;
vi.mock("@/lib/credits", () => ({ useCredits: () => credits }));
vi.mock("@/lib/api-client", () => ({ api: {}, ApiError: class extends Error {} }));
vi.mock("@/lib/supabase/client", () => ({ supabase: { auth: { signOut: vi.fn() } } }));
vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ preference: "system", mounted: true, setPreference: vi.fn() }),
}));

const store = {
  agents: [
    { id: "a1", name: "Support", avatar: "headset" },
    { id: "a2", name: "Research", avatar: "owl" },
    { id: "a3", name: "Finance", avatar: "bear" },
  ],
  favorites: ["a3"],
  canWrite: true,
  sessions: [
    {
      id: "s1",
      agentId: "a1",
      title: "Refund policy for EU orders",
      updatedAt: 2,
      state: "needs_you",
      ownerId: "u1",
      visibility: "private",
      kind: "chat",
    },
  ],
  startSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
};
vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => store }));

const { Sidebar } = await import("./sidebar");

beforeEach(() => {
  pathname = "/app";
  search = {};
  credits = null;
  store.canWrite = true;
  queries.me = {
    user: { id: "u1", name: "Mina Kaya", email: "mina@acme.test" },
    workspace: { id: "w1", name: "Acme" },
  };
  queries.workspaces = [{ id: "w1", name: "Acme" }];
});

describe("the sidebar", () => {
  it("lists the six pages with the Inbox's unread count, and marks where you are", () => {
    render(<Sidebar />);
    const pages = screen.getByRole("navigation", { name: "Workspace" });
    expect(
      within(pages)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Home", "Inbox3", "Threads", "Knowledge", "Routines", "Team"]);
    expect(within(pages).getByRole("link", { name: "Home" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("puts pinned agents first, shows a running dot, and opens the agent you are in", () => {
    pathname = "/agents/a1/chat";
    search = { s: "s1" };
    render(<Sidebar agentId="a1" />);
    const agents = screen.getByRole("navigation", { name: "Agents" });
    const names = within(agents)
      .getAllByRole("link")
      .filter((a) => a.hasAttribute("aria-expanded"))
      .map((a) => a.textContent);
    expect(names).toEqual(["Finance", "Support", "Research"]);
    expect(screen.getByRole("img", { name: "Research is working" })).toBeInTheDocument();
    expect(within(agents).getByText("Refund policy for EU orders")).toBeInTheDocument();
    expect(within(agents).getByRole("button", { name: "New thread" })).toBeInTheDocument();
    expect(within(agents).getByText("All threads")).toBeInTheDocument();
  });

  it("offers a new agent only to somebody who can make one, and credits only where they exist", () => {
    store.canWrite = false;
    render(<Sidebar />);
    expect(screen.queryByRole("button", { name: "New agent" })).not.toBeInTheDocument();
    expect(screen.queryByText(/credits/)).not.toBeInTheDocument();
  });

  it("shows the balance and its bar on a hosted workspace", () => {
    credits = { balance: 1240, ratio: 0.62, level: "fine" };
    render(<Sidebar />);
    expect(screen.getByText("1,240 credits")).toBeInTheDocument();
    expect(screen.getByText("Buy more")).toBeInTheDocument();
  });
});
