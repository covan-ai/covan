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
import { SectionHeading } from "@/components/page-container";
import { Chip, DataRow, EmptyState } from "@/components/section-card";
import { AgentAvatar, AvatarStack, UserAvatar } from "@/components/avatars";
import { useCredits, creditsSentence } from "@/lib/credits";
import { CoverageNotice } from "@/components/coverage-notice";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAgentsStore, type Agent, type ChatSession } from "@/lib/agents-store";
import { sharingSummary } from "@/lib/agent-access";
import { formatRelative } from "@/lib/relative-time";
import { sessionLabel } from "@/lib/session-label";
import { dayPart } from "@/lib/day-part";
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

function Home() {
  const { agents, favorites, sessions, canWrite } = useAgentsStore();
  const { new: openNew } = Route.useSearch();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const members = me?.members ?? [];
  const credits = useCredits();

  // Who the hero introduces and the composer sends to. A pinned agent, else
  // the first one, until a pick is made. `agentId` holds a pick and only a
  // pick: an agent that is deleted leaves its id behind here, where
  // `?? defaultAgent` recovers, and a stored default would not.
  const defaultAgent = useMemo(
    () => agents.find((a) => favorites.includes(a.id)) ?? agents[0],
    [agents, favorites],
  );
  const [agentId, setAgentId] = useState<string | undefined>(undefined);
  const selected = agents.find((a) => a.id === agentId) ?? defaultAgent;

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
      {/* Chat-first home: the agent introduces itself, asks what it can do,
          and the composer under it is the answer. */}
      <div className="mx-auto w-full max-w-3xl px-5 pt-[14vh]">
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-[1.75rem] font-semibold leading-[1.2] tracking-[-0.02em] sm:text-[2.125rem]">
            Hi{selected ? ", I'm" : `, ${firstName(me?.user.name)}`}
            {selected && (
              <>
                {" "}
                <span className="text-brand">{selected.name}</span>
              </>
            )}
            .
          </h1>
          <p className="text-[1.75rem] font-semibold leading-[1.2] tracking-[-0.02em] sm:text-[2.125rem]">
            {selected
              ? `What can I do for you ${dayPart()}?`
              : canWrite
                ? "Create your first agent."
                : "Nothing is shared with you yet."}
          </p>
          <p className="mt-3 max-w-[480px] text-sm text-muted-foreground">
            {selected
              ? "Threads are private to you"
              : canWrite
                ? "Keep it to yourself or share it with the team. Every thread with it starts private."
                : "Ask an admin or a member to share an agent with you."}
          </p>
        </div>
        <HomeComposer
          agents={agents}
          selected={selected}
          onSelect={setAgentId}
          canCreate={canWrite}
          onCreate={() => setCreateOpen(true)}
          className="mt-8"
        />
        {/* Directly under the composer, because this is the moment before
            spending — not buried in settings, where nobody looks until the
            replies have already stopped. Renders nothing when self-hosted. */}
        {credits && (
          <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            {credits.level !== "fine" && (
              <span className="h-2 w-2 shrink-0 rounded-full bg-brand" />
            )}
            {creditsSentence(credits)}
          </p>
        )}
        {/* Above the checklist, for the same reason the checklist itself sits
            under the composer rather than over it: this is scaffolding too,
            and a member who was never told the report exists cannot be said
            to have a real choice about it. Hidden on its own terms — see
            `CoverageNotice` — once the workspace has turned the report on,
            this person has been told, or they already opted out. */}
        <CoverageNotice
          workspaceId={me?.workspace.id ?? ""}
          enabled={me?.workspace.gapReportEnabled ?? false}
        />
        {/* The setup checklist used to sit here. It lives in the sidebar now
            (`setup-list.tsx`), where it is reachable from every page rather
            than from this one. */}
      </div>

      <div className="mx-auto w-full max-w-[1200px] space-y-20 px-5 pb-32 pt-24 lg:px-8">
        <AgentGallery
          agents={agents}
          favorites={favorites}
          sessions={sessions}
          members={members}
          myId={me?.user.id}
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
  selected,
  onSelect,
  canCreate,
  onCreate,
  className,
}: {
  agents: Agent[];
  /** The agent the hero above is introducing. */
  selected: Agent | undefined;
  onSelect: (id: string) => void;
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
      {/* The composer floats: white, a line, the one panel shadow. */}
      <div className="rounded-2xl border border-border bg-popover shadow-card transition-colors duration-200">
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
                : "No agents shared with you yet…"
              : `Message ${selected?.name ?? "your agent"}…`
          }
          disabled={empty}
          rows={3}
          className="resize-none border-0 bg-transparent px-5 pt-5 text-base shadow-none focus-visible:ring-0"
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
                Ask an admin or a member to share one with you.
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
                    <DropdownMenuItem key={a.id} onClick={() => onSelect(a.id)}>
                      <AgentAvatar emoji={a.emoji} className="h-6 w-6 text-sm" />
                      <span className="flex-1 truncate">{a.name}</span>
                    </DropdownMenuItem>
                  ))}
                </div>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Send is the amber dot: the primary button at icon size. */}
          <button
            onClick={() => void launch()}
            disabled={sending || empty || !text.trim()}
            aria-label="Send"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand text-brand-foreground transition-opacity duration-200 hover:opacity-90 disabled:opacity-40"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>
      {!empty && (
        <p className="mt-3 text-center text-meta text-micro-foreground">
          Enter to send · Shift + Enter for a new line
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
  members,
  myId,
  canCreate,
  onCreate,
}: {
  agents: Agent[];
  favorites: string[];
  sessions: ChatSession[];
  members: WorkspaceMember[];
  myId: string | undefined;
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
        title="Shared on purpose."
        turn="Talked to in private."
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
                ? "Make one for yourself or for the whole team — you choose who else can use it."
                : "Nobody has shared an agent with you yet. Ask an admin or a member to share one."
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
              members={members}
              myId={myId}
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
        className={cn("h-2 w-2 shrink-0 rounded-full", active ? "bg-brand" : "bg-transparent")}
      />
      {children}
    </button>
  );
}

function AgentCard({
  agent: a,
  favorite,
  members,
  myId,
  lastUsed,
}: {
  agent: Agent;
  favorite: boolean;
  members: WorkspaceMember[];
  myId: string | undefined;
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
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background",
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
          <div className="truncate text-title font-semibold leading-tight">{a.name}</div>
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
              ? "text-brand"
              : "text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100",
          )}
        >
          <Star className={cn("h-4 w-4", favorite && "fill-current")} />
        </button>
      </div>

      <p className="pointer-events-none mt-4 line-clamp-2 min-h-[2.6rem] text-base leading-snug text-muted-foreground">
        {a.persona}
      </p>

      <div className="pointer-events-none mt-4 flex items-center gap-2 border-t border-hairline pt-3 text-meta text-muted-foreground">
        <SharedWith agent={a} members={members} myId={myId} />
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
      <SectionHeading
        badge="Team activity"
        title="Threads start private."
        turn="Brainstorms are shared."
      />

      {rows.length === 0 ? (
        <EmptyState
          className="mt-10"
          title="Nothing shared yet"
          description="Threads start private; brainstorms are shared with the team from the start. Hit Share in a thread's header to let everyone read along."
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
          {sessionLabel(s)}
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
            <UserAvatar name={owner?.name} url={owner?.avatarUrl} className="h-6 w-6 text-[10px]" />
            <span className="max-w-[8rem] truncate text-meta text-muted-foreground">
              {owner?.name ?? owner?.email ?? "A teammate"}
            </span>
          </span>
          <span className="text-meta tabular-nums text-micro-foreground">
            {formatRelative(s.updatedAt)}
          </span>
        </span>
      }
    />
  );
}

/**
 * Who else has the agent, at the foot of its card: the people's faces when it
 * is shared by name, and a word when it is everyone or nobody. The amber square
 * marks an agent somebody else can reach, which is the live state worth seeing
 * across a gallery; one only you can reach takes the neutral square.
 */
function SharedWith({
  agent,
  members,
  myId,
}: {
  agent: Agent;
  members: WorkspaceMember[];
  myId: string | undefined;
}) {
  const { mode, label } = sharingSummary(agent, myId);
  if (mode === "people") {
    const byId = new Map(members.map((m) => [m.id, m]));
    const people = agent.shares.flatMap((s) => {
      const m = byId.get(s.userId);
      return m ? [m] : [];
    });
    return (
      <span className="inline-flex items-center gap-2">
        <AvatarStack people={people} max={3} className="h-6 w-6 text-[10px]" />
        <span className="tabular-nums">{label}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          mode === "workspace" ? "bg-brand" : "bg-border",
        )}
      />
      {mode === "workspace" ? "Everyone" : label}
    </span>
  );
}
