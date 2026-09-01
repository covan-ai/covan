import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "@/components/app-shell";
import { PageContainer, PageHeader, SectionHeading } from "@/components/page-container";
import { SectionCard } from "@/components/section-card";
import { UserAvatar } from "@/components/avatars";
import { DeliveryChannelsCard } from "@/components/routines/delivery-channels-card";
import { UsageSection } from "@/components/usage-section";
import { WorkspaceUsageSection } from "@/components/workspace-usage-section";
import { PreferencesSection } from "@/components/preferences-section";
import { ApiKeysSection } from "@/components/api-keys-section";
import { ExportWorkspaceSection } from "@/components/export-workspace-section";
import { CloseAccountSection } from "@/components/close-account-section";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { api, ApiError, type Me, type Workspace } from "@/lib/api-client";
import { isAdminRole } from "@/lib/roles";
import { privacyLink, termsLink } from "@/lib/legal";
import { LegalAnchor } from "@/components/legal-anchor";

export const Route = createFileRoute("/_authed/settings")({
  component: SettingsPage,
  head: () => ({
    meta: [
      { title: "Settings — Covan" },
      { name: "description", content: "Workspace settings for your Covan team." },
    ],
  }),
});

/**
 * Both forms on this page are seeded from `me` at mount and never again. The
 * effects that used to do the seeding are gone (#68), and the identity of the
 * thing being edited — passed as `key` by the caller — is what discards a
 * half-typed edit. That is the whole rule, and it is the one
 * `agents.$agentId.settings.tsx` already followed.
 *
 * It matters here more than most places, because this page invalidates `me`
 * itself: saving your display name refetches it so the sidebar agrees, and the
 * workspace form's old effect depended on `me.workspace` — a fresh object on
 * every refetch. So saving one form wiped whatever you had typed in the other.
 * Keying on the id cannot make that mistake; there is nothing to re-run.
 *
 * The cost, stated plainly: a workspace renamed in another tab does not appear
 * in these inputs until something remounts them. An input you are typing in is
 * exactly where a background write should not land.
 */
function WorkspaceForm({
  workspace,
  isAdmin,
}: {
  workspace: Workspace | undefined;
  isAdmin: boolean;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(workspace?.name ?? "");
  const [slug, setSlug] = useState(workspace?.slug ?? "");
  const [saving, setSaving] = useState(false);

  const dirty = !!workspace && (name !== workspace.name || slug !== workspace.slug);

  const handleSave = async () => {
    if (!workspace || !name.trim() || !slug.trim()) return;
    setSaving(true);
    try {
      await api.workspace.update({ name, slug });
      toast.success("Changes saved");
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to save changes";
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    if (!workspace) return;
    setName(workspace.name);
    setSlug(workspace.slug);
  };

  return (
    <SectionCard className="mt-6 space-y-5">
      <fieldset disabled={!isAdmin} className="contents">
        <div className="space-y-2">
          <Label htmlFor="ws-name">Name</Label>
          <Input id="ws-name" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="ws-slug">Slug</Label>
          <Input
            id="ws-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className="font-mono text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Short identifier used in links. Lowercase letters, numbers and dashes.
          </p>
        </div>
      </fieldset>
      {isAdmin ? (
        <div className="flex items-center justify-end gap-2 border-t border-hairline pt-4">
          {dirty ? (
            <Button variant="ghost" onClick={reset} disabled={saving}>
              Discard
            </Button>
          ) : null}
          <Button onClick={handleSave} disabled={saving || !dirty || !name.trim() || !slug.trim()}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      ) : null}
    </SectionCard>
  );
}

/** Your own display name. Same rule as `WorkspaceForm` above, same reason. */
function ProfileForm({ user }: { user: Me["user"] | undefined }) {
  const queryClient = useQueryClient();
  const [profileName, setProfileName] = useState(user?.name ?? "");
  const [savingProfile, setSavingProfile] = useState(false);

  const profileDirty = !!user && profileName.trim() !== (user.name ?? "");

  const handleSaveProfile = async () => {
    if (!profileName.trim()) return;
    setSavingProfile(true);
    try {
      await api.profile.update({ name: profileName.trim() });
      toast.success("Name saved");
      // `me` feeds the sidebar and the member list too, so everything showing
      // this name refreshes together rather than disagreeing until a reload.
      await queryClient.invalidateQueries({ queryKey: ["me"] });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Failed to save your name";
      toast.error(message);
    } finally {
      setSavingProfile(false);
    }
  };

  return (
    <SectionCard className="mt-6 space-y-5">
      <div className="flex items-center gap-4">
        <UserAvatar name={user?.name} url={user?.avatarUrl} className="h-11 w-11 text-xs" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] text-muted-foreground">{user?.email ?? "…"}</div>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="profile-name">Display name</Label>
        <Input
          id="profile-name"
          value={profileName}
          onChange={(e) => setProfileName(e.target.value)}
          maxLength={80}
        />
        <p className="text-xs text-muted-foreground">
          What the rest of the workspace sees — on shared sessions, in the member list, next to
          anything you send.
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-hairline pt-4">
        {profileDirty ? (
          <Button
            variant="ghost"
            onClick={() => setProfileName(user?.name ?? "")}
            disabled={savingProfile}
          >
            Discard
          </Button>
        ) : null}
        <Button
          onClick={handleSaveProfile}
          disabled={savingProfile || !profileDirty || !profileName.trim()}
        >
          {savingProfile ? "Saving…" : "Save name"}
        </Button>
      </div>

      <p className="border-t border-hairline pt-4 text-xs text-muted-foreground">
        Your photo still comes from the account you signed in with. Sign out from the menu at the
        bottom of the sidebar.
      </p>
    </SectionCard>
  );
}

function SettingsPage() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });

  // Defaults to true while `me` loads, so the form does not visibly lock and
  // then unlock on every cold load — mirrors the same choice in agents-store.
  const isAdmin = me ? isAdminRole(me.members.find((m) => m.id === me.user.id)?.role) : true;

  return (
    <AppShell>
      <PageContainer width="form">
        <PageHeader badge="Settings" title="Names, and where" turn="the work gets sent." />

        <section className="mt-14">
          <SectionHeading
            title="Workspace"
            description={
              isAdmin
                ? undefined
                : "The name and slug are an admin's to change. They are here so you can see them."
            }
          />
          {/* Read-only for everybody but an admin. `workspaces_update_admin` has
              always refused this write, and PATCH /workspace answers 403 — but
              the form was rendered to everyone, so a member could fill it in,
              press Save and be told they had done something wrong. */}
          {/* `key` is the seeding. "pending" while `me` loads, then the id: the
              change from one to the other is the mount that fills the inputs
              in, and switching workspaces is the only other thing that can
              move it. */}
          <WorkspaceForm
            key={me?.workspace.id ?? "pending"}
            workspace={me?.workspace}
            isAdmin={isAdmin}
          />
        </section>

        <section className="mt-16">
          <SectionHeading title="Your account" />
          <ProfileForm key={me?.user.id ?? "pending"} user={me?.user} />
        </section>

        <PreferencesSection me={me} />

        <UsageSection />

        {/* Directly under the caller's own figures, because the two answer the
            same question at different scopes and reading one without the other
            is how "Yours alone" got mistaken for the whole bill. Admin only:
            the functions behind it refuse anybody else anyway, so this is so
            the section is not there to be confused by. */}
        {isAdmin && <WorkspaceUsageSection />}

        <DeliveryChannelsCard />

        {/* Not gated on `isAdmin`: a key can do only what its holder can, so a
            viewer holding one is a viewer, and there is nothing an admin needs
            to approve. The section hides itself where the deployment cannot
            honour a key at all. */}
        <ApiKeysSection />

        {/* Above closing the account, and that order is the argument: somebody
            reading this page because they are leaving should meet the way to
            take their work with them before they meet the way to destroy it.
            Not gated on a role — an export is a read, and it contains only what
            this person could already see. */}
        <ExportWorkspaceSection workspaceId={me?.workspace.id} workspaceName={me?.workspace.name} />

        {/* Last on the page, under everything it would destroy. Not gated on a
            role: erasure is the caller's own right and an admin has no say in
            it — the only thing that can refuse is a workspace that would be
            left without an admin, and the server says so by name. */}
        <CloseAccountSection email={me?.user.email} />

        {/* Both documents were reachable from exactly one place — the "I agree"
            checkbox on the sign-up form — so the moment somebody had an account
            they had no way back to what they had agreed to. Settings is where a
            reader looks, and it is what both entries in the sidebar's account
            menu lead to. New tab: nobody should lose a workspace to read a
            policy. */}
        <p className="mt-16 border-t border-hairline pt-6 text-xs text-muted-foreground">
          <LegalAnchor link={termsLink()} newTab>
            Terms
          </LegalAnchor>{" "}
          ·{" "}
          <LegalAnchor link={privacyLink()} newTab>
            Privacy Policy
          </LegalAnchor>
        </p>
      </PageContainer>
    </AppShell>
  );
}
