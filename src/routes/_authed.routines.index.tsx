import { createFileRoute, Navigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import { EmptyPage } from "@/components/empty-page";

export const Route = createFileRoute("/_authed/routines/")({
  component: RoutinesIndex,
});

/** The first routine, or what a routine is for when there is none yet. */
function RoutinesIndex() {
  const { data: routines, isPending } = useQuery({
    queryKey: ["routines"],
    queryFn: () => api.routines.list(),
  });
  if (isPending) return null;
  const first = routines?.[0];
  if (first) return <Navigate to="/routines/$routineId" params={{ routineId: first.id }} replace />;
  return (
    <EmptyPage
      title="No routines yet"
      description="A routine is work an agent does on its own: a weekly brief, a daily digest, a check when something arrives. Make one from an agent's Routines tab."
    />
  );
}
