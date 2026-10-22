import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { TopBar } from "@/components/top-bar";
import { Tabs } from "@/components/tabs";
import { Chip } from "@/components/chip";
import { AgentMark } from "@/components/agent-mark";
import { ShareAgentDialog } from "@/components/share-agent-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { canManageAgent, sharingWords } from "@/lib/agent-access";
import { useAgentsStore, type Agent } from "@/lib/agents-store";

/**
 * The bar over every page inside an agent (A2, A10, A32): its mark and name,
 * the four tabs — Threads is lit on a thread too — who it is shared with,
 * Share for whoever may, and the agent's menu. A page puts its own actions
 * into the bar's slot through `TopBarPortal`.
 */
export function AgentTopBar({ agent }: { agent: Agent }) {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { favorites, toggleFavorite, startBrainstorm, deleteAgent, canWrite } = useAgentsStore();
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const canManage = canManageAgent(agent);
  const base = `/agents/${agent.id}`;
  const pinned = favorites.includes(agent.id);

  const brainstorm = async () => {
    try {
      const s = await startBrainstorm(agent.id);
      void navigate({
        to: "/agents/$agentId/chat",
        params: { agentId: agent.id },
        search: { s: s.id },
      });
    } catch {
      toast.error("Couldn't start a brainstorm.");
    }
  };

  return (
    <>
      <TopBar
        leading={<AgentMark agent={agent} size={24} />}
        title={agent.name}
        slot
        tabs={
          <Tabs
            label="Agent pages"
            items={[
              { href: `${base}/threads`, label: "Threads", activeAlso: [`${base}/chat`] },
              { href: `${base}/knowledge`, label: "Knowledge" },
              { href: `${base}/routines`, label: "Routines" },
              { href: `${base}/configuration`, label: "Configuration" },
            ]}
          />
        }
        actions={
          <>
            <Chip>{sharingWords(agent)}</Chip>
            {canManage && (
              <Button
                variant="secondary"
                onClick={() => setShareOpen(true)}
                data-coach="share-agent"
              >
                Share
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`More for ${agent.name}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => toggleFavorite(agent.id)}>
                  {pinned ? "Unpin" : "Pin to the top"}
                </DropdownMenuItem>
                {canWrite && (
                  <DropdownMenuItem onClick={() => void brainstorm()}>
                    New brainstorm
                  </DropdownMenuItem>
                )}
                {!pathname.startsWith(`${base}/configuration`) && (
                  <DropdownMenuItem
                    onClick={() =>
                      void navigate({
                        to: "/agents/$agentId/configuration",
                        params: { agentId: agent.id },
                      })
                    }
                  >
                    Configuration
                  </DropdownMenuItem>
                )}
                {canManage && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => setDeleteOpen(true)}
                    >
                      Delete agent
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      {canManage && <ShareAgentDialog agent={agent} open={shareOpen} onOpenChange={setShareOpen} />}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This takes it away from everyone it's shared with, along with every thread and routine
              attached to it — including private ones. It waits 30 days in Settings › Export and
              deletion, and comes back whole if you restore it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="danger"
              onClick={() => {
                deleteAgent(agent.id);
                void navigate({ to: "/app" });
              }}
            >
              Delete {agent.name}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
