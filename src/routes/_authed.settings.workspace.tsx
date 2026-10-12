import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionHeading } from "@/components/page-container";
import { SettingsPage } from "@/components/settings/settings-page";
import { WorkspaceForm } from "@/components/settings/workspace-form";
import { DefaultModelSection } from "@/components/preferences-section";
import { WorkspaceCoverageSection } from "@/components/workspace-coverage-section";
import { ExportWorkspaceSection } from "@/components/export-workspace-section";
import { RecentlyDeletedSection } from "@/components/recently-deleted-section";
import { useWorkspaceRole } from "@/lib/workspace-role";

export const Route = createFileRoute("/_authed/settings/workspace")({
  component: WorkspaceSettingsPage,
  head: () => ({
    meta: [
      { title: "Workspace settings — Covan" },
      { name: "description", content: "Workspace settings for your Covan team." },
    ],
  }),
});

/** What belongs to the workspace, and so to everyone in it. */
function WorkspaceSettingsPage() {
  const { me, isAdmin: isAdminOnceKnown, canWrite } = useWorkspaceRole();

  // True while `me` loads, unlike the hook's own answer, so the form does not
  // visibly lock and then unlock on every cold load — mirrors the same choice
  // in agents-store. Nothing is fetched on the strength of it: the sections
  // gated below on `isAdmin` ask a server that refuses anybody else anyway.
  const isAdmin = me ? isAdminOnceKnown : true;

  return (
    <SettingsPage>
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

      {/* Admin only: RLS lets only an admin write it, and a picker anybody can
          open that answers 403 is the "you did something wrong" this page
          stopped doing to the form above. */}
      {isAdmin && <DefaultModelSection me={me} />}

      {/* Whether the team had written anything for the questions it asked.
          Admin only, and the functions behind it refuse anybody else in their
          own right. */}
      {isAdmin && (
        <WorkspaceCoverageSection gapReportEnabled={me?.workspace.gapReportEnabled ?? false} />
      )}

      {/* Above recently deleted, and that order is the argument: somebody
          reading this because they are leaving should meet the way to take
          their work with them before anything else. Not gated on a role — an
          export is a read, and it contains only what this person could
          already see. */}
      <ExportWorkspaceSection workspaceId={me?.workspace.id} workspaceName={me?.workspace.name} />

      {/* Hidden from a viewer — `workspace_trash()` refuses them anyway, and a
          section that only ever 403s is worse than no section. False while
          `me` loads for the same reason. */}
      <RecentlyDeletedSection canWrite={canWrite} />
    </SettingsPage>
  );
}
