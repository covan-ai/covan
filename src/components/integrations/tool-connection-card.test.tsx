import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ToolConnection, ToolConnectionGrant } from "@/lib/connections-api";

let grants: ToolConnectionGrant[] = [];
vi.mock("@/hooks/use-connections", () => ({
  useConnectionGrants: () => ({ data: { grants } }),
  useRemoveConnectionGrant: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveToolConnection: () => ({ mutate: vi.fn(), isPending: false }),
  useComposioStatus: () => undefined,
  useUpdateToolConnection: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/api-client", () => ({ api: { me: vi.fn() }, assetSrc: (p: string) => p }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { user: { id: "u1" }, members: [{ id: "u1", role: "member" }] } }),
}));
vi.mock("./connection-scope", () => ({ ConnectionScope: () => null }));

const { ToolConnectionRow } = await import("./tool-connection-card");

const SERVICE = {
  id: "svc-1",
  label: "Orders API",
  transport: "http",
  baseUrl: "https://api.example.com",
  allowedMethods: ["GET", "POST"],
  scope: "workspace",
  mine: true,
  status: "active",
} as unknown as ToolConnection;

beforeEach(() => {
  grants = [];
});

async function manage(connection: ToolConnection) {
  render(<ToolConnectionRow connection={connection} agents={[{ id: "agent-1", name: "Ops" }]} />);
  await userEvent.click(screen.getByRole("button", { name: "Manage" }));
  return within(screen.getByRole("dialog"));
}

describe("ToolConnectionRow", () => {
  it("names the agents that write to a service without asking", async () => {
    grants = [{ agentId: "agent-1", connectionId: "svc-1", grantedBy: "u1", grantedAt: 1 }];
    const dialog = await manage(SERVICE);
    expect(dialog.getByText("Changes things without asking")).toBeInTheDocument();
    expect(dialog.getByText("Ops")).toBeInTheDocument();
  });

  it("lists nothing for a service that can only read", async () => {
    grants = [{ agentId: "agent-1", connectionId: "svc-1", grantedBy: "u1", grantedAt: 1 }];
    const dialog = await manage({ ...SERVICE, allowedMethods: ["GET"] });
    expect(dialog.queryByText("Changes things without asking")).not.toBeInTheDocument();
  });
});
