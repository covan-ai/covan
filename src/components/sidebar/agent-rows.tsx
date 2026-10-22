import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useAgentsStore, type Agent } from "@/lib/agents-store";
import { useInboxCounts } from "@/hooks/use-inbox";
import { AgentMark } from "@/components/agent-mark";
import { StatusDot } from "@/components/status-dot";
import { cn } from "@/lib/utils";
import { NAV_ROW, NAV_ROW_ON } from "./nav-rows";
import { ThreadRow } from "./thread-row";

/** How many of the open agent's threads the sidebar shows before "All threads". */
const SIDEBAR_THREADS = 8;

/**
 * The workspace's agents (DESIGN.md §6): one 32px row each, pinned ones
 * first, its unread count or a running dot on the right. The agent you are
 * in opens in place: New thread, its newest threads with a dot each, and All
 * threads.
 */
export function AgentRows({ agentId, onNavigate }: { agentId?: string; onNavigate?: () => void }) {
  const { agents, favorites } = useAgentsStore();
  const { data: counts } = useInboxCounts();
  const sorted = useMemo(
    () =>
      [...agents].sort(
        (a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)),
      ),
    [agents, favorites],
  );
  if (sorted.length === 0) return null;
  return (
    <nav aria-label="Agents" className="flex flex-col gap-0.5">
      {sorted.map((a) => {
        const c = counts?.byAgent[a.id];
        const open = a.id === agentId;
        return (
          <div key={a.id} className="flex flex-col gap-0.5">
            <Link
              to="/agents/$agentId/chat"
              params={{ agentId: a.id }}
              onClick={onNavigate}
              aria-expanded={open}
              className={cn(NAV_ROW, open && NAV_ROW_ON)}
            >
              <AgentMark agent={a} size={24} />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              {open ? (
                <ChevronDown className="size-3.5 shrink-0 text-micro-foreground" />
              ) : c && c.unread > 0 ? (
                <span className="text-xs font-medium text-muted-foreground">{c.unread}</span>
              ) : c && c.running > 0 ? (
                <StatusDot state="running" label={`${a.name} is working`} />
              ) : null}
            </Link>
            {open && <AgentThreads agent={a} onNavigate={onNavigate} />}
          </div>
        );
      })}
    </nav>
  );
}

function AgentThreads({ agent, onNavigate }: { agent: Agent; onNavigate?: () => void }) {
  const { sessions, startSession, deleteSession, renameSession, canWrite } = useAgentsStore();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activeId = useRouterState({ select: (s) => (s.location.search as { s?: string }).s });
  const [starting, setStarting] = useState(false);
  const threads = sessions
    .filter((s) => s.agentId === agent.id)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, SIDEBAR_THREADS);

  const start = async () => {
    if (starting) return;
    setStarting(true);
    try {
      const s = await startSession(agent.id);
      onNavigate?.();
      void navigate({
        to: "/agents/$agentId/chat",
        params: { agentId: agent.id },
        search: { s: s.id },
      });
    } catch {
      toast.error("Couldn't start a new thread.");
    } finally {
      setStarting(false);
    }
  };

  const remove = (id: string) => {
    deleteSession(id);
    if (activeId === id) {
      void navigate({ to: "/agents/$agentId/threads", params: { agentId: agent.id } });
    }
  };

  const sub =
    "flex h-[30px] items-center gap-2.5 rounded-md pl-10 text-meta text-muted-foreground hover:bg-sidebar-hover";

  return (
    <>
      {canWrite && (
        <button
          type="button"
          onClick={() => void start()}
          disabled={starting}
          className={cn(sub, "text-left")}
        >
          <Plus className="size-3.5 shrink-0" strokeWidth={1.75} />
          <span>New thread</span>
        </button>
      )}
      {threads.map((s) => (
        <ThreadRow
          key={s.id}
          session={s}
          active={s.id === activeId}
          mine={s.ownerId === me?.user.id}
          onRename={renameSession}
          onDelete={remove}
          onChanged={() => void queryClient.invalidateQueries({ queryKey: ["sessions"] })}
          onNavigate={onNavigate}
        />
      ))}
      <Link
        to="/agents/$agentId/threads"
        params={{ agentId: agent.id }}
        onClick={onNavigate}
        className={sub}
      >
        All threads
      </Link>
    </>
  );
}
