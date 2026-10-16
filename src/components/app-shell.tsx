import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Settings,
  Menu,
  X,
  Sun,
  Moon,
  ChevronsUpDown,
  User,
  LogOut,
  Search,
  Check,
  Plus,
  PenSquare,
  Monitor,
  PanelLeft,
  Sparkles,
  Repeat,
  Trash2,
  Users,
  SlidersHorizontal,
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { CreditsBadge } from "@/components/credits-badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";
import { BrandMark } from "@/components/brand-mark";
import { AgentAvatar, UserAvatar } from "@/components/avatars";
import { SessionRow } from "@/components/session-row";
import { ShareAgentDialog } from "@/components/share-agent-dialog";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { useAgentsStore, type Agent } from "@/lib/agents-store";
import { canManageAgent } from "@/lib/agent-access";
import { invalidateWorkspaceScoped } from "@/lib/workspace-queries";
import { DOCS_HOME } from "@/lib/docs";
import { IncomingInvitesBanner } from "@/components/incoming-invites-banner";
import { FeedbackButton } from "@/components/feedback-button";
import { PANEL_NAV, pageLabel, primaryNavMatch } from "@/components/primary-nav";

/**
 * The frame around every signed-in screen: a narrow rail of agents on the far
 * left, a panel beside it that changes with where you are, and the page.
 *
 * The rail is what never changes: the brand, search, settings and the account.
 * The panel is the context: inside an agent it lists that agent's pages and
 * threads; on a workspace page it lists the workspace's pages and its agents. Both panels end in the same footer,
 * so credits and feedback are in one place wherever you are.
 *
 * `agentId` puts the shell in agent context. The agent routes pass it; the
 * workspace routes do not.
 */
export function AppShell({ agentId, children }: { agentId?: string; children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false); // phone drawer
  const [collapsed, setCollapsed] = useState(false); // desktop panel
  const navigate = useNavigate();

  const queryClient = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.workspaces.list(),
  });
  const { agents } = useAgentsStore();
  const agent = agentId ? agents.find((a) => a.id === agentId) : undefined;
  const workspaceName = me?.workspace.name;

  const switchWorkspace = async (workspaceId: string) => {
    if (workspaceId === me?.workspace.id) return;
    try {
      await api.workspace.setActive(workspaceId);
      await invalidateWorkspaceScoped(queryClient);
    } catch {
      toast.error("Couldn't switch workspace.");
    }
  };

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const createWorkspace = async () => {
    const name = newName.trim();
    if (!name || creating) return;
    setCreating(true);
    try {
      await api.workspaces.create(name);
      // The RPC already made the new workspace active; refresh everything the
      // switcher would refresh so the app rebinds to the new workspace.
      await invalidateWorkspaceScoped(queryClient);
      setCreateOpen(false);
      setNewName("");
      toast.success("Workspace created");
      navigate({ to: "/app" });
    } catch {
      toast.error("Couldn't create workspace.");
    } finally {
      setCreating(false);
    }
  };

  const signOut = async () => {
    await supabase.auth.signOut();
    toast.success("Signed out");
    navigate({ to: "/sign-in" });
  };

  const close = () => setOpen(false);

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex transition-transform lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* The rail: brand, agents, and the three things that are the same
            on every screen. */}
        <aside className="flex w-14 flex-col items-center border-r border-sidebar-border bg-sidebar py-2">
          <Link
            to="/app"
            onClick={close}
            title="Home"
            aria-label="Home"
            className="grid h-10 w-10 place-items-center rounded-md transition-colors duration-200 hover:bg-sidebar-accent/60"
          >
            <BrandMark className="h-7 w-7" />
          </Link>

          <div className="mt-auto flex flex-col items-center gap-1">
            <button
              onClick={() => setCollapsed((v) => !v)}
              title={collapsed ? "Show sidebar" : "Hide sidebar"}
              aria-label="Toggle sidebar"
              className="hidden h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors duration-200 hover:bg-sidebar-accent/60 hover:text-foreground lg:grid"
            >
              <PanelLeft className="h-4 w-4" />
            </button>
            <button
              onClick={() => {
                close();
                window.dispatchEvent(new Event("open-command-palette"));
              }}
              title="Search ⌘K"
              aria-label="Open command palette"
              className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground transition-colors duration-200 hover:bg-sidebar-accent/60 hover:text-foreground"
            >
              <Search className="h-4 w-4" />
            </button>
            <Link
              to="/settings"
              onClick={close}
              title="Settings"
              aria-label="Settings"
              className={cn(
                "grid h-9 w-9 place-items-center rounded-md transition-colors duration-200 hover:bg-sidebar-accent/60 hover:text-foreground",
                !agentId && primaryNavMatch(pathname)?.to === "/settings"
                  ? "text-foreground"
                  : "text-muted-foreground",
              )}
            >
              <Settings className="h-4 w-4" />
            </Link>
            <AccountMenu
              name={me?.user.name}
              email={me?.user.email}
              avatarUrl={me?.user.avatarUrl}
              onSignOut={signOut}
              onNavigate={close}
            />
          </div>
        </aside>

        {/* The panel: what is here, and where else you can go from it. Hidden
            on a wide screen when collapsed; on a phone it is the drawer, so it
            is always drawn. */}
        <aside
          className={cn(
            "flex w-60 flex-col border-r border-sidebar-border bg-sidebar",
            collapsed && "lg:hidden",
          )}
        >
          {agent ? (
            <AgentPanel agent={agent} onNavigate={close} />
          ) : (
            <WorkspacePanel
              workspaceName={workspaceName}
              workspaces={workspaces}
              activeWorkspaceId={me?.workspace.id}
              onSwitch={switchWorkspace}
              onCreateWorkspace={() => setCreateOpen(true)}
              onNavigate={close}
            />
          )}

          <div className="mt-auto space-y-0.5 border-t border-sidebar-border p-2">
            <CreditsRow />
            {/* Above the account menu rather than inside it. Somebody who has
                just hit a problem should not have to guess that the way to say
                so is behind their own name. */}
            <FeedbackButton path={pathname} onOpen={close} />
          </div>
        </aside>
      </div>

      {open && <div className="fixed inset-0 z-30 bg-black/40 lg:hidden" onClick={close} />}

      <div className={cn(collapsed ? "lg:pl-14" : "lg:pl-[296px]")}>
        {/* Phone only: the way to the drawer, and where you are. On a wide
            screen the page's own headline says that. */}
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur lg:hidden">
          <button
            className="grid h-9 w-9 place-items-center rounded-md border border-border text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle navigation"
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            {agent ? (
              <>
                <span>{agent.emoji}</span>
                <span className="truncate">{agent.name}</span>
              </>
            ) : (
              <span className="truncate">{pageLabel(pathname)}</span>
            )}
          </div>
        </header>

        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create workspace</DialogTitle>
              <DialogDescription>
                Give your new workspace a name. You'll be its admin and switched into it right away.
              </DialogDescription>
            </DialogHeader>
            <Input
              autoFocus
              placeholder="e.g. Acme Marketing"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void createWorkspace();
                }
              }}
              maxLength={100}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={creating}>
                Cancel
              </Button>
              <Button onClick={() => void createWorkspace()} disabled={!newName.trim() || creating}>
                {creating ? "Creating…" : "Create"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <IncomingInvitesBanner />
        <main>{children}</main>
      </div>
    </div>
  );
}

const ROW =
  "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium transition-colors duration-200";
const ROW_IDLE = "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground";
const ROW_ACTIVE = "bg-sidebar-accent text-sidebar-accent-foreground";

/** The 12px uppercase eyebrow, the system's one uppercase role. */
function PanelLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 pb-1 pt-4 text-xs font-semibold uppercase tracking-[0.06em] text-micro-foreground">
      {children}
    </div>
  );
}

/** Inside an agent: its pages, then its threads. */
function AgentPanel({ agent, onNavigate }: { agent: Agent; onNavigate: () => void }) {
  const { sessions, deleteAgent, startSession, startBrainstorm, deleteSession, renameSession } =
    useAgentsStore();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const activeSessionId = useRouterState({
    select: (s) => (s.location.search as { s?: string }).s,
  });
  const navigate = useNavigate();
  const [shareOpen, setShareOpen] = useState(false);

  // Sharing and deleting are Full access, per agent. A viewer never has it —
  // the server caps them at Can use — so this covers the role as well.
  const canManage = canManageAgent(agent);

  const agentSessions = sessions
    .filter((s) => s.agentId === agent.id)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const sharedSessions = agentSessions.filter((s) => s.visibility === "shared");
  const mySessions = agentSessions.filter((s) => s.visibility === "private");
  const activeSession = agentSessions.find((s) => s.id === activeSessionId);

  const chatPath = `/agents/${agent.id}/chat`;
  const onChat = pathname === chatPath;
  // "New thread" lights up while you are on one: a conversation nothing has
  // been said in yet, or the chat page with no conversation picked.
  const onNewThread = onChat && (!activeSession || activeSession.messageCount === 0);

  const openChat = (sessionId?: string) => {
    navigate({
      to: "/agents/$agentId/chat",
      params: { agentId: agent.id },
      search: { s: sessionId },
    });
    onNavigate();
  };

  const removeSession = (id: string) => {
    const remaining = agentSessions.filter((s) => s.id !== id);
    deleteSession(id);
    if (activeSessionId === id) openChat(remaining[0]?.id);
  };

  const pages = [
    { to: "/agents/$agentId/routines", label: "Routines", icon: Repeat },
    { to: "/agents/$agentId/knowledge", label: "Knowledge", icon: BookOpen },
    { to: "/agents/$agentId/settings", label: "Settings", icon: SlidersHorizontal },
  ] as const;

  return (
    <>
      <div className="flex h-14 items-center gap-2 px-3">
        <AgentAvatar emoji={agent.emoji} className="h-7 w-7 rounded-full text-base" />
        <div className="min-w-0 flex-1 truncate text-base font-semibold">{agent.name}</div>
        {canManage && (
          <button
            onClick={() => setShareOpen(true)}
            title="Share this agent"
            aria-label="Share this agent"
            className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors duration-200 hover:bg-sidebar-accent/60 hover:text-foreground"
          >
            <Users className="h-4 w-4" />
          </button>
        )}
      </div>

      <nav className="space-y-0.5 px-2">
        <button
          onClick={() => void startSession(agent.id).then((s) => openChat(s.id))}
          className={cn(ROW, onNewThread ? ROW_ACTIVE : ROW_IDLE)}
        >
          <PenSquare className="h-4 w-4 shrink-0" />
          New thread
        </button>
        <button
          onClick={() => void startBrainstorm(agent.id).then((s) => openChat(s.id))}
          className={cn(ROW, ROW_IDLE)}
        >
          <Sparkles className="h-4 w-4 shrink-0" />
          New brainstorm
        </button>
        {pages.map((p) => {
          const href = p.to.replace("$agentId", agent.id);
          const active = pathname === href || pathname.startsWith(`${href}/`);
          const Icon = p.icon;
          return (
            <Link
              key={p.to}
              to={p.to}
              params={{ agentId: agent.id }}
              onClick={onNavigate}
              className={cn(ROW, active ? ROW_ACTIVE : ROW_IDLE)}
            >
              <Icon className={cn("h-4 w-4 shrink-0", active && "text-brand")} />
              {p.label}
            </Link>
          );
        })}
      </nav>

      <div className="flex min-h-0 flex-1 flex-col px-2">
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {sharedSessions.length > 0 && (
            <>
              <PanelLabel>Shared with the team</PanelLabel>
              <div className="space-y-0.5">
                {sharedSessions.map((s) => (
                  <SessionRow
                    key={s.id}
                    session={s}
                    active={s.id === activeSessionId}
                    onOpen={openChat}
                    onRename={renameSession}
                    onDelete={removeSession}
                  />
                ))}
              </div>
            </>
          )}
          <PanelLabel>Threads</PanelLabel>
          {mySessions.length === 0 ? (
            <p className="px-3 py-1 text-sm text-muted-foreground">No threads yet</p>
          ) : (
            <div className="space-y-0.5">
              {mySessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  active={s.id === activeSessionId}
                  onOpen={openChat}
                  onRename={renameSession}
                  onDelete={removeSession}
                />
              ))}
            </div>
          )}
        </div>

        {/* Delete agent. Absent without Full access: deleting an agent takes
            every session, message and routine hanging off it, for everyone it
            is shared with, and the server refuses anybody short of manage — so
            it is not offered. */}
        {canManage && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button className={cn(ROW, ROW_IDLE, "hover:text-destructive")}>
                <Trash2 className="h-4 w-4 shrink-0" />
                Delete agent
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete {agent.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  This takes it away from everyone it's shared with, along with every chat and
                  routine attached to it — including private ones. It waits 30 days in Settings →
                  Recently deleted, and comes back whole if you restore it.
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
        )}
      </div>

      {canManage && <ShareAgentDialog agent={agent} open={shareOpen} onOpenChange={setShareOpen} />}
    </>
  );
}

/** On a workspace page: the workspace, its pages, and its agents. Threads
    live under the agent they belong to. */
function WorkspacePanel({
  workspaceName,
  workspaces,
  activeWorkspaceId,
  onSwitch,
  onCreateWorkspace,
  onNavigate,
}: {
  workspaceName: string | undefined;
  workspaces: { id: string; name: string }[];
  activeWorkspaceId: string | undefined;
  onSwitch: (id: string) => void;
  onCreateWorkspace: () => void;
  onNavigate: () => void;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <>
      <div className="flex h-14 items-center px-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors duration-200 hover:bg-sidebar-accent/60"
              aria-label="Switch workspace"
            >
              <span className="min-w-0 flex-1 truncate text-base font-semibold">
                {workspaceName ?? "…"}
              </span>
              <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              Switch workspace
            </DropdownMenuLabel>
            {workspaces.map((w) => (
              <DropdownMenuItem key={w.id} onClick={() => onSwitch(w.id)}>
                <div className="grid h-6 w-6 shrink-0 place-items-center rounded bg-accent text-xs font-semibold text-accent-foreground">
                  {w.name.charAt(0).toUpperCase()}
                </div>
                <span className="flex-1 truncate">{w.name}</span>
                {w.id === activeWorkspaceId && <Check className="h-4 w-4 shrink-0 text-brand" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(e) => {
                e.preventDefault();
                onCreateWorkspace();
              }}
            >
              <Plus className="h-4 w-4" /> Create workspace
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <nav className="space-y-0.5 px-2">
        <NewThreadRow onNavigate={onNavigate} />
        {PANEL_NAV.map((n) => {
          const active = primaryNavMatch(pathname)?.to === n.to;
          const Icon = n.icon;
          return (
            <Link
              key={n.to}
              to={n.to}
              onClick={onNavigate}
              className={cn(ROW, active ? ROW_ACTIVE : ROW_IDLE)}
            >
              <Icon className={cn("h-4 w-4 shrink-0", active && "text-brand")} />
              {n.label}
            </Link>
          );
        })}
      </nav>

      <AgentList onNavigate={onNavigate} />
    </>
  );
}

/** The workspace's agents, pinned ones first, and the way to make another.
    Picking one opens its chat. */
function AgentList({ onNavigate }: { onNavigate: () => void }) {
  const { agents, favorites, canWrite } = useAgentsStore();
  const navigate = useNavigate();
  const sorted = useMemo(
    () =>
      [...agents].sort(
        (a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)),
      ),
    [agents, favorites],
  );

  if (sorted.length === 0) return null;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
      <PanelLabel>Agents</PanelLabel>
      <div className="space-y-0.5">
        {sorted.map((a) => (
          <Link
            key={a.id}
            to="/agents/$agentId/chat"
            params={{ agentId: a.id }}
            onClick={onNavigate}
            className={cn(ROW, ROW_IDLE)}
          >
            <span className="w-4 shrink-0 text-center text-sm leading-none" aria-hidden>
              {a.emoji}
            </span>
            <span className="min-w-0 flex-1 truncate">{a.name}</span>
          </Link>
        ))}
        {canWrite && (
          <button
            className={cn(ROW, ROW_IDLE)}
            onClick={() => {
              onNavigate();
              void navigate({ to: "/app", search: { new: true } });
            }}
          >
            <Plus className="h-4 w-4 shrink-0" /> New agent
          </button>
        )}
      </div>
    </div>
  );
}

/** "New thread" opens an agent picker; picking one starts a fresh thread and
    jumps into it. Falls back to agent creation when the workspace is empty. */
function NewThreadRow({ onNavigate }: { onNavigate: () => void }) {
  const { agents, startSession, canWrite } = useAgentsStore();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);

  const start = async (agentId: string) => {
    if (pending) return;
    setPending(true);
    try {
      const session = await startSession(agentId);
      onNavigate();
      void navigate({
        to: "/agents/$agentId/chat",
        params: { agentId },
        search: { s: session.id },
      });
    } catch {
      toast.error("Couldn't start a new thread.");
    } finally {
      setPending(false);
    }
  };

  if (agents.length === 0) {
    if (!canWrite) return null;
    return (
      <button
        className={cn(ROW, ROW_IDLE)}
        onClick={() => {
          onNavigate();
          void navigate({ to: "/app", search: { new: true } });
        }}
      >
        <Plus className="h-4 w-4 shrink-0" /> New agent
      </button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className={cn(ROW, ROW_IDLE)} disabled={pending}>
          <PenSquare className="h-4 w-4 shrink-0" /> New thread
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Chat with…
        </DropdownMenuLabel>
        <div className="max-h-72 overflow-y-auto">
          {agents.map((a) => (
            <DropdownMenuItem key={a.id} onClick={() => void start(a.id)}>
              <AgentAvatar emoji={a.emoji} className="h-6 w-6 text-sm" />
              <span className="flex-1 truncate">{a.name}</span>
            </DropdownMenuItem>
          ))}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The balance, as a row in the panel's footer. Renders nothing when the
    install is not metered — `CreditsBadge` decides that. */
function CreditsRow() {
  return (
    <div className="[&>a]:w-full [&>a]:border-0 [&>a]:px-3 [&>a]:py-2 [&>a]:hover:bg-sidebar-accent/60">
      <CreditsBadge />
    </div>
  );
}

/** The account: who you are, the theme, the documentation, and the way out. */
function AccountMenu({
  name,
  email,
  avatarUrl,
  onSignOut,
  onNavigate,
}: {
  name: string | null | undefined;
  email: string | null | undefined;
  avatarUrl: string | null | undefined;
  onSignOut: () => void;
  onNavigate: () => void;
}) {
  const { preference, mounted, setPreference } = useTheme();
  const themes = [
    { key: "system", label: "Auto", icon: Monitor },
    { key: "light", label: "Light", icon: Sun },
    { key: "dark", label: "Dark", icon: Moon },
  ] as const;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="mb-1 mt-1 grid h-9 w-9 place-items-center rounded-full transition-opacity duration-200 hover:opacity-80"
          aria-label="Account"
        >
          <UserAvatar name={name} url={avatarUrl} className="h-8 w-8 rounded-full text-xs" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="right" className="w-60">
        <DropdownMenuLabel className="font-normal">
          <div className="text-sm font-medium">{name ?? "…"}</div>
          <div className="text-meta text-muted-foreground">{email ?? "…"}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Theme
        </DropdownMenuLabel>
        {/* Three buttons rather than three items, so picking one leaves the
            menu open and the change can be seen without reopening it. */}
        <div className="flex gap-1 px-2 pb-1.5">
          {themes.map((t) => {
            const on = mounted && preference === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setPreference(t.key)}
                aria-pressed={on}
                className={cn(
                  "flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border text-xs font-medium transition-colors duration-200",
                  on
                    ? "border-border bg-surface text-foreground"
                    : "border-transparent text-muted-foreground hover:bg-surface hover:text-foreground",
                )}
              >
                <t.icon className="h-3.5 w-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings/account" onClick={onNavigate}>
            <User className="h-4 w-4" /> Profile
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings/workspace" onClick={onNavigate}>
            <Settings className="h-4 w-4" /> Workspace settings
          </Link>
        </DropdownMenuItem>
        {/* The documentation answers most of what this menu's other items lead
            people to guess at, and until now the app never said it existed.
            New tab: leaving a workspace to read about bundles and coming back
            to a cold app is a poor trade. */}
        <DropdownMenuItem asChild>
          <a href={DOCS_HOME} target="_blank" rel="noreferrer">
            <BookOpen className="h-4 w-4" /> Documentation
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSignOut} className="text-destructive focus:text-destructive">
          <LogOut className="h-4 w-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
