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
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: undefined }) }));
vi.mock("@/lib/api-client", () => ({ api: { me: vi.fn() } }));
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
