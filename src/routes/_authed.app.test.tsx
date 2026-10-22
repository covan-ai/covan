import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { HomeOverview } from "@/lib/api-client";

const navigate = vi.fn();
let search: { new?: boolean } = {};
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useSearch: () => search,
  }),
  useNavigate: () => navigate,
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

const queries: Record<string, unknown> = {};
const refetch = vi.fn();
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queries[queryKey.join("/")],
    dataUpdatedAt: Date.now(),
    isError: false,
    refetch,
  }),
}));
vi.mock("@/lib/api-client", () => ({ api: { me: vi.fn(), home: { overview: vi.fn() } } }));

const role = { isAdmin: true };
vi.mock("@/lib/workspace-role", () => ({
  useWorkspaceRole: () => ({ me: queries.me, isAdmin: role.isAdmin, canWrite: true }),
}));

const openCreateAgent = vi.fn();
vi.mock("@/lib/shell", () => ({ useShell: () => ({ openCreateAgent }) }));

// Each piece is tested where it lives; here they only have to be in place.
vi.mock("@/components/ask-bar", () => ({
  AskBar: ({ selected }: { selected: { name: string } }) => (
    <div data-testid="ask-bar">{selected.name}</div>
  ),
}));
vi.mock("@/components/getting-started", () => ({
  GettingStarted: () => null,
  FirstSteps: () => <section aria-label="Getting started" />,
}));
vi.mock("@/components/coverage-notice", () => ({ CoverageNotice: () => null }));
vi.mock("@/components/new-thread-button", () => ({
  NewThreadButton: () => <button type="button">New thread</button>,
}));

const store = {
  agents: [] as unknown[],
  favorites: [] as string[],
  canWrite: true,
};
vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => store }));

async function renderHome() {
  const { Route } = await import("./_authed.app");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  return render(<Component />);
}

const DAY = 86_400_000;

function overview(over: Partial<HomeOverview> = {}): HomeOverview {
  const now = Date.now();
  return {
    user: { name: "Mina Kaya", timezone: null },
    workspace: { name: "Acme" },
    isAdmin: true,
    needsYou: { total: 3, questions: 2, approvals: 1, other: 0 },
    threads: { window: 48, previous: 36 },
    routineRuns: { total: 14, done: 13, failed: 1 },
    credits: { balance: 1240 },
    spend: {
      unit: "credits",
      window: 612,
      previousWindow: 500,
      daily: Array.from({ length: 14 }, (_, i) => ({
        day: new Date(now - (13 - i) * DAY).toISOString().slice(0, 10),
        total: 80,
        byAgent: { a1: 50, a2: 30 },
      })),
      byAgent: [
        { agentId: "a1", amount: 350 },
        { agentId: "a2", amount: 262 },
      ],
    },
    agents: [
      {
        agentId: "a1",
        name: "Research",
        avatar: "owl",
        status: "running",
        workingOn: {
          sessionId: "s1",
          title: "Weekly competitor brief",
          kind: "running",
          stepsDone: 3,
          note: "reading 6 pages",
          since: now - 60_000,
        },
        threadsWindow: 11,
        spendWindow: 350,
      },
      {
        agentId: "a2",
        name: "Support",
        avatar: "headset",
        status: "needs_you",
        workingOn: {
          sessionId: "s2",
          title: "Refund policy for EU orders",
          kind: "question",
          since: now - 12 * 60_000,
        },
        threadsWindow: 19,
        spendWindow: 262,
      },
    ],
    team: [
      { userId: "u1", name: "Mina Kaya", avatarUrl: null, threads: 14 },
      { userId: "u2", name: "Deniz Arslan", avatarUrl: null, threads: 12 },
    ],
    activity: [
      {
        id: "e1",
        action: "turn.approved",
        actor: { kind: "person", id: "u2", name: "Deniz Arslan", avatar: null },
        subjectType: "session",
        subjectId: "s9",
        subjectLabel: "Pipeline snapshot",
        count: 1,
        detail: { agent_id: "a2" },
        createdAt: now - 3_600_000,
      },
    ],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  search = {};
  role.isAdmin = true;
  store.canWrite = true;
  store.agents = [
    { id: "a1", name: "Research", avatar: "owl" },
    { id: "a2", name: "Support", avatar: "headset" },
  ];
  store.favorites = ["a2"];
  queries.me = {
    user: { id: "u1", name: "Mina Kaya" },
    workspace: { id: "w1", name: "Acme" },
    members: [{ id: "u1" }, { id: "u2" }],
  };
  queries["home/overview"] = overview();
});

describe("Home, for an admin with a working week", () => {
  it("greets, says the week in a sentence, and asks the pinned agent", async () => {
    await renderHome();
    expect(
      screen.getByRole("heading", { level: 2, name: /^Good (morning|afternoon|evening), Mina\.$/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /Three things need you, Research is working on Weekly competitor brief, and the team has spent 612 credits in the last seven days\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId("ask-bar")).toHaveTextContent("Support");
  });

  it("shows the four figures, the chart and spend by agent", async () => {
    await renderHome();
    expect(
      screen.getByRole("link", { name: /needs you\s*3\s*2 questions, 1 approval/i }),
    ).toHaveAttribute("href", "/inbox");
    expect(screen.getByText("+12 vs the week before")).toBeInTheDocument();
    expect(screen.getByText("1,240 left")).toBeInTheDocument();
    expect(screen.getByText("13 done, 1 failed")).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Credits spent per day" })).toBeInTheDocument();
    const spend = screen.getByRole("list", { name: "Spend by agent, last 7 days" });
    expect(
      within(spend)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Research350", "Support262"]);
  });

  it("says what each agent is doing right now", async () => {
    await renderHome();
    const table = screen.getByRole("table", { name: "What each agent is doing" });
    expect(within(table).getByText("Running")).toBeInTheDocument();
    expect(within(table).getByText("Needs you")).toBeInTheDocument();
    expect(within(table).getByText(/step 3, reading 6 pages/)).toBeInTheDocument();
    expect(within(table).getByText(/asked you a question 12 min ago/)).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Credits, 7 d" })).toBeInTheDocument();
  });

  it("shows the team's week and the recent activity", async () => {
    await renderHome();
    const team = screen.getByRole("list", { name: /threads started by each member/i });
    expect(
      within(team)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["MKYou14", "DADeniz12"]);
    const feed = screen.getByRole("link", { name: "Pipeline snapshot" }).closest("li")!;
    expect(feed).toHaveTextContent(/^DADeniz approved Pipeline snapshot1 h ago$/);
  });

  it("offers Invite to an admin only", async () => {
    const { unmount } = await renderHome();
    expect(screen.getByRole("link", { name: "Invite" })).toHaveAttribute("href", "/team");
    unmount();
    role.isAdmin = false;
    await renderHome();
    expect(screen.queryByRole("link", { name: "Invite" })).not.toBeInTheDocument();
  });
});

describe("Home, for a member", () => {
  it("leaves out money and people when the overview does", async () => {
    queries["home/overview"] = overview({ spend: undefined, team: undefined, isAdmin: false });
    await renderHome();
    expect(screen.queryByRole("table", { name: /per day/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Spend by agent")).not.toBeInTheDocument();
    expect(screen.queryByText("Team, last 7 days")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Credits, 7 d" })).not.toBeInTheDocument();
    // Hosted, the balance is still everybody's to see.
    expect(screen.getByText("Credits left")).toBeInTheDocument();
    expect(
      screen.getByText(
        /Three things need you, and Research is working on Weekly competitor brief\./,
      ),
    ).toBeInTheDocument();
  });

  it("leaves out credits entirely on a self-hosted install", async () => {
    queries["home/overview"] = overview({ spend: undefined, team: undefined, credits: undefined });
    await renderHome();
    expect(screen.queryByText(/credits/i)).not.toBeInTheDocument();
  });

  it("gives a viewer the read-only notice where the ask bar would be", async () => {
    store.canWrite = false;
    await renderHome();
    expect(screen.queryByTestId("ask-bar")).not.toBeInTheDocument();
    expect(screen.getByText("You can read Acme, not change it")).toBeInTheDocument();
  });
});

describe("Home, in a workspace with no agents (A24)", () => {
  beforeEach(() => {
    store.agents = [];
    queries["home/overview"] = overview({ agents: [], spend: undefined, team: undefined });
  });

  it("welcomes them and offers the first agent", async () => {
    await renderHome();
    expect(screen.getByRole("heading", { name: "Welcome to Acme, Mina." })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create agent" }));
    expect(openCreateAgent).toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Getting started" })).toBeInTheDocument();
    expect(screen.queryByText("Right now")).not.toBeInTheDocument();
  });

  it("tells a viewer who to ask instead", async () => {
    store.canWrite = false;
    await renderHome();
    expect(screen.queryByRole("button", { name: "Create agent" })).not.toBeInTheDocument();
    expect(screen.getByText(/Nothing is shared with you yet/)).toBeInTheDocument();
  });
});

describe("?new=true", () => {
  it("opens the shell's Create agent dialog and takes the request out of the address", async () => {
    search = { new: true };
    await renderHome();
    expect(openCreateAgent).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ to: "/app", search: {}, replace: true });
  });
});
