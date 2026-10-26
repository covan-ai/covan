import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type React from "react";

let search: { template?: string } = {};
const navigated: Array<Record<string, unknown>> = [];

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useParams: () => ({ agentId: "agent-1" }),
    useSearch: () => search,
  }),
  Navigate: (props: Record<string, unknown>) => {
    navigated.push(props);
    return null;
  },
  Link: ({
    children,
    to,
    search,
  }: {
    children: React.ReactNode;
    to: string;
    search?: Record<string, string>;
  }) => <a href={search ? `${to}?${new URLSearchParams(search)}` : to}>{children}</a>,
}));

const routinesResult = vi.fn();
vi.mock("@/hooks/use-routines", () => ({ useRoutines: () => routinesResult() }));
vi.mock("@/lib/agents-store", () => ({ useAgentsStore: () => ({ canWrite: true }) }));
vi.mock("@/components/routines/routines-pane", () => ({
  RoutinesPane: () => <section aria-label="Routines list" />,
}));

const { Route } = await import("./_authed.agents.$agentId.routines.index");
const Tab = (Route as unknown as { component: () => React.ReactElement }).component;

beforeEach(() => {
  search = {};
  navigated.length = 0;
});

describe("an agent's Routines tab", () => {
  it("opens the agent's first routine beside its list", () => {
    routinesResult.mockReturnValue({
      data: [
        { id: "r-other", agentId: "agent-2" },
        { id: "r1", agentId: "agent-1" },
      ],
      isLoading: false,
    });
    render(<Tab />);
    expect(navigated[0]).toMatchObject({
      to: "/agents/$agentId/routines/$routineId",
      params: { agentId: "agent-1", routineId: "r1" },
      replace: true,
    });
  });

  it("says what a routine is for when the agent has none, and offers the use cases first", () => {
    routinesResult.mockReturnValue({ data: [], isLoading: false });
    render(<Tab />);
    expect(screen.getByText("No routines yet")).toBeInTheDocument();
    const links = screen.getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Browse use cases", "New routine"]);
    expect(links[0]).toHaveAttribute("href", "/routines/use-cases?agent=agent-1");
    expect(links[1]).toHaveAttribute("href", "/routines/new?agent=agent-1");
  });

  // An old `?template=` link still lands somewhere: the editor, on it.
  it("hands a template link to the editor", () => {
    search = { template: "weekly-digest" };
    routinesResult.mockReturnValue({ data: [], isLoading: false });
    render(<Tab />);
    expect(navigated[0]).toMatchObject({
      to: "/routines/new",
      search: { agent: "agent-1", template: "weekly-digest" },
    });
  });
});
