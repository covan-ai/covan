import { createFileRoute } from "@tanstack/react-router";
import { AgentConfigurationForm } from "@/components/agent-configuration-form";
import { useAgentsStore } from "@/lib/agents-store";

export const Route = createFileRoute("/_authed/agents/$agentId/configuration")({
  component: ConfigurationTab,
});

/**
 * An agent's Configuration (A10). Switching to a different agent remounts the
 * form (`key`), which is the only event that should discard a half-typed edit:
 * a refresh of the store — the write-back from Save, another tab — must not.
 */
function ConfigurationTab() {
  const { agentId } = Route.useParams();
  const { agents } = useAgentsStore();
  const agent = agents.find((a) => a.id === agentId);
  if (!agent) return null;
  return <AgentConfigurationForm key={agent.id} agent={agent} />;
}
