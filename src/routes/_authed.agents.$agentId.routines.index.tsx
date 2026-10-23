import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { RoutinesPane } from "@/components/routines/routines-pane";
import { EmptyPage } from "@/components/empty-page";
import { Button } from "@/components/ui/button";
import { useRoutines } from "@/hooks/use-routines";
import { useAgentsStore } from "@/lib/agents-store";
import { useTranslation } from "@/i18n";

// An index route, not `.routines.tsx`: as a plain `routines.tsx` this file
// would be the PARENT of routines.$routineId.tsx, and the routine would render
// inside an <Outlet /> this list has no reason to own.
export const Route = createFileRoute("/_authed/agents/$agentId/routines/")({
  component: RoutinesTab,
  // An old `?template=` link still works: it opens the editor on it.
  validateSearch: (search: Record<string, unknown>): { template?: string } => ({
    template: typeof search.template === "string" ? search.template : undefined,
  }),
});

/**
 * An agent's Routines tab (A7, under the agent's bar): its own list, and its
 * first routine beside it — or what a routine is for, when it has none.
 */
function RoutinesTab() {
  const { t } = useTranslation();
  const { agentId } = Route.useParams();
  const { template } = Route.useSearch();
  const { canWrite } = useAgentsStore();
  const { data: routines = [], isLoading } = useRoutines();

  if (template) {
    return <Navigate to="/routines/new" search={{ agent: agentId, template }} replace />;
  }
  const first = routines.find((r) => r.agentId === agentId);
  if (!isLoading && first) {
    return (
      <Navigate
        to="/agents/$agentId/routines/$routineId"
        params={{ agentId, routineId: first.id }}
        replace
      />
    );
  }
  return (
    <div data-fill-screen className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <RoutinesPane
        agentId={agentId}
        hrefFor={(r) => `/agents/${agentId}/routines/${r.id}`}
        canCreate={canWrite}
      />
      <div className="min-w-0 flex-1">
        {!isLoading && (
          <EmptyPage
            title={t("No routines yet")}
            description={t(
              "A routine is work this agent does on its own: a weekly brief, a daily digest, a check when something arrives.",
            )}
            actions={
              canWrite ? (
                <Button asChild>
                  <Link to="/routines/new" search={{ agent: agentId }}>
                    {t("New routine")}
                  </Link>
                </Button>
              ) : undefined
            }
          />
        )}
      </div>
    </div>
  );
}
