import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import {
  ArrowLeft,
  MessageSquare,
  Sliders,
  BookOpen,
  Repeat,
  Settings,
  Menu,
  X,
  Trash2,
  PanelLeft,
  SquarePen,
  Sparkles,
  Users,
} from "lucide-react";
import { useAgentsStore } from "@/lib/agents-store";
import { AgentAvatar } from "@/components/avatars";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/section-card";
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

export function AgentWorkspace({ agentId, children }: { agentId: string; children?: ReactNode }) {
  const { agents, sessions, deleteAgent, startSession, startBrainstorm, deleteSession } =
    useAgentsStore();
  const agent = agents.find((a) => a.id === agentId);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeSessionId = useRouterState({
    select: (s) => (s.location.search as { s?: string }).s,
  });
  const navigate = useNavigate();
  const [open, setOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(false); // desktop rail

  if (!agent) {
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        <EmptyState
          title="Agent not found"
          description="It may have been deleted by another admin, or the link is stale."
          action={
            <Button asChild variant="outline">
              <Link to="/app">Back to home</Link>
            </Button>
          }
        />
      </div>
    );
  }

  const agentSessions = sessions
    .filter((s) => s.agentId === agentId)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const sharedSessions = agentSessions.filter((s) => s.visibility === "shared");
  const mySessions = agentSessions.filter((s) => s.visibility === "private");

  const nav = [
    { to: "/agents/$agentId/chat", label: "Chat", icon: MessageSquare },
    { to: "/agents/$agentId/configuration", label: "Configuration", icon: Sliders },
    { to: "/agents/$agentId/knowledge", label: "Knowledge", icon: BookOpen },
    { to: "/agents/$agentId/routines", label: "Routines", icon: Repeat },
    { to: "/agents/$agentId/settings", label: "Settings", icon: Settings },
  ] as const;

  const openChat = (sessionId?: string) => {
    navigate({ to: "/agents/$agentId/chat", params: { agentId }, search: { s: sessionId } });
    setOpen(false);
  };

  const newChat = () => {
    void startSession(agentId).then((s) => openChat(s.id));
  };

  const newBrainstorm = () => {
    void startBrainstorm(agentId).then((s) => openChat(s.id));
  };

  const removeSession = (id: string) => {
    const remaining = agentSessions.filter((s) => s.id !== id);
    deleteSession(id);
    if (activeSessionId === id) openChat(remaining[0]?.id);
  };

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-sidebar-border bg-sidebar transition-all lg:translate-x-0",
          collapsed ? "lg:w-16" : "lg:w-64",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* Top: back to library + collapse toggle */}
        <div
          className={cn(
            "flex items-center gap-2 border-b border-sidebar-border px-3 py-3",
            collapsed ? "lg:flex-col" : "justify-between",
          )}
        >
          <Link
            to="/app"
            title="All agents"
            className={cn(
              "inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground",
              collapsed && "lg:hidden",
            )}
          >
            <ArrowLeft className="h-3.5 w-3.5" /> All agents
          </Link>
          <button
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label="Toggle sidebar"
            className="hidden h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground lg:grid"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        </div>

        {/* Agent identity — the gradient avatar is the same one the gallery
            shows, so an agent reads as the same thing everywhere. */}
        <div className={cn("flex items-center gap-3 px-3 py-3", collapsed && "lg:justify-center")}>
          <AgentAvatar emoji={agent.emoji} tone="accent" className="h-9 w-9 text-lg" />
          <div className={cn("min-w-0", collapsed && "lg:hidden")}>
            <div className="truncate font-dm text-[17px] font-medium leading-tight">
              {agent.name}
            </div>
            <div className="mt-1 truncate text-[13px] leading-tight text-muted-foreground">
              {agent.model}
            </div>
          </div>
        </div>

        {/* New chat — primary CTA, matching the main app rail. */}
        <div className="space-y-0.5 px-3">
          <Button
            onClick={newChat}
            title="New chat"
            className={cn("w-full justify-start gap-2", collapsed && "lg:justify-center lg:px-0")}
          >
            <SquarePen className="h-4 w-4 shrink-0" />
            <span className={cn(collapsed && "lg:hidden")}>New chat</span>
          </Button>
          <button
            type="button"
            onClick={newBrainstorm}
            title="New brainstorm"
            className={cn(
              "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
              collapsed && "lg:justify-center lg:px-0",
            )}
          >
            <Sparkles className="h-4 w-4 shrink-0" />
            <span className={cn(collapsed && "lg:hidden")}>New brainstorm</span>
          </button>
        </div>

        {/* Tabs */}
        <nav className="mt-2 space-y-0.5 px-3">
          {nav.map((n) => {
            const href = n.to.replace("$agentId", agentId);
            const active = pathname === href || pathname.startsWith(href + "/");
            const Icon = n.icon;
            return (
              <Link
                key={n.to}
                to={n.to}
                params={{ agentId }}
                title={n.label}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-200",
                  collapsed && "lg:justify-center lg:px-0",
                  active
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                <span className={cn(collapsed && "lg:hidden")}>{n.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Chat history */}
        <div className={cn("mt-4 flex min-h-0 flex-1 flex-col px-3", collapsed && "lg:hidden")}>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-2">
            {sharedSessions.length > 0 && (
              <div className="space-y-0.5">
                <div className="px-3 pb-0.5 text-xs font-semibold uppercase tracking-[0.06em] text-micro-foreground">
                  Shared with the team
                </div>
                <div className="space-y-0.5">
                  {sharedSessions.map((s) => (
                    <div
                      key={s.id}
                      className={cn(
                        "group flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-200",
                        s.id === activeSessionId
                          ? "bg-sidebar-accent text-sidebar-accent-foreground"
                          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                      )}
                    >
                      <button
                        onClick={() => openChat(s.id)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-left"
                      >
                        <Users className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">
                          {s.kind === "brainstorm" && <span className="mr-1">🧠</span>}
                          {s.title || (s.kind === "brainstorm" ? "New brainstorm" : "New chat")}
                        </span>
                      </button>
                      <button
                        onClick={() => removeSession(s.id)}
                        className="shrink-0 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                        aria-label="Delete chat"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-0.5">
              <div className="px-3 pb-0.5 text-xs font-semibold uppercase tracking-[0.06em] text-micro-foreground">
                Private to you
              </div>
              {mySessions.length === 0 ? (
                <p className="px-3 py-1 text-xs text-sidebar-foreground/50">No chats yet.</p>
              ) : (
                mySessions.map((s) => (
                  <div
                    key={s.id}
                    className={cn(
                      "group flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors duration-200",
                      s.id === activeSessionId
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                    )}
                  >
                    <button
                      onClick={() => openChat(s.id)}
                      className="min-w-0 flex-1 truncate text-left"
                    >
                      {s.kind === "brainstorm" && <span className="mr-1">🧠</span>}
                      {s.title || (s.kind === "brainstorm" ? "New brainstorm" : "New chat")}
                    </button>
                    <button
                      onClick={() => removeSession(s.id)}
                      className="shrink-0 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      aria-label="Delete chat"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Spacer keeps the footer pinned to the bottom when the history is hidden */}
        {collapsed && <div className="hidden flex-1 lg:block" />}

        {/* Delete agent */}
        <div className="border-t border-sidebar-border p-3">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button
                title="Delete agent"
                className={cn(
                  "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-sidebar-accent/60 hover:text-destructive",
                  collapsed && "lg:justify-center lg:px-0",
                )}
              >
                <Trash2 className="h-4 w-4 shrink-0" />
                <span className={cn(collapsed && "lg:hidden")}>Delete agent</span>
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This removes the shared agent and all private chats across the team. This cannot
                  be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => {
                    deleteAgent(agentId);
                    toast.success("Agent deleted");
                    navigate({ to: "/app" });
                  }}
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </aside>

      {open && (
        <div
          className="fixed inset-0 z-30 bg-foreground/20 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      <div className={cn("transition-all", collapsed ? "lg:pl-16" : "lg:pl-64")}>
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur lg:hidden">
          <button
            className="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle navigation"
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <span>{agent.emoji}</span>
            <span className="truncate">{agent.name}</span>
          </div>
        </header>
        <main>{children ?? <Outlet />}</main>
      </div>
    </div>
  );
}
