import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const navigate = vi.fn();
let pathname = "/app";
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
  useRouterState: ({ select }: { select: (s: unknown) => unknown }) =>
    select({ location: { pathname } }),
}));

// Keyed by the first element of the query key, so the five queries the list
// runs can be answered one at a time. `enabled: false` returns nothing.
const queries: Record<string, unknown> = {};
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey, enabled }: { queryKey: string[]; enabled?: boolean }) => ({
    data: enabled === false ? undefined : queries[queryKey[0]],
  }),
}));
vi.mock("@/lib/api-client", () => ({
  api: {
    me: vi.fn(),
    routines: { list: vi.fn() },
    toolConnections: { list: vi.fn() },
    connections: { list: vi.fn() },
    slack: { get: vi.fn() },
  },
}));

const store = { agents: [] as unknown[], sessions: [] as unknown[], canWrite: true };
vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => store }));

let hosted: boolean | undefined = false;
vi.mock("@/lib/credits", () => ({ useIsHosted: () => hosted }));

const openCoachMark = vi.fn();
vi.mock("@/lib/coach-marks", () => ({
  openCoachMark: (...args: unknown[]) => openCoachMark(...args),
}));

import { SetupList } from "./setup-list";

function me(over: Record<string, unknown> = {}) {
  return {
    user: { id: "u1", name: "Ada" },
    workspace: { id: "w1", name: "Acme" },
    members: [{ id: "u1" }],
    onboarding: {
      completed: true,
      lastStep: "done",
      agentId: "agent-1",
      sessionId: "session-1",
      answers: { tools: ["gmail", "notion"], mode: "team" },
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  pathname = "/app";
  hosted = false;
  store.agents = [{ id: "agent-1", documents: [] }];
  store.sessions = [];
  store.canWrite = true;
  queries.me = me();
  queries.routines = [];
  queries["tool-connections"] = { connections: [] };
  queries.connections = { connections: [] };
  queries.slack = { installation: null };
});

describe("SetupList", () => {
  it("lists the five steps with the first tool named, and counts what is done", () => {
    store.sessions = [{ id: "s1", messageCount: 2 }];
    render(<SetupList onNavigate={vi.fn()} />);

    expect(screen.getByText("Setup · 1 of 5")).toBeInTheDocument();
    expect(screen.getByText("Ask your first question")).toBeInTheDocument();
    expect(screen.getByText("Connect Gmail")).toBeInTheDocument();
    expect(screen.getByText("Add a document")).toBeInTheDocument();
    expect(screen.getByText("Invite a teammate")).toBeInTheDocument();
    expect(screen.getByText("Schedule a routine")).toBeInTheDocument();
    // The done one has no Try.
    expect(screen.queryByRole("button", { name: /try: ask your first/i })).not.toBeInTheDocument();
  });

  it("asks a solo person to share rather than to invite", () => {
    queries.me = me({
      onboarding: {
        completed: true,
        agentId: "agent-1",
        sessionId: "s",
        answers: { tools: [], mode: "solo" },
      },
    });
    render(<SetupList onNavigate={vi.fn()} />);
    expect(screen.getByText("Share the assistant")).toBeInTheDocument();
    expect(screen.getByText("Connect an app")).toBeInTheDocument();
  });

  it("stays away from a viewer, from a workspace with no agents, and once everything is done", () => {
    store.canWrite = false;
    const { rerender, container } = render(<SetupList onNavigate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();

    store.canWrite = true;
    store.agents = [];
    rerender(<SetupList onNavigate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();

    store.agents = [{ id: "agent-1", documents: [{}] }];
    store.sessions = [{ id: "s1", messageCount: 2 }];
    queries.me = me({ members: [{ id: "u1" }, { id: "u2" }] });
    queries.routines = [{ id: "r1" }];
    queries["tool-connections"] = {
      connections: [
        { transport: "composio", status: "active", toolkitSlug: "gmail", label: "", logoPath: "" },
      ],
    };
    rerender(<SetupList onNavigate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  // Their own workspace ids: both flags are remembered in this tab past the
  // storage clear (private mode is survivable that way), and a shared id
  // would carry one test's answer into the next.
  it("can be put down for the workspace", async () => {
    queries.me = me({ workspace: { id: "w-down", name: "Acme" } });
    render(<SetupList onNavigate={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /hide this list/i }));
    expect(localStorage.getItem("covan:first-week-dismissed:w-down")).toBe("1");
  });

  it("folds and remembers it", async () => {
    queries.me = me({ workspace: { id: "w-fold", name: "Acme" } });
    render(<SetupList onNavigate={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /setup · 0 of 5/i }));
    expect(localStorage.getItem("covan:setup-open:w-fold")).toBe("0");
  });

  it("promises credits for the rewarded step only on a hosted install", () => {
    const { rerender } = render(<SetupList onNavigate={vi.fn()} />);
    expect(screen.queryByText("Earns credits")).not.toBeInTheDocument();

    hosted = true;
    rerender(<SetupList onNavigate={vi.fn()} />);
    expect(screen.getByText("Earns credits")).toBeInTheDocument();
  });

  it("goes to the page and points at the control on Try", async () => {
    const onNavigate = vi.fn();
    render(<SetupList onNavigate={onNavigate} />);

    await userEvent.click(screen.getByRole("button", { name: /try: schedule a routine/i }));

    expect(onNavigate).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: "/agents/$agentId/routines", params: { agentId: "agent-1" } }),
    );
    expect(openCoachMark).toHaveBeenCalledWith(
      expect.objectContaining({ id: "new-routine" }),
      expect.anything(),
    );
  });

  it("does not navigate when already on the page", async () => {
    pathname = "/settings/integrations";
    render(<SetupList onNavigate={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /try: connect gmail/i }));

    expect(navigate).not.toHaveBeenCalled();
    expect(openCoachMark).toHaveBeenCalledWith(
      expect.objectContaining({ id: "integrations-catalogue" }),
      expect.anything(),
    );
  });
});
