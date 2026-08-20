import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useAgentsStore } from "@/lib/agents-store";
import { PageContainer, PageHeader, SectionHeading } from "@/components/page-container";
import { SectionCard } from "@/components/section-card";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";

export const Route = createFileRoute("/_authed/agents/$agentId/settings")({
  component: SettingsTab,
});

function SettingsTab() {
  const { agentId } = Route.useParams();
  const { agents, deleteAgent } = useAgentsStore();
  const navigate = useNavigate();
  const agent = agents.find((a) => a.id === agentId)!;

  return (
    <PageContainer width="form">
      <PageHeader badge="Agent settings" title="Facts, and one" turn="irreversible button." />

      <section className="mt-8">
        <SectionHeading title="Details" />
        <SectionCard padded={false} className="mt-3 overflow-hidden">
          <dl className="divide-y divide-hairline">
            <div className="flex items-center gap-4 px-5 py-3.5">
              <dt className="w-28 shrink-0 text-sm text-muted-foreground">Agent ID</dt>
              <dd className="min-w-0 flex-1 truncate font-mono text-xs">{agent.id}</dd>
            </div>
            <div className="flex items-center gap-4 px-5 py-3.5">
              <dt className="w-28 shrink-0 text-sm text-muted-foreground">Created</dt>
              <dd className="min-w-0 flex-1 truncate text-sm">
                {new Date(agent.createdAt).toLocaleString()}
              </dd>
            </div>
            <div className="flex items-center gap-4 px-5 py-3.5">
              <dt className="w-28 shrink-0 text-sm text-muted-foreground">Visibility</dt>
              <dd className="min-w-0 flex-1 truncate text-sm">Shared with the whole workspace</dd>
            </div>
          </dl>
        </SectionCard>
      </section>

      <section className="mt-10">
        <SectionHeading
          title="Danger zone"
          description="Deleting the agent removes it for the entire team, along with everyone's private chats."
        />
        <SectionCard className="mt-3 flex items-center justify-between gap-4 border-destructive/30">
          <div className="min-w-0">
            <div className="text-sm font-semibold">Delete {agent.name}</div>
            <p className="mt-0.5 text-sm text-muted-foreground">This cannot be undone.</p>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                Delete agent
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the shared agent and every chat the team has had with it. This cannot
                  be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => {
                    deleteAgent(agent.id);
                    toast.success("Agent deleted");
                    navigate({ to: "/app" });
                  }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </SectionCard>
      </section>
    </PageContainer>
  );
}
