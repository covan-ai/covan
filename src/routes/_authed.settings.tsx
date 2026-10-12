import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/app-shell";
import { PageContainer, PageHeader, SectionHeading } from "@/components/page-container";
import { DeliveryChannelsCard } from "@/components/routines/delivery-channels-card";
import { UsageSection } from "@/components/usage-section";
import { WorkspaceUsageSection } from "@/components/workspace-usage-section";
import { WorkspaceCoverageSection } from "@/components/workspace-coverage-section";
import { DefaultModelSection, PersonalPreferencesSection } from "@/components/preferences-section";
import { WorkspaceForm } from "@/components/settings/workspace-form";
import { ProfileForm } from "@/components/settings/profile-form";
import { ApiKeysSection } from "@/components/api-keys-section";
import { ExportWorkspaceSection } from "@/components/export-workspace-section";
import { RecentlyDeletedSection } from "@/components/recently-deleted-section";
import { BrowserSignInsSection } from "@/components/browser-signins-section";
import { CloseAccountSection } from "@/components/close-account-section";
import { api } from "@/lib/api-client";
import { canWriteAsRole, isAdminRole } from "@/lib/roles";
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

function SettingsPage() {
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });

  // Defaults to true while `me` loads, so the form does not visibly lock and
  // then unlock on every cold load — mirrors the same choice in agents-store.
  const myRole = me?.members.find((m) => m.id === me.user.id)?.role;
  const isAdmin = me ? isAdminRole(myRole) : true;
  // False while `me` loads, unlike `isAdmin` above: this one decides whether a
  // section is fetched at all, and a request that 403s before the role is known
  // is worse than a section that appears a moment late.
  const canWrite = me ? canWriteAsRole(myRole) : false;

  return (
    <AppShell>
      <PageContainer width="form">
        <PageHeader badge="Settings" title="Names, and where" turn="the work gets sent." />

        <section className="mt-14">
          <SectionHeading
            title="Workspace"
            description={isAdmin ? undefined : "The name and slug are an admin's to change."}
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

        <PersonalPreferencesSection me={me} />

        <DefaultModelSection me={me} />

        <UsageSection />

        {/* Directly under the caller's own figures, because the two answer the
            same question at different scopes and reading one without the other
            is how "Yours alone" got mistaken for the whole bill. Admin only:
            the functions behind it refuse anybody else anyway, so this is so
            the section is not there to be confused by. */}
        {isAdmin && <WorkspaceUsageSection />}

        {/* After what the workspace costs, because the two are the same
            question from opposite ends: that section says what the answers
            were worth to buy, this one says whether the team had written
            anything for them. Admin only, and the functions behind it refuse
            anybody else in their own right. */}
        {isAdmin && (
          <WorkspaceCoverageSection gapReportEnabled={me?.workspace.gapReportEnabled ?? false} />
        )}

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

        {/* Under the export and above closing the account, which is the same
            argument as the one above it: somebody on this page because
            something went wrong should meet the way to undo it before they meet
            the way to destroy more. Hidden from a viewer — `workspace_trash()`
            refuses them anyway, and a section that only ever 403s is worse than
            no section. */}
        <RecentlyDeletedSection canWrite={canWrite} />

        {/* Above the account section, because it is the cheap version of the
            same request: a person who wants Covan to stop holding a login
            should find that before they find the door that also takes their
            conversations with it. Each of its parts — the jar, the open
            browsers, the saved logins — renders nothing when it has nothing
            to show. */}
        <BrowserSignInsSection />

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
