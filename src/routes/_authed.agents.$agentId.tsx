import { Outlet, createFileRoute } from "@tanstack/react-router";
import { AgentWorkspace } from "@/components/agent-workspace";

export const Route = createFileRoute("/_authed/agents/$agentId")({
  component: AgentLayout,
});

function AgentLayout() {
  const { agentId } = Route.useParams();
  return (
    <AgentWorkspace agentId={agentId}>
      <Outlet />
    </AgentWorkspace>
  );
}
