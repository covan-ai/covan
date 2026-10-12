import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * `/settings` has no page of its own. It goes to your account, which is what
 * it showed first before the area had pages, so a bookmark or the old link in
 * somebody's head still lands somewhere that makes sense.
 */
export const Route = createFileRoute("/_authed/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/account", replace: true });
  },
});
