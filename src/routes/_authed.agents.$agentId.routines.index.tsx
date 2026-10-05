import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { PageContainer, PageHeader } from "@/components/page-container";
import { RoutinesList } from "@/components/routines/routines-list";
import { CreateRoutineDialog } from "@/components/routines/create-routine-dialog";
import { DocsLink } from "@/components/docs-link";
import { api } from "@/lib/api-client";
import { useRoutines } from "@/hooks/use-routines";

// An index route, not `.routines.tsx`. As a plain `routines.tsx` this file
// would be the PARENT of routines.$routineId.tsx, and TanStack Router would
// render the detail page inside an <Outlet /> this list has no reason to own —
// so clicking a routine matched the URL and showed the list right back.
export const Route = createFileRoute("/_authed/agents/$agentId/routines/")({
  component: RoutinesTab,
  validateSearch: (search: Record<string, unknown>): { template?: string } => ({
    template: typeof search.template === "string" ? search.template : undefined,
  }),
});

function RoutinesTab() {
  const { agentId } = Route.useParams();
  const { template } = Route.useSearch();
  const navigate = useNavigate();
  const clearTemplate = () =>
    navigate({
      to: "/agents/$agentId/routines",
      params: { agentId },
      search: {},
      replace: true,
    });
  const { data: routines = [], isLoading } = useRoutines();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });

  const memberNames = Object.fromEntries(
    (me?.members ?? []).map((m) => [m.id, m.name ?? m.email ?? "a teammate"]),
  );

  return (
    <PageContainer width="list">
      <PageHeader
        badge="Routines"
        title="Work that happens"
        turn="while nobody is watching."
        action={
          <CreateRoutineDialog
            agentId={agentId}
            openTemplate={template}
            onTemplateConsumed={clearTemplate}
          />
        }
      >
        <DocsLink page="routines">
          What a routine can reach, and what it does with a secret
        </DocsLink>
      </PageHeader>
      {isLoading ? (
        <p className="mt-8 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <RoutinesList
          agentId={agentId}
          currentUserId={me?.user.id ?? null}
          memberNames={memberNames}
          routines={routines}
          action={
            <CreateRoutineDialog
              agentId={agentId}
              openTemplate={template}
              onTemplateConsumed={clearTemplate}
            />
          }
        />
      )}
    </PageContainer>
  );
}
