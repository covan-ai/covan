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
vi.mock("@/lib/quota", () => ({ useQuota: () => null, quotaSentence: () => "" }));
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
    expect(row.getByText(/ask an admin or a member to create one/i)).toBeInTheDocument();
  });
});

// The other half of the same complaint: the first run ends and nothing says
// what this becomes once it is set up. Four steps, and it is gone when they
// are done.
describe("the first-week checklist", () => {
  const withAgent = (documents = 0) => {
    store.agents = [
      { id: "agent-1", name: "GTM", documents: Array.from({ length: documents }, () => ({})) },
    ];
  };

  it("appears once there is an agent, and counts what is left", async () => {
    withAgent(1);
    await renderHome(true);

    expect(screen.getByText("Getting set up")).toBeInTheDocument();
    expect(screen.getByText(/1 of 4 done/)).toBeInTheDocument();
  });

  it("stays away while the workspace has no agents at all", async () => {
    await renderHome(true);

    // That screen has one job, and the composer above is already saying it.
    expect(screen.queryByText("Getting set up")).not.toBeInTheDocument();
  });

  it("is not shown to a viewer, who is refused three of the four steps", async () => {
    withAgent(1);
    await renderHome(false);

    expect(screen.queryByText("Getting set up")).not.toBeInTheDocument();
  });

  it("disappears when all four are done rather than sitting there congratulating anybody", async () => {
    withAgent(2);
    store.sessions = [{ id: "s1", messageCount: 6 }];
    queries.me = {
      user: { id: "u1", name: "Ada" },
      workspace: { id: "w1", name: "Acme" },
      members: [{ id: "u1" }, { id: "u2" }],
    };
    queries.routines = [{ id: "r1" }];

    await renderHome(true);

    expect(screen.queryByText("Getting set up")).not.toBeInTheDocument();
  });

  it("can be put down, and stays down for that workspace", async () => {
    withAgent(1);
    await renderHome(true);

    await userEvent.click(screen.getByLabelText(/hide the setup checklist/i));
    expect(screen.queryByText("Getting set up")).not.toBeInTheDocument();

    // A second workspace is a second setup: silencing this one must not
    // silence the next.
    expect(localStorage.getItem("covan:first-week-dismissed:w1")).toBe("1");
    expect(localStorage.getItem("covan:first-week-dismissed:w2")).toBeNull();
  });
});
