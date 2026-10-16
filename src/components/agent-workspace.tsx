import { Link, Outlet } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useAgentsStore } from "@/lib/agents-store";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/section-card";

/**
 * The frame around an agent's pages. The shell itself draws the agent's panel
 * — its pages and its threads — once it is told which agent this is; this only
 * answers for the one it cannot draw.
 */
export function AgentWorkspace({ agentId, children }: { agentId: string; children?: ReactNode }) {
  const { agents } = useAgentsStore();
  const agent = agents.find((a) => a.id === agentId);

  if (!agent) {
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        {/* One sentence for both, because the server gives one answer for
            both: an agent you cannot see and one that does not exist look the
            same from here, and saying which would say it exists. */}
        <EmptyState
          title="Agent not found"
          description="This agent was deleted or isn't shared with you."
          action={
            <Button asChild variant="outline">
              <Link to="/app">Back to home</Link>
            </Button>
          }
        />
      </div>
    );
  }

  return <AppShell agentId={agentId}>{children ?? <Outlet />}</AppShell>;
}
