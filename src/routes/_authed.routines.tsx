import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { RoutinesPane } from "@/components/routines/routines-pane";
import { TopBarSlotProvider } from "@/components/top-bar";
import { useAgentsStore } from "@/lib/agents-store";

export const Route = createFileRoute("/_authed/routines")({
  component: RoutinesLayout,
  head: () => ({ meta: [{ title: "Routines — Covan" }] }),
});

/** Routines (A7): the list on the left, the routine on the right. */
function RoutinesLayout() {
  const { canWrite } = useAgentsStore();
  const selectedId = useRouterState({
    select: (s) => /^\/routines\/([^/]+)/.exec(s.location.pathname)?.[1],
  });
  return (
    <TopBarSlotProvider>
      {/* A window (A7): the list and the routine each scroll on their own. */}
      <div data-fill-screen className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <RoutinesPane
          selectedId={selectedId}
          hrefFor={(r) => `/routines/${r.id}`}
          canCreate={canWrite}
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </div>
      </div>
    </TopBarSlotProvider>
  );
}
