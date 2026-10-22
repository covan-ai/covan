import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import { RoutinePage } from "@/components/routines/routine-page";

export const Route = createFileRoute("/_authed/agents/$agentId/routines/$routineId")({
  component: RoutineDetailPage,
});

function RoutineDetailPage() {
  const { agentId, routineId } = Route.useParams();
  const navigate = useNavigate();
  return (
    <PageContainer width="list">
      <Link
        to="/agents/$agentId/routines"
        params={{ agentId }}
        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Routines
      </Link>
      <div className="mt-4">
        <RoutinePage
          routineId={routineId}
          onDeleted={() => void navigate({ to: "/agents/$agentId/routines", params: { agentId } })}
          notFoundAction={
            <Button asChild variant="outline">
              <Link to="/agents/$agentId/routines" params={{ agentId }}>
                Back to routines
              </Link>
            </Button>
          }
        />
      </div>
    </PageContainer>
  );
}
