import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RoutineEditor } from "@/components/routines/routine-editor";
import { EmptyPage } from "@/components/empty-page";
import { Button } from "@/components/ui/button";
import { useRoutines } from "@/hooks/use-routines";

export const Route = createFileRoute("/_authed/routines/$routineId/edit")({
  component: EditRoutine,
});

/** A routine, changed (A28) — a sibling of its page, not inside it. */
function EditRoutine() {
  const { routineId } = Route.useParams();
  const navigate = useNavigate();
  const { data: routines = [], isLoading } = useRoutines();
  if (isLoading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  const routine = routines.find((r) => r.id === routineId);
  if (!routine) {
    return (
      <EmptyPage
        title="Routine not found"
        description="It may have been deleted, or the link points at another workspace."
        actions={
          <Button asChild variant="secondary">
            <Link to="/routines">All routines</Link>
          </Button>
        }
      />
    );
  }
  return (
    <RoutineEditor
      // Remounted per routine, so a half-made edit of one never shows on another.
      key={routine.id}
      routine={routine}
      cancelTo={`/routines/${routine.id}`}
      onSaved={(id) => void navigate({ to: "/routines/$routineId", params: { routineId: id } })}
    />
  );
}
