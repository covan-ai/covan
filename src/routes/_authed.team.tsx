import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { PageContainer, PageHeader, SectionHeading } from "@/components/page-container";
import { Chip, DataRow, EmptyState } from "@/components/section-card";
import { DocsLink } from "@/components/docs-link";
import { UserAvatar } from "@/components/avatars";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { LogOut, MailPlus, Trash2, UserPlus } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { invalidateWorkspaceScoped } from "@/lib/workspace-queries";
import { canWriteAsRole, WORKSPACE_ROLES, type WorkspaceRole } from "@/lib/roles";
import { InviteMemberDialog } from "@/components/invite-member-dialog";
import { toast } from "sonner";

export const Route = createFileRoute("/_authed/team")({
  component: TeamPage,
  head: () => ({
    meta: [
      { title: "Team — Covan" },
      { name: "description", content: "Manage your team members and roles." },
    ],
  }),
});

/**
 * A role reads as a chip, and the chip's colour carries the meaning (§7.8):
 * amber for a role that can change things, neutral for one that can't. There
 * is no third state and no red.
 *
 * With three roles the tone no longer means "admin". It means what §7.8 always
 * said it meant — can this person change things — and the word carries which
 * role they hold. That is also the fix: the tone used to say `member` could
 * not change things, and no policy on any shared table agreed. Now `viewer` is
 * the only neutral one, and it is neutral because `can_write_in_workspace`
 * refuses it.
 */
function RoleChip({ role }: { role: string }) {
  return (
    <Chip tone={canWriteAsRole(role) ? "on" : "neutral"} className="capitalize">
      {role}
    </Chip>
  );
}

function TeamPage() {
  const queryClient = useQueryClient();
  const { data: me, isLoading } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const members = me?.members ?? [];
  const currentUserId = me?.user.id;
  const isAdmin = members.find((m) => m.id === currentUserId)?.role === "admin";
  const adminCount = members.filter((m) => m.role === "admin").length;

  const { data: pending = [] } = useQuery({
    queryKey: ["invitations"],
    queryFn: () => api.invitations.list(),
    enabled: isAdmin,
  });

  // Already in the cache — the app shell's workspace switcher fetches it — so
  // this reads it rather than asking again. It is here to answer one question:
  // is there anywhere else for this person to be if they leave?
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.workspaces.list(),
  });

  /**
   * Why leaving is refused, or null when it is not.
   *
   * Both reasons are enforced by the server — the first by the route, the
   * second by `trg_prevent_last_admin` — and repeated here so the dialog can
   * say them before the button is pressed rather than after. If these ever
   * disagree with the server, the server is right; the worst case is a dialog
   * that explains a refusal that would not have happened.
   */
  const cannotLeave =
    workspaces.length <= 1
      ? "This is your only workspace. Leaving it would leave you nowhere to go — create or join another one first."
      : isAdmin && adminCount === 1
        ? "You are the only admin. Make someone else an admin first — a workspace cannot be left without one."
        : null;

  const [inviteOpen, setInviteOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const leaveWorkspace = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await api.workspace.members.leave();
      // Everything on screen belonged to the workspace just left. The server
      // has already repointed the session to another membership, so refetching
      // the workspace-scoped queries is what rebinds the app to it.
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
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      toast.success("Role updated");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't update role");
    }
  };

  const removeMember = async (userId: string) => {
    try {
      await api.workspace.members.remove(userId);
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      toast.success("Member removed");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't remove member");
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

  return (
    <AppShell>
      <PageContainer width="list">
        <PageHeader
          badge="Team"
          title="One agent."
          turn="Everyone who needs it."
          action={
            isAdmin ? (
              <Button onClick={() => setInviteOpen(true)}>
                <UserPlus className="h-4 w-4" /> Invite
              </Button>
            ) : undefined
          }
        >
          <DocsLink page="team">What each role actually gates</DocsLink>
        </PageHeader>

        <section className="mt-14">
          <SectionHeading
            title="Members"
            meta={
              isLoading
                ? undefined
                : `${members.length} ${members.length === 1 ? "person" : "people"} · ${adminCount} ${
                    adminCount === 1 ? "admin" : "admins"
                  }`
            }
          />

          <div className="mt-6">
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading members…</p>
            ) : members.length === 0 ? (
              <p className="text-sm text-muted-foreground">No members yet.</p>
            ) : (
              <ul className="flex flex-col gap-2.5">
                {members.map((m) => {
                  const isSelf = m.id === currentUserId;
                  const manageable = isAdmin && !isSelf;
                  return (
                    <li
                      key={m.id}
                      className="flex items-center gap-3.5 rounded-lg border border-hairline bg-surface px-4 py-3.5"
                    >
                      <UserAvatar name={m.name} url={m.avatarUrl} className="h-9 w-9 text-[11px]" />
                      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[15px] font-medium leading-tight">
                            {m.name ?? m.email ?? "—"}
                          </span>
                          {isSelf ? (
                            <span className="shrink-0 text-[13px] text-micro-foreground">
                              (you)
                            </span>
                          ) : null}
                        </div>
                        <div className="truncate text-[13px] leading-tight text-muted-foreground">
                          {m.email ?? "—"}
                        </div>
                      </div>

                      {manageable ? (
                        <>
                          <Select
                            value={m.role}
                            onValueChange={(v) => changeRole(m.id, v as WorkspaceRole)}
                          >
                            <SelectTrigger
                              className="h-8 w-28"
                              aria-label={`Role for ${m.name ?? m.email ?? "member"}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {WORKSPACE_ROLES.map((r) => (
                                <SelectItem key={r} value={r} className="capitalize">
                                  {r}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <button
                                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                aria-label={`Remove ${m.name ?? m.email ?? "member"}`}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Remove member?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {m.name ?? m.email ?? "This member"} will lose access to this
                                  workspace, its agents, and their own conversations here —
                                  including what the agents answered from your knowledge. Nothing is
                                  deleted: invite them back and it all returns.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction onClick={() => removeMember(m.id)}>
                                  Remove
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </>
                      ) : (
                        <>
                          <RoleChip role={m.role} />
                          {isSelf ? (
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <button
                                  className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                                  aria-label="Leave this workspace"
                                >
                                  <LogOut className="h-4 w-4" />
                                </button>
                              </AlertDialogTrigger>
                              {/*
                                The dialog opens even when leaving is refused,
                                and explains why. A disabled button has nowhere
                                to put the reason, and "make someone else an
                                admin first" is the whole of what the person
                                needs to know.
                              */}
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>
                                    {cannotLeave ? "You can't leave yet" : "Leave this workspace?"}
                                  </AlertDialogTitle>
                                  <AlertDialogDescription>
                                    {cannotLeave ??
                                      "You will lose access to this workspace's agents and knowledge, and to the conversations you had with them here — your own private ones included. Nothing is deleted: what you made stays, and it all comes back if an admin invites you back."}
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>
                                    {cannotLeave ? "Close" : "Cancel"}
                                  </AlertDialogCancel>
                                  {cannotLeave ? null : (
                                    <AlertDialogAction onClick={leaveWorkspace} disabled={leaving}>
                                      Leave
                                    </AlertDialogAction>
                                  )}
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          ) : null}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {isAdmin && (
          <section className="mt-16">
            <SectionHeading
              title="Sent, not accepted."
              turn="Yet."
              meta={pending.length > 0 ? `${pending.length} waiting` : undefined}
            />
            {pending.length === 0 ? (
              <EmptyState
                className="mt-6"
                title="No invitations out"
                description="Invite a teammate and they'll land in this workspace with access to every shared agent."
                action={
                  <Button variant="secondary" onClick={() => setInviteOpen(true)}>
                    <MailPlus className="h-4 w-4" /> Invite someone
                  </Button>
                }
              />
            ) : (
              <ul className="mt-6 flex flex-col gap-2.5">
                {pending.map((inv) => (
                  <li key={inv.id}>
                    <DataRow
                      icon={
                        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-dashed border-border text-muted-foreground">
                          <MailPlus className="h-4 w-4" />
                        </span>
                      }
                      title={inv.email}
                      meta="Invitation sent"
                      trailing={
                        <span className="flex shrink-0 items-center gap-2">
                          <RoleChip role={inv.role} />
                          <Button variant="ghost" size="sm" onClick={() => revokeInvite(inv.id)}>
                            Revoke
                          </Button>
                        </span>
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </PageContainer>

      <InviteMemberDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </AppShell>
  );
}
