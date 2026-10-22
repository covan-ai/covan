import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type React from "react";
import type { Me, TeamMember } from "@/lib/api-client";
import { meFixture } from "@/test/me-fixture";
import { renderRoute } from "@/test/settings-route";

let search: { tab?: string } = {};
const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: () => React.ReactElement }) => ({
    ...options,
    useSearch: () => search,
  }),
  useNavigate: () => navigate,
}));

let me: Me;
let members: TeamMember[] = [];
const invitationsList = vi.fn();
vi.mock("@/lib/api-client", () => ({
  api: {
    me: () => Promise.resolve(me),
    invitations: { list: invitationsList },
    workspace: { members: { list: () => Promise.resolve(members) } },
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

const { Route } = await import("./_authed.team");

const person = (over: Partial<TeamMember>): TeamMember => ({
  id: "u2",
  name: "Grace Hopper",
  email: "grace@acme.test",
  avatarUrl: null,
  role: "member",
  agents: 2,
  lastSeenAt: null,
  joinedAt: null,
  isOwner: false,
  ...over,
});

beforeEach(() => {
  search = {};
  navigate.mockReset();
  invitationsList.mockReset().mockResolvedValue([]);
  me = meFixture({
    members: [
      { id: "u2", name: "Grace Hopper", email: "grace@acme.test", role: "member", avatarUrl: null },
    ],
  });
  members = [
    person({
      id: me.user.id,
      name: "Ada Lovelace",
      email: "ada@acme.test",
      role: "admin",
      isOwner: true,
    }),
    person({}),
  ];
});

describe("/team (A3)", () => {
  it("lists the people with their role, agents and when they were last here", async () => {
    renderRoute(Route);
    const table = await screen.findByRole("table", { name: "Members" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent(/Ada Lovelace \(you\)ada@acme\.testOwner/);
    expect(rows[1]).toHaveTextContent(/Grace Hopper/);
    expect(
      within(rows[1]!).getByRole("combobox", { name: "Role for Grace Hopper" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Invite member/ })).toBeInTheDocument();
  });

  it("filters by name or email", async () => {
    renderRoute(Route);
    await screen.findByRole("table", { name: "Members" });
    await userEvent.type(screen.getByLabelText("Filter members"), "grace");
    const table = screen.getByRole("table", { name: "Members" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
  });

  it("shows the invitations still out, with who sent them and when they lapse", async () => {
    invitationsList.mockResolvedValue([
      {
        id: "i1",
        email: "ayse@acme.test",
        role: "member",
        createdAt: Date.now() - 2 * 86_400_000,
        needsResend: false,
        invitedBy: { id: "u1", name: "Mina" },
        expiresAt: Date.now() + 5 * 86_400_000,
      },
    ]);
    renderRoute(Route);
    expect(await screen.findByText("Pending invitations · 1")).toBeInTheDocument();
    expect(screen.getByText(/Invited by Mina/)).toBeInTheDocument();
    expect(screen.getByText("Expires in 5 d")).toBeInTheDocument();
  });

  // The invitations list 403s for anybody but an admin, so it must not even
  // be asked for while the role is unknown.
  it("shows a member the people, their own way out, and nothing to manage", async () => {
    me = meFixture({
      role: "member",
      members: [
        {
          id: "u2",
          name: "Grace Hopper",
          email: "grace@acme.test",
          role: "admin",
          avatarUrl: null,
        },
      ],
    });
    members = [
      person({ id: me.user.id, name: "Ada Lovelace", role: "member" }),
      person({ role: "admin" }),
    ];
    renderRoute(Route);
    await screen.findByRole("table", { name: "Members" });
    expect(screen.queryByRole("button", { name: /Invite member/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /Role for/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "More for Ada Lovelace" }));
    expect(
      await screen.findByRole("menuitem", { name: "Leave this workspace" }),
    ).toBeInTheDocument();
    expect(invitationsList).not.toHaveBeenCalled();
  });

  it("says what each role can do", async () => {
    search = { tab: "roles" };
    renderRoute(Route);
    expect(
      await screen.findByText("Runs the workspace: people, roles and settings."),
    ).toBeInTheDocument();
    expect(screen.getByText("Uses the agents. Changes none of them.")).toBeInTheDocument();
  });
});
