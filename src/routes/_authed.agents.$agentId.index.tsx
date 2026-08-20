import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/agents/$agentId/")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/agents/$agentId/chat", params });
  },
});
