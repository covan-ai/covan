import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { WorkspaceMember } from "@/lib/api-client";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CreateAgentDialog } from "@/components/create-agent-dialog";
import { Badge, Headline, SectionHeading } from "@/components/page-container";
import { Chip, DataRow, EmptyState } from "@/components/section-card";
import { AgentAvatar, UserAvatar } from "@/components/avatars";
import { useQuota, quotaSentence } from "@/lib/quota";
import { FirstWeekChecklist } from "@/components/first-week-checklist";
import { firstWeekSteps, firstWeekRemaining, useChecklistDismissed } from "@/lib/first-week";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgentsStore, type Agent, type ChatSession } from "@/lib/agents-store";
import { formatRelative } from "@/lib/relative-time";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ArrowUp, ChevronDown, Plus, Search, Star, Users } from "lucide-react";

export const Route = createFileRoute("/_authed/app")({
  component: Home,
  validateSearch: (search: Record<string, unknown>): { new?: boolean } => ({
    new: search.new === true || search.new === "true" ? true : undefined,
  }),
});

function firstName(name: string | null | undefined) {
  if (!name) return "there";
  return name.trim().split(/\s+/)[0] || "there";
}

/** Greets by time of day so the home feels addressed to a person, not a URL. */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function Home() {
  const { agents, favorites, sessions, canWrite } = useAgentsStore();
  const { new: openNew } = Route.useSearch();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const members = me?.members ?? [];
  const quota = useQuota();

  // The one fact the checklist needs that the home screen does not already
  // hold. Asked for only while it could still change the answer, so a
  // settled workspace stops paying for it on every visit.
  const { dismissed, dismiss } = useChecklistDismissed(me?.workspace.id);
  const showChecklist = canWrite && !dismissed && agents.length > 0;
  const { data: routines = [] } = useQuery({
    queryKey: ["routines"],
    queryFn: () => api.routines.list(),
    enabled: showChecklist,
  });

  const steps = firstWeekSteps({
    agents,
    sessions,
    memberCount: members.length,
    routineCount: routines.length,
  });

  // The ⌘K "New agent" action deep-links here with ?new=true.
  //
  // One of the eleven in #68, and the second of the two that stay. It is not a
  // copy of anything: the URL is a request, and this consumes it — opens the
  // dialog, then takes the request back out of the address bar so closing and
  // reopening does not reopen it. Synchronising React with the URL is what the
  // rule's own guidance calls an effect's job.
  //
  // Deriving it instead — `createOpen || !!openNew`, and clearing the search
  // param on close — was tried and is worse. The dialog would then stay open
  // until the router's update lands, and TanStack does that in a transition,
  // so React is free to defer it: closing the dialog would visibly lag on the
  // ⌘K path and only on the ⌘K path. Both palette entries can also fire while
  // already on /app, so a `useState(!!openNew)` initialiser never sees the
  // second press.
  useEffect(() => {
    if (openNew) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCreateOpen(true);
      navigate({ to: "/app", search: {}, replace: true });
    }
  }, [openNew, navigate]);

  return (
    <AppShell>
      {/* Chat-first home: the conversation starter owns the fold. The headline
          takes the system's two-tone shape — statement, then an italic turn in
          muted display grey (§5.5). */}
      <div className="mx-auto w-full max-w-3xl px-5 pt-[8vh]">
        <div className="flex flex-col items-center gap-3 text-center">
          <Badge>{me?.workspace.name ?? "Workspace"}</Badge>
          <Headline as="h1" className="text-center" turn={<>What are we working on?</>}>
            {greeting()}, {firstName(me?.user.name)}.
          </Headline>
          {/* A lede only when there is nothing to act on yet. With agents in
              the workspace the composer below is the instruction. */}
          {agents.length === 0 ? (
            <p className="max-w-[480px] text-base leading-[1.45] text-muted-foreground">
              Create your team's first shared agent — everyone gets it, and every conversation stays
              private.
            </p>
          ) : null}
        </div>
        <HomeComposer
          agents={agents}
          favorites={favorites}
          canCreate={canWrite}
          onCreate={() => setCreateOpen(true)}
          className="mt-10"
        />
        {/* Directly under the composer, because this is the moment before
            spending — not buried in settings, where nobody looks until the
            replies have already stopped. Renders nothing when self-hosted. */}
        {quota && (
          <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            {quota.level !== "fine" && <span className="h-2 w-2 shrink-0 bg-accent-orange" />}
            {quotaSentence(quota)}
          </p>
        )}
        {/* Under the composer, never over it: the composer is the product and
            this is scaffolding. Hidden from a viewer, since the policies refuse
            them three of the four steps, and hidden while the workspace has no
            agents at all — that screen has one job and the composer above is
            already saying it. */}
        {showChecklist && firstWeekRemaining(steps) > 0 && (
          <FirstWeekChecklist steps={steps} agentId={agents[0].id} onDismiss={dismiss} />
        )}
      </div>

      <div className="mx-auto w-full max-w-[1200px] space-y-20 px-5 pb-32 pt-24 lg:px-8">
        <AgentGallery
          agents={agents}
          favorites={favorites}
          sessions={sessions}
          memberCount={members.length}
          canCreate={canWrite}
          onCreate={() => setCreateOpen(true)}
        />
        <TeamActivity sessions={sessions} agents={agents} members={members} />
      </div>

      <CreateAgentDialog open={createOpen} onOpenChange={setCreateOpen} />
    </AppShell>
  );
}

/** The launcher composer: pick an agent, type, send. Sending spins up a fresh
    session, stashes the draft, and jumps into the chat — the chat route sends
    the stashed draft automatically on an empty session. */
function HomeComposer({
  agents,
  favorites,
  canCreate,
  onCreate,
  className,
}: {
  agents: Agent[];
  favorites: string[];
  /** False for a viewer — same meaning as in the gallery below: the policies
      refuse them either way, this is so the button is not there to press. */
  canCreate: boolean;
  onCreate: () => void;
  className?: string;
}) {
  const { startSession } = useAgentsStore();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  // Default to a pinned agent, else the first one.
  const defaultAgent = useMemo(
    () => agents.find((a) => favorites.includes(a.id)) ?? agents[0],
    [agents, favorites],
  );
  // Holds a pick, and only a pick. `undefined` is not "not loaded yet" — it is
  // "nobody has chosen", which is the state this composer opens in and the one
  // the line below already knows what to do with. Seeding it from defaultAgent
  // (in the initialiser, or in an effect once the agents arrive) would say the
  // same thing twice and let the two copies disagree: an agent that is deleted
  // leaves its id behind here, where `?? defaultAgent` recovers and a stored id
  // does not. Everything the dropdown renders reads `selected`, never this.
  const [agentId, setAgentId] = useState<string | undefined>(undefined);

  const selected = agents.find((a) => a.id === agentId) ?? defaultAgent;

  const launch = async () => {
    const body = text.trim();
    if (sending) return;
    if (!selected) {
      // Reachable only if the disabled states below ever come off — the button
      // in the empty row is the real path now. Straight to the dialog rather
      // than a ?new=true round trip through the URL, since the handler that
      // opens it is in scope here.
      if (canCreate) onCreate();
      return;
    }
    setSending(true);
    try {
      const session = await startSession(selected.id);
      if (body) {
        try {
          sessionStorage.setItem(`chat-draft:${session.id}`, body);
        } catch {
          /* private mode / storage full — the chat just opens empty */
        }
      }
      void navigate({
        to: "/agents/$agentId/chat",
        params: { agentId: selected.id },
        search: { s: session.id },
      });
    } catch {
      toast.error("Couldn't start the chat.");
      setSending(false);
    }
  };

  const empty = agents.length === 0;

  return (
    <div className={className}>
      {/* White is the raised state, and this genuinely floats — so it takes the
          20px panel radius and the one panel shadow in the system (§3.5). */}
      <div className="rounded-3xl bg-popover shadow-card transition-colors duration-200">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void launch();
            }
          }}
          placeholder={
            empty
              ? canCreate
                ? "Create an agent to get started…"
                : "No agents yet — a member has to make the first one…"
              : `Message ${selected?.name ?? "your agent"}…`
          }
          disabled={empty}
          rows={3}
          className="resize-none border-0 bg-transparent px-5 pt-5 text-[15px] leading-[1.45] shadow-none focus-visible:ring-0"
        />
        <div className="flex items-center justify-between gap-2 px-4 pb-4">
          {empty ? (
            // This slot used to hold the words "No agents yet" and nothing to
            // press, on the one card that owns the fold — so the first screen
            // of an empty workspace told you what was wrong and left the only
            // way to fix it below the fold, in the gallery. Same control as the
            // agent picker it replaces, deliberately: the row is the row, only
            // its contents change. Not a `Button`, because a default-size one
            // carries the amber chip and send is the single amber fill here.
            canCreate ? (
              <button
                onClick={onCreate}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors duration-200 hover:bg-surface"
              >
                <Plus className="h-4 w-4" /> Create agent
              </button>
            ) : (
              <span className="px-1 text-sm text-muted-foreground">
                Ask an admin or a member to create one.
              </span>
            )
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2.5 rounded-md py-1.5 pl-1.5 pr-2.5 text-sm font-medium transition-colors duration-200 hover:bg-surface">
                  {selected ? (
                    <AgentAvatar emoji={selected.emoji} className="h-7 w-7 text-sm" />
                  ) : null}
                  <span className="max-w-[10rem] truncate">{selected?.name ?? "Pick agent"}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                  Chat with…
                </DropdownMenuLabel>
                <div className="max-h-72 overflow-y-auto">
                  {agents.map((a) => (
                    <DropdownMenuItem key={a.id} onClick={() => setAgentId(a.id)}>
                      <AgentAvatar emoji={a.emoji} className="h-6 w-6 text-sm" />
                      <span className="flex-1 truncate">{a.name}</span>
                    </DropdownMenuItem>
                  ))}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Send is the one amber fill on this screen — a 36px chip, exactly
              the size the button's own chip is. */}
          <button
            onClick={() => void launch()}
            disabled={sending || empty || !text.trim()}
            aria-label="Send"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-accent-orange text-[#251f19] transition-opacity duration-200 hover:opacity-90 disabled:opacity-40"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
      {!empty && (
        <p className="mt-3 text-center text-[13px] text-micro-foreground">
          Enter to send · Shift + Enter for a new line · new chats start private
        </p>
      )}
    </div>
  );
}

type Tab = "favorites" | "all";

/** The agent gallery: search + tabs + quiet cards. Clicking a card starts a
    fresh chat with that agent. */
function AgentGallery({
  agents,
  favorites,
  sessions,
  memberCount,
  canCreate,
  onCreate,
}: {
  agents: Agent[];
  favorites: string[];
  sessions: ChatSession[];
  memberCount: number;
  /** False for a viewer. The policies refuse them either way; this is so the
      button is not there to press. */
  canCreate: boolean;
  onCreate: () => void;
}) {
  const [tab, setTab] = useState<Tab>("all");
  const [q, setQ] = useState("");

  // Most recent touch per agent, so a card can say when the team last used it.
  const lastUsed = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of sessions) {
      const prev = map.get(s.agentId) ?? 0;
      if (s.updatedAt > prev) map.set(s.agentId, s.updatedAt);
    }
    return map;
  }, [sessions]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return agents
      .filter((a) => (tab === "favorites" ? favorites.includes(a.id) : true))
      .filter(
        (a) =>
          !needle ||
          a.name.toLowerCase().includes(needle) ||
          a.persona.toLowerCase().includes(needle),
      )
      .sort((a, b) => {
        const fav = Number(favorites.includes(b.id)) - Number(favorites.includes(a.id));
        if (fav !== 0) return fav;
        return a.name.localeCompare(b.name);
      });
  }, [agents, favorites, tab, q]);

  return (
    <section>
      <SectionHeading
        badge="Your agents"
        title="Trained by everyone."
        turn="Used by you alone."
        action={
          canCreate ? (
            <Button onClick={onCreate} variant="secondary" className="gap-1.5">
              <Plus className="h-4 w-4" /> Create agent
            </Button>
          ) : undefined
        }
      />

      <div className="mt-10 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search agents"
            aria-label="Search agents"
            className="h-10 rounded-md pl-10"
          />
        </div>
        <div className="flex items-center gap-1">
          <TabButton active={tab === "favorites"} onClick={() => setTab("favorites")}>
            Pinned
          </TabButton>
          <TabButton active={tab === "all"} onClick={() => setTab("all")}>
            All
          </TabButton>
        </div>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          className="mt-4"
          title={
            agents.length === 0
              ? "No agents yet"
              : tab === "favorites"
                ? "Nothing pinned yet"
                : "No agents match your search"
          }
          description={
            agents.length === 0
              ? canCreate
                ? "Agents are shared with everyone in the workspace — create the first one and the whole team can use it."
                : "Agents are shared with everyone in the workspace. Nobody has made one yet, and adding them is a member's job — ask an admin or a member to start one."
              : tab === "favorites"
                ? "Star an agent to keep it at the top of this list."
                : undefined
          }
          action={
            agents.length === 0 && canCreate ? (
              <Button onClick={onCreate} className="gap-1.5">
                <Plus className="h-4 w-4" /> Create agent
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="mt-6 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              favorite={favorites.includes(a.id)}
              memberCount={memberCount}
              lastUsed={lastUsed.get(a.id)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-10 items-center gap-2 rounded-md border px-3.5 text-sm font-medium transition-colors duration-200",
        active
          ? "border-border bg-surface text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {/* The 8px square is how this system marks a selection. */}
      <span
        aria-hidden
        className={cn("h-2 w-2 shrink-0", active ? "bg-accent-orange" : "bg-transparent")}
      />
      {children}
    </button>
  );
}

function AgentCard({
  agent: a,
  favorite,
  memberCount,
  lastUsed,
}: {
  agent: Agent;
  favorite: boolean;
  memberCount: number;
  lastUsed?: number;
}) {
  const { startSession, toggleFavorite } = useAgentsStore();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);

  const open = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const session = await startSession(a.id);
      void navigate({
        to: "/agents/$agentId/chat",
        params: { agentId: a.id },
        search: { s: session.id },
      });
    } catch {
      toast.error("Couldn't open the chat.");
      setBusy(false);
    }
  };

  return (
    // The card body is inert; a stretched button carries the click. That keeps
    // the pin control from being an interactive element nested inside another.
    // Focus is the system's two-ring amber (§10) rather than a border change.
    <div
      className={cn(
        "group relative flex flex-col rounded-xl border border-border bg-card p-5 transition-colors duration-200 hover:bg-surface-hover",
        "focus-within:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--accent-orange)]",
        busy && "opacity-60",
      )}
    >
      <button
        type="button"
        onClick={() => void open()}
        disabled={busy}
        aria-label={`Start a chat with ${a.name}`}
        className="absolute inset-0 rounded-xl outline-none"
      />

      <div className="pointer-events-none flex items-start gap-3.5">
        <AgentAvatar emoji={a.emoji} className="h-9 w-9 text-lg" />
        <div className="min-w-0 flex-1">
          <div className="truncate font-dm text-[18px] font-medium leading-tight">{a.name}</div>
          <div className="mt-1.5">
            {/* Models are named in a code chip, not colour-coded. */}
            <Chip tone="code">{a.model}</Chip>
          </div>
        </div>
        <button
          type="button"
          aria-label={favorite ? `Unpin ${a.name}` : `Pin ${a.name}`}
          aria-pressed={favorite}
          onClick={() => toggleFavorite(a.id)}
          className={cn(
            "pointer-events-auto relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-sm transition-colors duration-200 hover:bg-muted",
            favorite
              ? "text-accent-orange"
              : "text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
          )}
        >
          <Star className={cn("h-4 w-4", favorite && "fill-current")} />
        </button>
      </div>

      <p className="pointer-events-none mt-4 line-clamp-2 min-h-[2.6rem] text-[15px] leading-[1.35] text-muted-foreground">
        {a.persona}
      </p>

      <div className="pointer-events-none mt-4 flex items-center gap-2 border-t border-hairline pt-3 text-[13px] text-muted-foreground">
        <span className="inline-flex items-center gap-2">
          <span aria-hidden className="h-2 w-2 shrink-0 bg-accent-orange" />
          Shared with{" "}
          {memberCount > 0 ? <span className="tabular-nums">{memberCount}</span> : "the team"}
        </span>
        {lastUsed ? <span className="ml-auto">Used {formatRelative(lastUsed)}</span> : null}
      </div>
    </div>
  );
}

/** What the team has been doing — shared conversations across the workspace.
    This is the thing a single-player chat app can't show (DESIGN.md §7). */
function TeamActivity({
  sessions,
  agents,
  members,
}: {
  sessions: ChatSession[];
  agents: Agent[];
  members: WorkspaceMember[];
}) {
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);

  const rows = useMemo(
    () =>
      sessions
        .filter((s) => s.visibility === "shared")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 6),
    [sessions],
  );

  return (
    <section>
      <SectionHeading badge="Team activity" title="Private by default." turn="Shared on purpose." />

      {rows.length === 0 ? (
        <EmptyState
          className="mt-10"
          title="Nothing shared yet"
          description="Chats start private. Hit Share in a conversation's header to let the rest of the team read along."
        />
      ) : (
        <ul className="mt-10 flex flex-col gap-2.5">
          {rows.map((s) => (
            <li key={s.id}>
              <ActivityRow
                session={s}
                agent={agentById.get(s.agentId)}
                owner={memberById.get(s.ownerId)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityRow({
  session: s,
  agent,
  owner,
}: {
  session: ChatSession;
  agent?: Agent;
  owner?: WorkspaceMember;
}) {
  const navigate = useNavigate();
  return (
    <DataRow
      onClick={() =>
        void navigate({
          to: "/agents/$agentId/chat",
          params: { agentId: s.agentId },
          search: { s: s.id },
        })
      }
      icon={
        agent ? (
          <AgentAvatar emoji={agent.emoji} className="h-9 w-9 text-base" />
        ) : (
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-surface text-base">
            🤖
          </span>
        )
      }
      title={
        <>
          {s.kind === "brainstorm" && <span className="mr-1">🧠</span>}
          {s.title || (s.kind === "brainstorm" ? "Untitled brainstorm" : "Untitled chat")}
        </>
      }
      meta={
        <>
          {agent?.name ?? "Deleted agent"}
          {s.messageCount > 0 ? ` · ${s.messageCount} messages` : ""}
        </>
      }
      trailing={
        <span className="flex shrink-0 items-center gap-2.5">
          <span className="hidden items-center gap-2 sm:flex">
            <UserAvatar name={owner?.name} url={owner?.avatarUrl} className="h-6 w-6 text-[9px]" />
            <span className="max-w-[8rem] truncate text-[13px] text-muted-foreground">
              {owner?.name ?? owner?.email ?? "A teammate"}
            </span>
          </span>
          <span className="text-[13px] tabular-nums text-micro-foreground">
            {formatRelative(s.updatedAt)}
          </span>
        </span>
      }
    />
  );
}
