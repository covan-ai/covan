import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Configuration and Settings were two tabs for one agent: this one held every
 * editable field, the other three read-only facts and the delete button. They
 * are one page now, under Settings — the word people were already opening.
 *
 * This route survives only as a redirect, so a bookmark or an open tab lands
 * where the page went instead of on a blank screen.
 */
export const Route = createFileRoute("/_authed/agents/$agentId/configuration")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/agents/$agentId/settings", params });
  },
});
