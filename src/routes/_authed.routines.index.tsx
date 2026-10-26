import { createFileRoute, Link, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { EmptyPage } from "@/components/empty-page";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

export const Route = createFileRoute("/_authed/routines/")({
  component: RoutinesIndex,
});

/** The first routine, or what a routine is for when there is none yet. */
function RoutinesIndex() {
  const { t } = useTranslation();
  const { data: routines, isPending } = useQuery({
    queryKey: ["routines"],
    queryFn: () => api.routines.list(),
  });
  if (isPending) return null;
  const first = routines?.[0];
  if (first) return <Navigate to="/routines/$routineId" params={{ routineId: first.id }} replace />;
  return (
    <EmptyPage
      title={t("No routines yet")}
      description={t(
        "A routine is work an agent does on its own: a weekly brief, a daily digest, a check when something arrives. Start from a use case, or from what arrives in your inbox.",
      )}
      actions={
        <>
          {/* The use cases first: picking one needs nothing connected. */}
          <Button asChild>
            <Link to="/routines/use-cases">{t("Browse use cases")}</Link>
          </Button>
          {/* 0139: the routines worth having are usually in the mail already. */}
          <Button asChild variant="secondary">
            <Link to="/arrivals">{t("See what arrives in your inbox")}</Link>
          </Button>
        </>
      }
    />
  );
}
