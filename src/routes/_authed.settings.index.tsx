import { createFileRoute, redirect } from "@tanstack/react-router";

/** `/settings` has no page of its own: it opens on the workspace's General. */
export const Route = createFileRoute("/_authed/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/general", replace: true });
  },
});
