import { createFileRoute, redirect } from "@tanstack/react-router";

/** An agent's settings are its Configuration tab now (A10). Kept for bookmarks. */
export const Route = createFileRoute("/_authed/agents/$agentId/settings")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/agents/$agentId/configuration", params, replace: true });
  },
});
