import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import { useAgentsStore } from "@/lib/agents-store";
import { Button } from "@/components/ui/button";
import { EmptyWell } from "@/components/empty-page";
import { AgentTopBar } from "@/components/agent-top-bar";
import { TopBarSlotProvider } from "@/components/top-bar";

export const Route = createFileRoute("/_authed/agents/$agentId")({
  component: AgentLayout,
});

/**
 * Every page inside one agent. The shell around it is `_authed.tsx`'s, which
 * expands this agent in the sidebar from the path.
 */
function AgentLayout() {
  const { agentId } = Route.useParams();
  const { agents } = useAgentsStore();
  const agent = agents.find((a) => a.id === agentId);

  if (!agent) {
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        {/* One sentence for both, because the server gives one answer for
            both: an agent you cannot see and one that does not exist look the
            same from here, and saying which would say it exists. */}
        <EmptyWell
          title="Agent not found"
          description="This agent was deleted or isn't shared with you."
          actions={
            <Button asChild variant="outline">
              <Link to="/app">Back to home</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <TopBarSlotProvider>
      <div className="flex min-h-0 flex-1 flex-col">
        <AgentTopBar agent={agent} />
        <Outlet />
      </div>
    </TopBarSlotProvider>
  );
}
