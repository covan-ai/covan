import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Plus, SquarePen } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentMark } from "@/components/agent-mark";
import { useAgentsStore } from "@/lib/agents-store";
import { useShell } from "@/lib/shell";

/**
 * "New thread" (A4, A5): a fresh thread with the agent you pick, opened at
 * once. With one agent there is nothing to pick; with none it offers to make
 * one, for somebody who may.
 */
export function NewThreadButton({
  agentId,
  variant = "default",
  iconOnly = false,
}: {
  /** Start with this agent, without asking. */
  agentId?: string;
  variant?: "default" | "secondary" | "ghost";
  iconOnly?: boolean;
}) {
  const { t } = useTranslation();
  const { agents, startSession, canWrite } = useAgentsStore();
  const shell = useShell();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);

  const start = async (id: string) => {
    if (pending) return;
    setPending(true);
    try {
      const session = await startSession(id);
      void navigate({
        to: "/agents/$agentId/chat",
        params: { agentId: id },
        search: { s: session.id },
      });
    } catch {
      toast.error(t("Couldn't start a new thread."));
    } finally {
      setPending(false);
    }
  };

  const label = iconOnly ? (
    <SquarePen aria-label={t("New thread")} />
  ) : (
    <>
      <Plus /> {t("New thread")}
    </>
  );
  const size = iconOnly ? "icon" : "default";

  if (agentId || agents.length === 1) {
    return (
      <Button
        variant={variant}
        size={size}
        disabled={pending || !canWrite}
        onClick={() => void start(agentId ?? agents[0]!.id)}
      >
        {label}
      </Button>
    );
  }
  if (agents.length === 0) {
    if (!canWrite) return null;
    return (
      <Button variant={variant} size={size} onClick={() => shell.openCreateAgent()}>
        {iconOnly ? (
          <Plus aria-label={t("New agent")} />
        ) : (
          <>
            <Plus /> {t("New agent")}
          </>
        )}
      </Button>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant={variant} size={size} disabled={pending || !canWrite}>
          {label}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="text-xs font-medium tracking-[0.06em] text-micro-foreground uppercase">
          {t("Start a thread with")}
        </DropdownMenuLabel>
        <div className="max-h-72 overflow-y-auto">
          {agents.map((a) => (
            <DropdownMenuItem key={a.id} onClick={() => void start(a.id)}>
              <AgentMark agent={a} size={24} />
              <span className="flex-1 truncate">{a.name}</span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
