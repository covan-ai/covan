import { createFileRoute, Link } from "@tanstack/react-router";
import { SectionLabel, SectionTitle } from "@/components/section";
import { Field } from "@/components/field";
import { Button } from "@/components/ui/button";
import { ExportWorkspaceSection } from "@/components/export-workspace-section";
import { RecentlyDeletedSection } from "@/components/recently-deleted-section";
import { useWorkspaceRole } from "@/lib/workspace-role";

export const Route = createFileRoute("/_authed/settings/export")({
  component: ExportSettingsPage,
  // `?download=<id>`: the link in the "your export is ready" email.
  validateSearch: (search: Record<string, unknown>): { download?: string } => ({
    download: typeof search.download === "string" ? search.download : undefined,
  }),
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
  const { me, canWrite, isAdmin } = useWorkspaceRole();
  const { download } = Route.useSearch();
  return (
    <>
      <SectionTitle
        title="Export and deletion"
        lede="Nothing is held hostage. Take everything with you, bring back what was deleted by mistake, or end the workspace."
      />
      <div className="mt-5">
        <ExportWorkspaceSection
          workspaceId={me?.workspace.id}
          isAdmin={isAdmin}
          highlight={download}
        />
        {/* Recently deleted is the workspace's trash; a viewer cannot restore
            anything, and the server refuses them the list, so it hides itself. */}
        <RecentlyDeletedSection canWrite={canWrite} />
        <SectionLabel>Delete the workspace</SectionLabel>
        <Field
          label={`Delete ${me?.workspace.name ?? "the workspace"}`}
          help="Every member is told today. The workspace stays readable for 14 days, then every agent, thread and document is removed. Request an export first."
        >
          <Button asChild variant="danger">
            <Link to="/settings/general">Delete {me?.workspace.name ?? "the workspace"}…</Link>
          </Button>
          <p className="mt-2 text-meta text-muted-foreground">
            Owners and admins only. Typing the workspace name is asked in the next step.
          </p>
        </Field>
      </div>
    </>
  );
}
