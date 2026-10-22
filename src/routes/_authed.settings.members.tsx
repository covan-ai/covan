import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * The members page is Team again (A3), top level in the sidebar. This route
 * survives as a redirect for bookmarks and old emails.
 */
export const Route = createFileRoute("/_authed/settings/members")({
  beforeLoad: () => {
    throw redirect({ to: "/team", replace: true });
  },
});
