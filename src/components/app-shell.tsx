import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  LayoutGrid,
  Users,
  Plug,
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
} from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/lib/theme";
import { BrandMark } from "@/components/brand-mark";
import { AgentAvatar, UserAvatar } from "@/components/avatars";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api-client";
import type { WorkspaceMember } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { useAgentsStore } from "@/lib/agents-store";
import { invalidateWorkspaceScoped } from "@/lib/workspace-queries";
import { DOCS_HOME } from "@/lib/docs";
import { IncomingInvitesBanner } from "@/components/incoming-invites-banner";

const nav = [
  { to: "/app", label: "Home", icon: LayoutGrid },
  { to: "/team", label: "Team", icon: Users },
  { to: "/integrations", label: "Integrations", icon: Plug },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

/** Label for the context bar. Falls back to the brand on unknown paths. */
function pageLabel(pathname: string): string {
  const match = nav.find((n) => pathname === n.to || pathname.startsWith(`${n.to}/`));
  return match?.label ?? "Covan";
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const { theme, preference, mounted, setPreference } = useTheme();
  const navigate = useNavigate();

  const queryClient = useQueryClient();
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const { data: workspaces = [] } = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.workspaces.list(),
  });
  const userName = me?.user.name;
  const userEmail = me?.user.email;
  const workspaceName = me?.workspace.name;
  const members = me?.members ?? [];

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

  return (
    <div className="min-h-screen w-full bg-background text-foreground">
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-64 flex-col border-r border-sidebar-border bg-sidebar transition-transform lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {/* The wordmark is set in type, never an image — DM Sans 600/20 with
            the tight -0.02em tracking (§7.1). */}
        <div className="flex h-16 items-center gap-2.5 px-5">
          <BrandMark />
          <span className="font-dm text-xl font-semibold leading-none tracking-[-0.02em]">
            Covan
          </span>
        </div>

        <div className="px-4 pb-3">
          <NewChatButton onNavigate={() => setOpen(false)} />
        </div>

        <nav className="space-y-0.5 px-4">
          {nav.map((n) => {
            const active = pathname === n.to || pathname.startsWith(`${n.to}/`);
            const Icon = n.icon;
            return (
              <Link
                key={n.to}
                to={n.to}
                onClick={() => setOpen(false)}
                className={cn(
                  "group flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-200",
                  active
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                )}
              >
                {/* The active row is marked by a 4px amber square, the same
                    mark the nav uses as a separator (§7.2). */}
                <span
                  aria-hidden
                  className={cn(
                    "h-1 w-1 shrink-0 transition-colors duration-200",
                    active ? "bg-accent-orange" : "bg-transparent",
                  )}
                />
                <Icon className="h-4 w-4" />
                {n.label}
              </Link>
            );
          })}
        </nav>

        <RecentRail onNavigate={() => setOpen(false)} />

        <div className="mt-auto border-t border-sidebar-border p-4">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex w-full items-center gap-3 rounded-md p-2 text-left transition-colors duration-200 hover:bg-sidebar-accent/60">
                <UserAvatar
                  name={userName}
                  url={me?.user.avatarUrl}
                  className="h-9 w-9 text-[11px]"
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{userName ?? "…"}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {workspaceName ?? "…"}
                  </div>
                </div>
                <ChevronsUpDown className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top" className="w-60">
              <DropdownMenuLabel className="font-normal">
                <div className="text-sm font-medium">{userName ?? "…"}</div>
                <div className="text-xs text-muted-foreground">{userEmail ?? "…"}</div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                Switch workspace
              </DropdownMenuLabel>
              {workspaces.map((w) => (
                <DropdownMenuItem key={w.id} onClick={() => switchWorkspace(w.id)}>
                  <div className="grid h-6 w-6 shrink-0 place-items-center rounded bg-accent text-[10px] font-semibold text-accent-foreground">
                    {w.name.charAt(0).toUpperCase()}
                  </div>
                  <span className="flex-1 truncate">{w.name}</span>
                  {w.id === me?.workspace.id && (
                    <Check className="h-4 w-4 shrink-0 text-accent-orange" />
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setCreateOpen(true);
                }}
              >
                <Plus className="h-4 w-4" /> Create workspace
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link to="/settings" onClick={() => setOpen(false)}>
                  <User className="h-4 w-4" /> Profile
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to="/settings" onClick={() => setOpen(false)}>
                  <Settings className="h-4 w-4" /> Workspace settings
                </Link>
              </DropdownMenuItem>
              {/* The documentation answers most of what this menu's other
                  items lead people to guess at, and until now the app never
                  said it existed. New tab: leaving a workspace to read about
                  bundles and coming back to a cold app is a poor trade. */}
              <DropdownMenuItem asChild>
                <a href={DOCS_HOME} target="_blank" rel="noreferrer">
                  <BookOpen className="h-4 w-4" /> Documentation
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={signOut}
                className="text-destructive focus:text-destructive"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {open && (
        <div
          className="fixed inset-0 z-30 bg-foreground/20 lg:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      <div className="lg:pl-64">
        {/* Thin context bar — deliberately quiet. Nav lives in the rail; this
            strip only carries the mobile toggle, team presence, search, theme. */}
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-background/80 px-5 backdrop-blur lg:px-8">
          <button
            className="grid h-9 w-9 place-items-center rounded-md border border-border text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground lg:hidden"
            onClick={() => setOpen((v) => !v)}
            aria-label="Toggle navigation"
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>

          {/* Breadcrumb-lite: workspace, then the page. The two are separated
              by a 4×4 ink square, the way nav links are (§7.2) — never by a
              slash or a chevron. */}
          <div className="flex min-w-0 items-center gap-3.5 text-sm font-medium">
            <span className="hidden truncate text-muted-foreground sm:inline">
              {workspaceName ?? "…"}
            </span>
            <span className="hidden h-1 w-1 shrink-0 bg-foreground sm:block" aria-hidden />
            <span className="truncate">{pageLabel(pathname)}</span>
          </div>

          <div className="ml-auto flex items-center gap-2">
            <TeamPresence members={members} />
            <button
              onClick={() => window.dispatchEvent(new Event("open-command-palette"))}
              className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground"
              aria-label="Open command palette"
            >
              <Search className="h-4 w-4" />
              <span className="hidden sm:inline">Search</span>
              <kbd className="hidden rounded-sm bg-muted px-1.5 font-mono text-[11px] leading-5 sm:inline">
                ⌘K
              </kbd>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="grid h-9 w-9 place-items-center rounded-md border border-border text-muted-foreground transition-colors duration-200 hover:bg-accent hover:text-foreground"
                  aria-label="Theme"
                >
                  {/* Gated on mounted to avoid a hydration mismatch on the icon.
                      Shows the follow-device icon when on System. */}
                  {!mounted || preference === "system" ? (
                    <Monitor className="h-4 w-4" />
                  ) : theme === "dark" ? (
                    <Moon className="h-4 w-4" />
                  ) : (
                    <Sun className="h-4 w-4" />
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40">
                {(
                  [
                    { key: "system", label: "System", icon: Monitor },
                    { key: "light", label: "Light", icon: Sun },
                    { key: "dark", label: "Dark", icon: Moon },
                  ] as const
                ).map((opt) => (
                  <DropdownMenuItem key={opt.key} onClick={() => setPreference(opt.key)}>
                    <opt.icon className="h-4 w-4" />
                    <span className="flex-1">{opt.label}</span>
                    {mounted && preference === opt.key && (
                      <Check className="h-4 w-4 text-accent-orange" />
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Create workspace</DialogTitle>
                <DialogDescription>
                  Give your new workspace a name. You'll be its admin and switched into it right
                  away.
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
                <Button
                  onClick={() => void createWorkspace()}
                  disabled={!newName.trim() || creating}
                >
                  {creating ? "Creating…" : "Create"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </header>
        <IncomingInvitesBanner />
        <main>{children}</main>
      </div>
    </div>
  );
}

/** Stacked team avatars — the collaboration signal that a single-player chat
    app can't show. Click through to the Team surface. */
function TeamPresence({ members }: { members: WorkspaceMember[] }) {
  if (members.length === 0) return null;
  const shown = members.slice(0, 4);
  const extra = members.length - shown.length;
  return (
    <Link
      to="/team"
      aria-label={`${members.length} team members`}
      className="mr-1 hidden items-center transition-opacity duration-200 hover:opacity-80 sm:flex"
    >
      <div className="flex -space-x-1.5">
        {shown.map((m) => (
          <UserAvatar
            key={m.id}
            name={m.name}
            url={m.avatarUrl}
            className="h-7 w-7 text-[9px] ring-2 ring-background"
          />
        ))}
        {extra > 0 && (
          <span className="grid h-7 w-7 place-items-center rounded-md bg-muted text-[9px] font-semibold text-muted-foreground ring-2 ring-background">
            +{extra}
          </span>
        )}
      </div>
    </Link>
  );
}

/** "New chat" opens an agent picker; picking one starts a fresh session and
    jumps into it. Falls back to agent creation when the workspace is empty. */
function NewChatButton({ onNavigate }: { onNavigate: () => void }) {
  const { agents, startSession } = useAgentsStore();
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
      toast.error("Couldn't start a new chat.");
    } finally {
      setPending(false);
    }
  };

  if (agents.length === 0) {
    return (
      <Button
        className="w-full justify-start"
        onClick={() => {
          onNavigate();
          void navigate({ to: "/app", search: { new: true } });
        }}
      >
        <PenSquare className="h-4 w-4" /> New chat
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button className="w-full justify-start" disabled={pending}>
          <PenSquare className="h-4 w-4" /> New chat
        </Button>
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

// Time buckets, Dust-style ("Today" / "Last month"). Order matters.
const BUCKETS = [
  { key: "today", label: "Today", within: 1 },
  { key: "yesterday", label: "Yesterday", within: 2 },
  { key: "week", label: "Previous 7 days", within: 7 },
  { key: "month", label: "Last month", within: 30 },
  { key: "older", label: "Older", within: Infinity },
] as const;

function bucketFor(ts: number): (typeof BUCKETS)[number]["key"] {
  const days = (Date.now() - ts) / (24 * 60 * 60 * 1000);
  for (const b of BUCKETS) if (days < b.within) return b.key;
  return "older";
}

/** Conversations, grouped by recency and resumable in one click — the rail
    reads like a chat product, not a settings menu. */
function RecentRail({ onNavigate }: { onNavigate: () => void }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const search = useRouterState({ select: (s) => s.location.search }) as { s?: string };
  const { agents, sessions } = useAgentsStore();

  const grouped = useMemo(() => {
    const agentById = new Map(agents.map((a) => [a.id, a]));
    const rows = [...sessions]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 40)
      .map((s) => ({
        session: s,
        agent: agentById.get(s.agentId),
        bucket: bucketFor(s.updatedAt),
      }));
    return BUCKETS.map((b) => ({
      label: b.label,
      rows: rows.filter((r) => r.bucket === b.key),
    })).filter((g) => g.rows.length > 0);
  }, [agents, sessions]);

  if (grouped.length === 0) return null;

  return (
    <div className="mt-5 flex min-h-0 flex-1 flex-col px-4">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-2">
        {grouped.map((group) => (
          <div key={group.label} className="space-y-0.5">
            {/* The 12px uppercase eyebrow, the system's one uppercase role. */}
            <div className="px-3 pb-1 text-xs font-semibold uppercase tracking-[0.06em] text-micro-foreground">
              {group.label}
            </div>
            {group.rows.map(({ session, agent }) => {
              const active = pathname.includes(session.agentId) && search?.s === session.id;
              return (
                <Link
                  key={session.id}
                  to="/agents/$agentId/chat"
                  params={{ agentId: session.agentId }}
                  search={{ s: session.id }}
                  onClick={onNavigate}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors duration-200",
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                  )}
                >
                  <span className="shrink-0 text-sm leading-none">
                    {session.kind === "brainstorm" ? "🧠" : (agent?.emoji ?? "🤖")}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {session.title || agent?.name || "New chat"}
                  </span>
                </Link>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
