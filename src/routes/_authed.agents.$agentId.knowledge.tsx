import { createFileRoute } from "@tanstack/react-router";
import { AgentKnowledge } from "@/components/agent-knowledge";
import { useAgentsStore } from "@/lib/agents-store";

export const Route = createFileRoute("/_authed/agents/$agentId/knowledge")({
  component: KnowledgeTab,
});

/**
 * What this agent reads (A32). The folders belong to the workspace and their
 * files are on the Knowledge page; this tab is only the question that is
 * genuinely about the agent — which of them it looks at.
 */
function KnowledgeTab() {
  const { agentId } = Route.useParams();
  const { agents } = useAgentsStore();
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return null;
  return <AgentKnowledge key={agent.id} agent={agent} />;
}
