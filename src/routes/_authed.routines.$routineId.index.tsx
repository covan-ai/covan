import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { RoutinePage } from "@/components/routines/routine-page";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

export const Route = createFileRoute("/_authed/routines/$routineId/")({
  component: RoutineRoute,
});

/** One routine beside the list (A7). */
function RoutineRoute() {
  const { t } = useTranslation();
  const { routineId } = Route.useParams();
  const navigate = useNavigate();
  return (
    <RoutinePage
      routineId={routineId}
      onDeleted={() => void navigate({ to: "/routines" })}
      notFoundAction={
        <Button asChild variant="secondary">
          <Link to="/routines">{t("All routines")}</Link>
        </Button>
      }
    />
  );
}
