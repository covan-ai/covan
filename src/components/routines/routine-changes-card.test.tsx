import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ToolConnection, ToolConnectionGrant } from "@/lib/connections-api";

const { setGrant, removeGrant } = vi.hoisted(() => ({
  setGrant: { mutate: vi.fn(), isPending: false },
  removeGrant: { mutate: vi.fn(), isPending: false },
}));
let connections: Partial<ToolConnection>[] = [];
let grants: ToolConnectionGrant[] = [];
let role = "member";

vi.mock("@/hooks/use-connections", () => ({
  useToolConnections: () => ({ data: { connections, tools: [] } }),
  useConnectionGrants: () => ({ data: { grants } }),
  useSetConnectionGrant: () => setGrant,
  useRemoveConnectionGrant: () => removeGrant,
}));
vi.mock("@/lib/api-client", () => ({ api: { me: vi.fn() } }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { user: { id: "u1" }, members: [{ id: "u1", role }] } }),
}));

const { RoutineChangesCard } = await import("./routine-changes-card");

const app = (over: Partial<ToolConnection>): Partial<ToolConnection> => ({
  id: "conn-gmail",
  label: "Gmail",
  transport: "composio",
  status: "active",
  scope: "owner",
  mine: true,
  ...over,
});

const AGENT = { id: "agent-1", name: "Inbox", myAccess: "edit" as const, connectionsOff: [] };

beforeEach(() => {
  connections = [];
  grants = [];
  role = "member";
  setGrant.mutate.mockClear();
  removeGrant.mutate.mockClear();
});

describe("RoutineChangesCard", () => {
  it("draws a switch per reachable connection", () => {
    connections = [
      app({}),
      app({ id: "conn-linear", label: "Linear" }),
      // Turned off for this agent on its Configuration: not reachable.
      app({ id: "conn-off", label: "Notion" }),
      // Still connecting: not reachable either.
      app({ id: "conn-pending", label: "HubSpot", status: "pending" }),
    ];
    render(<RoutineChangesCard agent={{ ...AGENT, connectionsOff: ["conn-off"] }} />);
    expect(screen.getAllByRole("switch")).toHaveLength(2);
    expect(screen.getByText("Gmail")).toBeInTheDocument();
    expect(screen.getByText("Linear")).toBeInTheDocument();
    expect(screen.queryByText("Notion")).not.toBeInTheDocument();
  });

  it("is on where a row exists, and turning it on writes the row", async () => {
    connections = [app({}), app({ id: "conn-linear", label: "Linear" })];
    grants = [{ agentId: "agent-1", connectionId: "conn-linear", grantedBy: "u1", grantedAt: 1 }];
    render(<RoutineChangesCard agent={AGENT} />);
    const gmail = screen.getByRole("switch", {
      name: "Let Inbox change things in Gmail without asking",
    });
    const linear = screen.getByRole("switch", {
      name: "Let Inbox change things in Linear without asking",
    });
    expect(gmail).not.toBeChecked();
    expect(linear).toBeChecked();
    await userEvent.click(gmail);
    expect(setGrant.mutate).toHaveBeenCalledWith(
      { agentId: "agent-1", connectionId: "conn-gmail" },
      expect.anything(),
    );
  });

  it("is disabled for somebody who may not decide, and says who may", () => {
    // Somebody else's shared app, and the person is not an admin.
    connections = [app({ mine: false, scope: "workspace" })];
    render(<RoutineChangesCard agent={AGENT} />);
    expect(screen.getByRole("switch")).toBeDisabled();
    expect(
      screen.getByText("Only whoever connected it (or an admin, if it is shared) can change this."),
    ).toBeInTheDocument();
  });

  it("lets an admin decide for a shared app somebody else connected", () => {
    role = "admin";
    connections = [app({ mine: false, scope: "workspace" })];
    render(<RoutineChangesCard agent={AGENT} />);
    expect(screen.getByRole("switch")).not.toBeDisabled();
  });

  it("lets anybody who can edit the agent turn one off", async () => {
    connections = [app({ mine: false, scope: "workspace" })];
    grants = [{ agentId: "agent-1", connectionId: "conn-gmail", grantedBy: "u2", grantedAt: 1 }];
    render(<RoutineChangesCard agent={AGENT} />);
    await userEvent.click(screen.getByRole("switch"));
    expect(removeGrant.mutate).toHaveBeenCalledWith(
      { agentId: "agent-1", connectionId: "conn-gmail" },
      expect.anything(),
    );
  });

  it("draws nothing when the agent reaches no app", () => {
    const { container } = render(<RoutineChangesCard agent={AGENT} />);
    expect(container).toBeEmptyDOMElement();
  });
});
