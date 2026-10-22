import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MoreHorizontal, Search, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { TopBar } from "@/components/top-bar";
import { PageBody } from "@/components/page";
import { TabsRow } from "@/components/tabs";
import { DataTable, type Column } from "@/components/data-table";
import { SectionLabel } from "@/components/section";
import { Avatar } from "@/components/avatar";
import { Chip } from "@/components/chip";
import { DocsLink } from "@/components/docs-link";
import { EmptyPage } from "@/components/empty-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, ApiError, type PendingInvitation, type TeamMember } from "@/lib/api-client";
import { invalidateWorkspaceScoped } from "@/lib/workspace-queries";
import { ROLE_SUMMARY, WORKSPACE_ROLES, type WorkspaceRole } from "@/lib/roles";
import { copyInviteText } from "@/lib/invite-text";
import { lastActivityLabel } from "@/lib/day-groups";
import { InviteMemberDialog } from "@/components/invite-member-dialog";
import { LiveKeyWarning } from "@/components/live-key-warning";
import { WorkspaceActivitySection } from "@/components/workspace-activity-section";

type Tab = "members" | "invitations" | "roles";
const TABS: Tab[] = ["members", "invitations", "roles"];

/**
 * The people in the workspace (A3): who is in it and with what role, the
 * invitations still out, and what each role can do. Members can be filtered;
 * an admin changes a role in place, removes somebody or resends an
 * invitation from the row.
 */
export const Route = createFileRoute("/_authed/team")({
  component: TeamPage,
  // `?invite=1` opens the invite dialog: the ⌘K palette's "Invite a member"
  // and Home's Invite.
  validateSearch: (search: Record<string, unknown>): { tab?: Tab; invite?: boolean } => ({
    tab: TABS.includes(search.tab as Tab) ? (search.tab as Tab) : undefined,
    invite:
      search.invite === true || search.invite === 1 || search.invite === "1" ? true : undefined,
  }),
  head: () => ({
    meta: [
      { title: "Team — Covan" },
      { name: "description", content: "Manage your team members and roles." },
    ],
  }),
});

const roleWord = (r: WorkspaceRole) => r.charAt(0).toUpperCase() + r.slice(1);

/** "Expires in 5 d", "Expired". */
function expiresWords(at: number | null | undefined, now: number): string | null {
  if (!at) return null;
  const days = Math.ceil((at - now) / 86_400_000);
  if (days <= 0) return "Expired";
  return `Expires in ${days} d`;
}

function TeamPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { tab = "members", invite } = Route.useSearch();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { data: members = [], isLoading } = useQuery({
    queryKey: ["workspace", "members"],
    queryFn: () => api.workspace.members.list(),
  });
  const currentUserId = me?.user.id;
  const isAdmin = me?.members.find((m) => m.id === currentUserId)?.role === "admin";
  const adminCount = members.filter((m) => m.role === "admin").length;

  const { data: pending = [], dataUpdatedAt } = useQuery({
    queryKey: ["invitations"],
    queryFn: () => api.invitations.list(),
    enabled: isAdmin,
  });

  // Already in the cache — the workspace switcher fetches it. It answers one
  // question: is there anywhere else for this person to be if they leave?
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.workspaces.list(),
  });

  /**
   * Why leaving is refused, or null when it is not. Both are the server's
   * (the route, and `trg_prevent_last_admin`); said here so the dialog can
   * give the reason before the button is pressed.
   */
  const cannotLeave =
    workspaces.length <= 1
      ? "This is your only workspace. Leaving it would leave you nowhere to go — create or join another one first."
      : isAdmin && adminCount === 1
        ? "You are the only admin. Make someone else an admin first — a workspace cannot be left without one."
        : null;

  const [inviteOpen, setInviteOpen] = useState(Boolean(invite));
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<WorkspaceRole | "all">("all");
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [leavingOpen, setLeavingOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["me"] }),
      queryClient.invalidateQueries({ queryKey: ["workspace", "members"] }),
    ]);

  const leaveWorkspace = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await api.workspace.members.leave();
      // The server has already repointed the session to another membership;
      // refetching the workspace-scoped queries rebinds the app to it.
      await invalidateWorkspaceScoped(queryClient);
      toast.success("You have left the workspace");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't leave the workspace");
    } finally {
      setLeaving(false);
    }
  };

  const changeRole = async (userId: string, role: WorkspaceRole) => {
    try {
      await api.workspace.members.updateRole(userId, role);
      await refresh();
      toast.success("Role updated");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update role");
    }
  };

  const removeMember = async (userId: string) => {
    try {
      await api.workspace.members.remove(userId);
      await refresh();
      toast.success("Member removed");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't remove member");
    }
  };

  // A new link: the old one stops working, the seven days start again, and the
  // invitee is emailed if this install can send mail. If it cannot, the link
  // exists only in this response, so the toast is where it is handed over.
  const resendInvite = async (id: string) => {
    try {
      const sent = await api.invitations.resend(id);
      await queryClient.invalidateQueries({ queryKey: ["invitations"] });
      const url = sent.inviteUrl;
      if (sent.emailed) {
        toast.success(`Sent a new link to ${sent.email}`);
      } else {
        toast.warning(`New link ready for ${sent.email} — no email went out, so pass it on`, {
          duration: 12000,
          action: url
            ? {
                label: "Copy invite text",
                onClick: () => copyInviteText([{ email: sent.email, url }]),
              }
            : undefined,
        });
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't resend the invitation");
    }
  };

  const revokeInvite = async (id: string) => {
    try {
      await api.invitations.revoke(id);
      await queryClient.invalidateQueries({ queryKey: ["invitations"] });
      toast.success("Invitation revoked");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't revoke invitation");
    }
  };

  const needle = query.trim().toLowerCase();
  const shown = members.filter(
    (m) =>
      (roleFilter === "all" || m.role === roleFilter) &&
      (!needle ||
        (m.name ?? "").toLowerCase().includes(needle) ||
        (m.email ?? "").toLowerCase().includes(needle)),
  );

  const memberColumns: Column<TeamMember>[] = [
    {
      key: "member",
      header: "Member",
      className: "w-[40%]",
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={m.name ?? m.email} url={m.avatarUrl} size={24} />
          <span className="min-w-0">
            <span className="block truncate font-medium">
              {m.name ?? m.email ?? "—"}
              {m.id === currentUserId && (
                <span className="font-normal text-muted-foreground"> (you)</span>
              )}
            </span>
            <span className="block truncate text-meta text-muted-foreground">{m.email ?? "—"}</span>
          </span>
        </span>
      ),
    },
    {
      key: "role",
      header: "Role",
      cell: (m) =>
        m.isOwner ? (
          <Chip>Owner</Chip>
        ) : isAdmin && m.id !== currentUserId ? (
          <Select value={m.role} onValueChange={(v) => void changeRole(m.id, v as WorkspaceRole)}>
            <SelectTrigger
              size="sm"
              className="w-auto gap-1.5"
              aria-label={`Role for ${m.name ?? m.email ?? "member"}`}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WORKSPACE_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {roleWord(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Chip>{roleWord(m.role)}</Chip>
        ),
    },
    { key: "agents", header: "Agents", cell: (m) => m.agents.toLocaleString("en-US") },
    {
      key: "seen",
      header: "Last active",
      cell: (m) => (
        <span className="text-muted-foreground">
          {m.lastSeenAt ? lastActivityLabel(m.lastSeenAt) : "Not yet"}
        </span>
      ),
    },
    {
      key: "more",
      header: <span className="sr-only">Actions</span>,
      className: "w-12",
      cell: (m) => {
        const self = m.id === currentUserId;
        if (!self && !(isAdmin && !m.isOwner)) return null;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`More for ${m.name ?? m.email ?? "member"}`}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {self ? (
                <DropdownMenuItem className="text-destructive" onClick={() => setLeavingOpen(true)}>
                  Leave this workspace
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem className="text-destructive" onClick={() => setRemoving(m)}>
                  Remove from the workspace
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  const invitationRows = (
    <ul className="m-0 list-none p-0">
      {pending.map((inv: PendingInvitation) => (
        <li
          key={inv.id}
          className="grid min-h-[52px] grid-cols-1 items-center gap-x-4 gap-y-1 border-b border-hairline px-2.5 py-2 text-sm last:border-b-0 md:grid-cols-[40%_minmax(0,1fr)_minmax(0,1fr)_auto]"
        >
          <span className="flex min-w-0 items-center gap-2.5">
            <Avatar name={inv.email} size={24} dashed />
            <span className="min-w-0">
              <span className="block truncate font-medium">{inv.email}</span>
              <span className="block truncate text-meta text-muted-foreground">
                Invited by {inv.invitedBy?.name ?? "an admin"} · {lastActivityLabel(inv.createdAt)}
                {inv.needsResend ? " · link expired, resend it" : ""}
              </span>
            </span>
          </span>
          <span>
            <Chip>{roleWord(inv.role as WorkspaceRole)}</Chip>
          </span>
          <span className="text-muted-foreground">
            {inv.needsResend ? "Expired" : expiresWords(inv.expiresAt, dataUpdatedAt)}
          </span>
          <span className="flex shrink-0 gap-1.5">
            <Button
              variant={inv.needsResend ? "default" : "secondary"}
              size="sm"
              onClick={() => void resendInvite(inv.id)}
            >
              Resend
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void revokeInvite(inv.id)}>
              Revoke
            </Button>
          </span>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <TopBar
        title="Team"
        actions={
          isAdmin ? (
            <Button onClick={() => setInviteOpen(true)} data-coach="invite-member">
              <UserPlus /> Invite member
            </Button>
          ) : undefined
        }
      />
      <PageBody width="table">
        <TabsRow
          label="Team pages"
          value={tab}
          onChange={(t) => void navigate({ to: "/team", search: { tab: t }, replace: true })}
          items={[
            { value: "members", label: "Members", count: members.length },
            ...(isAdmin
              ? [{ value: "invitations" as const, label: "Invitations", count: pending.length }]
              : []),
            { value: "roles", label: "Roles" },
          ]}
        />

        {tab === "members" && (
          <>
            <div className="mt-5 mb-3 flex flex-wrap items-center gap-2">
              <div className="relative w-full max-w-[280px]">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  aria-label="Filter members"
                  placeholder="Filter by name or email"
                  className="pl-8"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <Select
                value={roleFilter}
                onValueChange={(v) => setRoleFilter(v as WorkspaceRole | "all")}
              >
                <SelectTrigger size="sm" className="w-auto gap-1.5" aria-label="Show roles">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  {WORKSPACE_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {roleWord(r)}s
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading members…</p>
            ) : (
              <div className="overflow-x-auto">
                <DataTable
                  label="Members"
                  columns={memberColumns}
                  rows={shown}
                  rowKey={(m) => m.id}
                  empty={
                    <p className="py-6 text-sm text-muted-foreground">Nobody here matches that.</p>
                  }
                />
              </div>
            )}

            {isAdmin && pending.length > 0 && (
              <section className="mt-10">
                <SectionLabel as="h2">Pending invitations · {pending.length}</SectionLabel>
                {invitationRows}
              </section>
            )}

            {/* Admin-only because the policy is: mostly what members did to
                each other's work and standing, which is this page's question. */}
            <WorkspaceActivitySection isAdmin={isAdmin} />
          </>
        )}

        {tab === "invitations" &&
          (pending.length === 0 ? (
            <EmptyPage
              title="No invitations out"
              description="Invite a teammate and they land in this workspace with every agent shared with everyone."
              actions={
                isAdmin ? (
                  <Button onClick={() => setInviteOpen(true)}>Invite member</Button>
                ) : undefined
              }
            />
          ) : (
            <div className="mt-4">{invitationRows}</div>
          ))}

        {tab === "roles" && (
          <section className="mt-4">
            <ul className="m-0 list-none p-0">
              {WORKSPACE_ROLES.map((r) => (
                <li
                  key={r}
                  className="grid min-h-[52px] items-center gap-x-6 border-b border-hairline px-3 py-2 last:border-b-0 sm:grid-cols-[160px_minmax(0,1fr)_120px]"
                >
                  <span className="font-medium">{roleWord(r)}</span>
                  <span className="text-muted-foreground">{ROLE_SUMMARY[r]}</span>
                  <span className="text-meta text-muted-foreground sm:text-right">
                    {members.filter((m) => m.role === r).length}{" "}
                    {members.filter((m) => m.role === r).length === 1 ? "person" : "people"}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-4 text-meta text-muted-foreground">
              The workspace&rsquo;s owner is the admin who made it; it is a label, not a fourth
              role. <DocsLink page="team">What each role actually gates</DocsLink>
            </p>
          </section>
        )}
      </PageBody>

      <InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      <AlertDialog open={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {removing?.name ?? removing?.email ?? "this member"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              They lose access to this workspace, its agents and their own conversations here.
              Nothing is deleted: invite them back and it all returns.
            </AlertDialogDescription>
            {/* The exception to "nothing is deleted": a key acts as its owner,
                so it stops working the moment they do. */}
            {removing && <LiveKeyWarning userId={removing.id} />}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              onClick={() => removing && void removeMember(removing.id)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Opens even when leaving is refused, and says why: a disabled button
          has nowhere to put the reason. */}
      <AlertDialog open={leavingOpen} onOpenChange={setLeavingOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {cannotLeave ? "You can't leave yet" : "Leave this workspace?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {cannotLeave ??
                "You lose access to this workspace's agents and knowledge, and to the conversations you had with them here — your own private ones included. Nothing is deleted: it all comes back if an admin invites you back."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{cannotLeave ? "Close" : "Cancel"}</AlertDialogCancel>
            {cannotLeave ? null : (
              <AlertDialogAction
                variant="danger"
                onClick={() => void leaveWorkspace()}
                disabled={leaving}
              >
                Leave
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
