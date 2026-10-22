import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { RoutinesPane } from "@/components/routines/routines-pane";
import { TopBarSlotProvider } from "@/components/top-bar";

export const Route = createFileRoute("/_authed/routines")({
  component: RoutinesLayout,
  head: () => ({ meta: [{ title: "Routines — Covan" }] }),
});

/** Routines (A7): the list on the left, the routine on the right. */
function RoutinesLayout() {
  const selectedId = useRouterState({
    select: (s) => /^\/routines\/([^/]+)/.exec(s.location.pathname)?.[1],
  });
  return (
    <TopBarSlotProvider>
      <div className="flex min-h-dvh flex-col lg:flex-row">
        <RoutinesPane selectedId={selectedId} hrefFor={(r) => `/routines/${r.id}`} />
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </TopBarSlotProvider>
  );
}
