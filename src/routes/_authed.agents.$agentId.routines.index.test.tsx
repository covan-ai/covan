import { beforeAll, beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type React from "react";

/**
 * The tab's own wiring of `?template=` onto its two `<CreateRoutineDialog>`
 * mounts — not the dialog's effect, which create-routine-dialog.test.tsx
 * already covers. This is about which mount(s) the tab hands the request to.
 *
 * `PageHeader` renders its action unconditionally, and `RoutinesList`
 * renders its own inside the empty-state branch — so with zero routines and
 * `isLoading` false, both <CreateRoutineDialog> instances are mounted at
 * once. The dialog is mocked to a stub that renders a marker only when it
 * receives `openTemplate`, so the test can tell "one mount got the request"
 * from "both did" without pulling in the real dialog's channels, connections
 * and agents-store dependencies.
 */

let search: { template?: string } = {};

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useParams: () => ({ agentId: "agent-1" }),
    useSearch: () => search,
  }),
  useNavigate: () => vi.fn(),
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}));

vi.mock("@/lib/api-client", () => ({
  api: { me: vi.fn().mockResolvedValue({ user: { id: "u1" }, members: [] }) },
}));

const routinesResult = vi.fn();
vi.mock("@/hooks/use-routines", () => ({ useRoutines: () => routinesResult() }));

vi.mock("@/components/routines/create-routine-dialog", () => ({
  CreateRoutineDialog: ({ openTemplate }: { agentId: string; openTemplate?: string }) =>
    openTemplate ? <div data-testid="template-dialog-open" /> : null,
}));

// Imported once rather than per test — same reasoning as the other route
// test files: the mocks above are hoisted, so the module is safe to pull in
// from a hook, and importing it fresh per test just pays the cost repeatedly.
let Component: () => React.ReactElement;

beforeAll(async () => {
  const { Route } = await import("./_authed.agents.$agentId.routines.index");
  Component = (Route as unknown as { component: () => React.ReactElement }).component;
});

function renderTab() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Component />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  search = {};
  routinesResult.mockReset().mockReturnValue({ data: [], isLoading: false });
});

describe("the routines tab's own ?template= wiring", () => {
  // Review Focus: a deep link that opens on a template must reach exactly one
  // of the tab's two dialog mounts. Reaching both means following the link
  // opens two stacked, identically pre-filled dialogs — submit each without
  // noticing the duplicate and the same routine gets created twice.
  it("hands the template request to exactly one mounted dialog when the agent has no routines yet", () => {
    search = { template: "first-week" };
    renderTab();

    expect(screen.getAllByTestId("template-dialog-open")).toHaveLength(1);
  });

  it("does nothing special with no template named", () => {
    renderTab();

    expect(screen.queryByTestId("template-dialog-open")).not.toBeInTheDocument();
  });
});
