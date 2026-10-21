import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";

const navigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useSearch: () => ({}),
  }),
  useNavigate: () => navigate,
  Link: ({ children, ...props }: { children: React.ReactNode; to: string }) => (
    <a href={props.to}>{children}</a>
  ),
}));

// Keyed rather than blanket-undefined, because the checklist's visibility is
// decided by three separate queries and a test that cannot tell them apart
// cannot test it. `enabled: false` returns nothing, the same as the real thing.
const queries: Record<string, unknown> = {};

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: string[]; enabled?: boolean }) => ({
    data: enabled === false ? undefined : queries[queryKey[0]],
  }),
}));
vi.mock("@/lib/api-client", () => ({ api: { me: vi.fn(), routines: { list: vi.fn() } } }));
vi.mock("@/lib/credits", () => ({ useCredits: () => null, creditsSentence: () => "" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Stands in for the real dialog so the test can tell "it opened" from "it
// didn't" without rendering a form the assertion isn't about.
vi.mock("@/components/create-agent-dialog", () => ({
  CreateAgentDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="create-dialog" /> : null,
}));

const store = {
  agents: [] as unknown[],
  favorites: [] as string[],
  sessions: [] as unknown[],
  canWrite: true,
  startSession: vi.fn(),
};

vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => store }));

async function renderHome(canWrite: boolean) {
  store.canWrite = canWrite;
  const { Route } = await import("./_authed.app");
  const Component = (Route as unknown as { component: () => React.ReactElement }).component;
  render(<Component />);
}

beforeEach(() => {
  navigate.mockClear();
  localStorage.clear();
  store.agents = [];
  store.sessions = [];
  queries.me = {
    user: { id: "u1", name: "Ada" },
    workspace: { id: "w1", name: "Acme" },
    members: [{ id: "u1" }],
  };
  queries.routines = [];
});

/** An agent as the gallery reads one, made by the person signed in and shared with nobody. */
function agentNamed(name: string, sharing: Record<string, unknown> = {}) {
  return {
    id: `agent-${name}`,
    name,
    emoji: "🤖",
    model: "gpt-4o",
    persona: "",
    documents: [] as unknown[],
    createdBy: "u1",
    workspaceAccess: null,
    shares: [],
    myAccess: "manage",
    ...sharing,
  };
}

// The composer owns the fold. With no agents in the workspace it was a closed
// door: a disabled textarea, a disabled send button, and the inert words "No
// agents yet" where the agent picker goes. The only real Create agent button
// was in the gallery, far below. So the first screen a new workspace sees
// described the problem and offered nothing to do about it.
describe("the home composer, with no agents in the workspace", () => {
  // Scoped to the composer's own footer rather than the page, because the
  // gallery below renders two Create agent buttons of its own when the
  // workspace is empty — a page-wide query passes with the bug still in place.
  // Send is the anchor: the assertion is that the row holding it also holds a
  // way out.
  const composerRow = () => within(screen.getByLabelText("Send").closest("div")!);

  it("gives a member a way to create one without scrolling", async () => {
    await renderHome(true);

    const create = composerRow().getByRole("button", { name: /create agent/i });

    expect(screen.queryByTestId("create-dialog")).not.toBeInTheDocument();
    await userEvent.click(create);
    expect(screen.getByTestId("create-dialog")).toBeInTheDocument();
  });

  it("tells a viewer who to ask instead of offering a button the policies would refuse", async () => {
    await renderHome(false);

    const row = composerRow();
    expect(row.queryByRole("button", { name: /create agent/i })).not.toBeInTheDocument();
    expect(row.getByText(/ask an admin or a member to share one with you/i)).toBeInTheDocument();
  });
});

// The setup checklist used to sit under the composer. It lives in the sidebar
// now (`setup-list.tsx`, tested there), where it is reachable from every page
// rather than from this one.
describe("the home page without the checklist", () => {
  it("draws no setup card under the composer", async () => {
    store.agents = [{ ...agentNamed("GTM"), documents: [] }];
    await renderHome(true);

    expect(screen.queryByText(/getting set up/i)).not.toBeInTheDocument();
  });
});

// The foot of each card used to say "Shared with 4" for every agent, which
// stopped being true when an agent's owner started choosing (0104).
describe("who an agent card says it is shared with", () => {
  beforeEach(() => {
    queries.me = {
      user: { id: "u1", name: "Ada" },
      workspace: { id: "w1", name: "Acme" },
      members: [
        { id: "u1", name: "Ada" },
        { id: "u2", name: "Grace Hopper", avatarUrl: null },
        { id: "u3", name: "Alan Turing", avatarUrl: null },
      ],
    };
  });

  it("says Only you for an agent nobody else can reach", async () => {
    store.agents = [agentNamed("Solo")];
    await renderHome(true);

    expect(screen.getByText("Only you")).toBeInTheDocument();
  });

  it("says Everyone for an agent shared with the workspace", async () => {
    store.agents = [agentNamed("Team", { workspaceAccess: "edit" })];
    await renderHome(true);

    expect(screen.getByText("Everyone")).toBeInTheDocument();
  });

  it("counts, and shows, the people it is shared with by name", async () => {
    store.agents = [
      agentNamed("Pair", {
        shares: [
          { userId: "u2", access: "use" },
          { userId: "u3", access: "edit" },
        ],
      }),
    ];
    await renderHome(true);

    expect(screen.getByText("2 people")).toBeInTheDocument();
    // Monograms, because neither has a photo: the faces are the point.
    expect(screen.getByText("GH")).toBeInTheDocument();
    expect(screen.getByText("AT")).toBeInTheDocument();
  });
});
