import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Team was a page of its own; it is the Members page under Settings now, next
 * to the rest of what an admin manages about the workspace.
 *
 * This route survives only as a redirect, so a bookmark, an open tab or the
 * "See the team" link in an old joined-the-workspace email lands where the
 * page went instead of on a blank screen.
 */
export const Route = createFileRoute("/_authed/team")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/members", replace: true });
  },
});
