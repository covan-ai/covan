import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RoutinesPane } from "@/components/routines/routines-pane";
import { RoutinePage } from "@/components/routines/routine-page";
import { Button } from "@/components/ui/button";
import { useAgentsStore } from "@/lib/agents-store";
import { useTranslation } from "@/i18n";

export const Route = createFileRoute("/_authed/agents/$agentId/routines/$routineId")({
  component: AgentRoutinePage,
});

/** One of an agent's routines, beside the agent's own list (A7, under the agent's bar). */
function AgentRoutinePage() {
  const { t } = useTranslation();
  const { agentId, routineId } = Route.useParams();
  const navigate = useNavigate();
  const { canWrite } = useAgentsStore();
  return (
    <div data-fill-screen className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <RoutinesPane
        agentId={agentId}
        selectedId={routineId}
        hrefFor={(r) => `/agents/${agentId}/routines/${r.id}`}
        canCreate={canWrite}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <RoutinePage
          routineId={routineId}
          onDeleted={() => void navigate({ to: "/agents/$agentId/routines", params: { agentId } })}
          notFoundAction={
            <Button asChild variant="secondary">
              <Link to="/agents/$agentId/routines" params={{ agentId }}>
                {t("Back to routines")}
              </Link>
            </Button>
          }
        />
      </div>
    </div>
  );
}
