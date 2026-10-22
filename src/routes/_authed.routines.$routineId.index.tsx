import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RoutinePage } from "@/components/routines/routine-page";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authed/routines/$routineId/")({
  component: RoutineRoute,
});

function RoutineRoute() {
  const { routineId } = Route.useParams();
  const navigate = useNavigate();
  return (
    <div className="mx-auto w-full max-w-[760px] px-4 py-6 lg:px-6">
      <RoutinePage
        routineId={routineId}
        onDeleted={() => void navigate({ to: "/routines" })}
        notFoundAction={
          <Button asChild variant="secondary">
            <Link to="/routines">All routines</Link>
          </Button>
        }
      />
    </div>
  );
}
