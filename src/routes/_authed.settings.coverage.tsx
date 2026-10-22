import { createFileRoute } from "@tanstack/react-router";
import { SectionTitle } from "@/components/section";
import { WorkspaceCoverageSection } from "@/components/workspace-coverage-section";
import { useWorkspaceRole } from "@/lib/workspace-role";

export const Route = createFileRoute("/_authed/settings/coverage")({
  component: CoverageSettingsPage,
  head: () => ({
    meta: [
      { title: "Coverage — Settings — Covan" },
      { name: "description", content: "What your team asked that nothing written down answered." },
    ],
  }),
});

/**
 * What the team asked that nothing written was close to (A18). An admin's:
 * the counts cross private threads (0053), so the functions behind them
 * refuse anybody else, and the page says so rather than showing nothing.
 */
function CoverageSettingsPage() {
  const { me, isAdmin } = useWorkspaceRole();
  return (
    <>
      <SectionTitle
        title="Coverage"
        lede="What the team asked that nothing written was close to. Counts by agent and by window, never the questions themselves and never who asked."
      />
      {me && !isAdmin ? (
        <p className="mt-8 text-sm text-muted-foreground">
          Coverage is an admin's: its counts include every thread in the workspace.
        </p>
      ) : (
        <div className="mt-8">
          <WorkspaceCoverageSection gapReportEnabled={me?.workspace.gapReportEnabled ?? false} />
        </div>
      )}
    </>
  );
}
