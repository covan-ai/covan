import { createFileRoute } from "@tanstack/react-router";
import { PageBody } from "@/components/page";
import { ThreadsTable } from "@/components/threads-table";

export const Route = createFileRoute("/_authed/agents/$agentId/threads")({
  component: AgentThreadsPage,
});

/** One agent's threads (A5 under the agent's Threads tab). */
function AgentThreadsPage() {
  const { agentId } = Route.useParams();
  return (
    <PageBody width="table" className="lg:pt-5">
      <ThreadsTable key={agentId} agentId={agentId} />
    </PageBody>
  );
}
