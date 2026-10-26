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

import { FirstSteps, GettingStarted } from "./getting-started";

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

describe("GettingStarted", () => {
  it("lists the five steps with the first tool named, and counts what is done", () => {
    store.sessions = [{ id: "s1", messageCount: 2 }];
    render(<GettingStarted />);

    expect(screen.getByText("Getting started · 1 of 5")).toBeInTheDocument();
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
    render(<GettingStarted />);
    expect(screen.getByText("Share the assistant")).toBeInTheDocument();
    expect(screen.getByText("Connect an app")).toBeInTheDocument();
  });

  it("stays away from a viewer, from a workspace with no agents, and once everything is done", () => {
    store.canWrite = false;
    const { rerender, container } = render(<GettingStarted />);
    expect(container).toBeEmptyDOMElement();

    store.canWrite = true;
    store.agents = [];
    rerender(<GettingStarted />);
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
    rerender(<GettingStarted />);
    expect(container).toBeEmptyDOMElement();
  });

  // Its own workspace id: the flag is remembered in this tab past the storage
  // clear (private mode is survivable that way), and a shared id would carry
  // one test's answer into the next.
  it("can be put down for the workspace", async () => {
    queries.me = me({ workspace: { id: "w-down", name: "Acme" } });
    render(<GettingStarted />);
    await userEvent.click(screen.getByRole("button", { name: /hide this list/i }));
    expect(localStorage.getItem("covan:first-week-dismissed:w-down")).toBe("1");
  });

  it("promises credits for the rewarded step only on a hosted install", () => {
    const { rerender } = render(<GettingStarted />);
    expect(screen.queryByText("earns 200 credits")).not.toBeInTheDocument();

    hosted = true;
    rerender(<GettingStarted />);
    expect(screen.getByText("earns 200 credits")).toBeInTheDocument();
  });

  it("goes to the page and points at the control on Try", async () => {
    render(<GettingStarted />);

    await userEvent.click(screen.getByRole("button", { name: /try: schedule a routine/i }));

    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ to: "/routines/use-cases" }));
    expect(openCoachMark).toHaveBeenCalledWith(
      expect.objectContaining({ id: "use-case-card" }),
      expect.objectContaining({ position: { step: 5, total: 5 } }),
    );
  });

  it("does not navigate when already on the page", async () => {
    pathname = "/settings/integrations";
    render(<GettingStarted />);

    await userEvent.click(screen.getByRole("button", { name: /try: connect gmail/i }));

    expect(navigate).not.toHaveBeenCalled();
    expect(openCoachMark).toHaveBeenCalledWith(
      expect.objectContaining({ id: "integrations-catalogue" }),
      expect.anything(),
    );
  });
});

describe("FirstSteps (A24)", () => {
  it("shows the workspace as done and the team as done once somebody joined", () => {
    const { rerender } = render(<FirstSteps memberCount={1} />);
    const items = () => screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items()).toEqual([
      "Create the workspace (done)",
      "Create an agent",
      "Add the first documents to Knowledge",
      "Invite the team",
    ]);

    hosted = true;
    rerender(<FirstSteps memberCount={2} />);
    expect(items()).toEqual([
      "Create the workspace (done)",
      "Create an agent",
      "Add the first documents to Knowledgeearns 200 credits",
      "Invite the team (done)",
    ]);
  });
});
