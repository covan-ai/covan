import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import type React from "react";
import type { Me } from "@/lib/api-client";
import { meFixture } from "@/test/me-fixture";
import { renderRoute } from "@/test/settings-route";

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => options,
}));

let me: Me;
const invitationsList = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    me: () => Promise.resolve(me),
    invitations: { list: invitationsList },
    workspaces: { list: () => Promise.resolve([{ id: "w1" }, { id: "w2" }]) },
  },
  ApiError: class ApiError extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/docs-link", () => ({
  DocsLink: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("@/components/invite-member-dialog", () => ({ InviteMemberDialog: () => null }));
vi.mock("@/components/live-key-warning", () => ({ LiveKeyWarning: () => null }));
vi.mock("@/components/workspace-activity-section", () => ({
  WorkspaceActivitySection: () => null,
}));

const { Route } = await import("./_authed.settings.members");

const grace = {
  id: "u2",
  name: "Grace",
  email: "grace@acme.test",
  role: "member",
  avatarUrl: null,
};

beforeEach(() => {
  invitationsList.mockReset().mockResolvedValue([]);
  me = meFixture({ members: [grace] });
});

describe("/settings/members", () => {
  it("lets an admin invite people and change someone else's role", async () => {
    renderRoute(Route);
    expect(await screen.findByText("Grace")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Role for Grace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Invite$/ })).toBeInTheDocument();
  });

  // The invitations list 403s for anybody but an admin, so it must not even
  // be asked for while the role is unknown.
  it("shows a member the people, their own way out, and nothing to manage", async () => {
    me = meFixture({ role: "member", members: [{ ...grace, role: "admin" }] });
    renderRoute(Route);
    await screen.findByText("Grace");
    expect(screen.queryByRole("button", { name: /Invite$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Leave this workspace" })).toBeInTheDocument();
    expect(invitationsList).not.toHaveBeenCalled();
  });
});
