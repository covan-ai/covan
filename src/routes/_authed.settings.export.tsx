import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/components/section";
import { ExportWorkspaceSection } from "@/components/export-workspace-section";
import { RecentlyDeletedSection } from "@/components/recently-deleted-section";
import { useWorkspaceRole } from "@/lib/workspace-role";

export const Route = createFileRoute("/_authed/settings/export")({
  component: ExportSettingsPage,
  head: () => ({
    meta: [
      { title: "Export and deletion — Settings — Covan" },
      {
        name: "description",
        content: "Take your workspace with you, or bring back what was deleted.",
      },
    ],
  }),
});

/** "Nothing is held hostage" (A27): the export, the trash, and the end. */
function ExportSettingsPage() {
  const { me, canWrite } = useWorkspaceRole();
  return (
    <>
      <SectionTitle
        title="Export and deletion"
        lede="Nothing is held hostage. Take everything with you, bring back what was deleted by mistake, or end the workspace."
      />
      <ExportWorkspaceSection workspaceId={me?.workspace.id} workspaceName={me?.workspace.name} />
      {/* Recently deleted is the workspace's trash; a viewer cannot restore
          anything, and the server refuses them the list, so it hides itself. */}
      <div id="recently-deleted">
        <RecentlyDeletedSection canWrite={canWrite} />
      </div>
    </>
  );
}
