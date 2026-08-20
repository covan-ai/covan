import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { PageContainer, PageHeader, SectionHeading } from "@/components/page-container";
import { Chip, DataRow, EmptyState } from "@/components/section-card";
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
import { MailPlus, Trash2, UserPlus } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
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
 * amber for the role that can change things, neutral for the one that can't.
 * There is no third state and no red.
 */
function RoleChip({ role }: { role: string }) {
  return (
    <Chip tone={role === "admin" ? "on" : "neutral"} className="capitalize">
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

  const [inviteOpen, setInviteOpen] = useState(false);

  const changeRole = async (userId: string, role: "admin" | "member") => {
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
        />

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
                            onValueChange={(v) => changeRole(m.id, v as "admin" | "member")}
                          >
                            <SelectTrigger
                              className="h-8 w-28"
                              aria-label={`Role for ${m.name ?? m.email ?? "member"}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="member">Member</SelectItem>
                              <SelectItem value="admin">Admin</SelectItem>
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
                                  workspace and its agents. You can re-invite them later.
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
                        <RoleChip role={m.role} />
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
