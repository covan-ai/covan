import { useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import {
  BookOpen,
  Folder,
  Inbox,
  MessageSquare,
  SquarePen,
  Plus,
  Repeat,
  Send,
  Sparkles,
  SlidersVertical,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "@/i18n";
import { lookup, msg } from "@/i18n";
import { useLocale } from "@/i18n/provider";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { AgentMark } from "@/components/agent-mark";
import { StatusDot } from "@/components/status-dot";
import { Kbd } from "@/components/kbd";
import { FeedbackDialog } from "@/components/feedback-dialog";
import { api } from "@/lib/api-client";
import { useAgentsStore } from "@/lib/agents-store";
import { useInboxCounts } from "@/hooks/use-inbox";
import { useShell } from "@/lib/shell";
import { DOCS_HOME } from "@/lib/docs";
import { goKeyFor } from "@/lib/go-keys";
import { sessionLabel } from "@/lib/session-label";

/** The board's four first (A21), then the two the sidebar also names. */
const PAGES = [
  { to: "/inbox", label: msg("Inbox"), icon: Inbox },
  { to: "/knowledge", label: msg("Knowledge"), icon: Folder },
  { to: "/routines", label: msg("Routines"), icon: Repeat },
  { to: "/settings/general", label: msg("Settings"), icon: SlidersVertical },
  { to: "/threads", label: msg("Threads"), icon: MessageSquare },
  { to: "/team", label: msg("Team"), icon: Users },
] as const;

/**
 * ⌘K (A21): agents first — start a thread, or open the one running — then
 * pages, actions and, from three letters, messages. Typing ">" leaves only
 * the actions. Rendered once by the shell, which also answers its
 * "open-command-palette" event (the sidebar's Search, N outside an agent).
 */
export function CommandPalette({ agentId }: { agentId?: string }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // The highlighted row, so ⌘↵ knows which agent it is about.
  const [highlighted, setHighlighted] = useState("");
  const navigate = useNavigate();
  const shell = useShell();
  const { agents, sessions, favorites, canWrite, startSession, startBrainstorm } = useAgentsStore();
  const { data: counts } = useInboxCounts();

  const actionsOnly = query.startsWith(">");
  // Lowercased in the page's language, so a dotted capital I finds its lowercase.
  const q = (actionsOnly ? query.slice(1) : query).trim().toLocaleLowerCase(locale);
  const matches = (...words: string[]) =>
    !q || words.some((w) => w.toLocaleLowerCase(locale).includes(q));

  const { data: hits = [] } = useQuery({
    queryKey: ["search-messages", q],
    queryFn: () => api.search.messages(q, { limit: 5 }),
    enabled: open && !actionsOnly && q.length >= 3,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A shortcut, not a word: the key's own name is ASCII. i18n-ignore
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener("keydown", onKey);
    window.addEventListener("open-command-palette", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("open-command-palette", onOpen);
    };
  }, []);

  const close = () => {
    setOpen(false);
    setQuery("");
  };
  const run = (fn: () => void | Promise<void>) => {
    close();
    void fn();
  };
  const startThread = async (id: string) => {
    try {
      const s = await startSession(id);
      void navigate({ to: "/agents/$agentId/chat", params: { agentId: id }, search: { s: s.id } });
    } catch {
      toast.error(t("Couldn't start a new thread."));
    }
  };

  const sorted = [...agents].sort(
    (a, b) => Number(favorites.includes(b.id)) - Number(favorites.includes(a.id)),
  );
  const context = agents.find((a) => a.id === agentId) ?? sorted[0];
  const runningThread = (id: string) =>
    sessions.find((s) => s.agentId === id && s.state === "running");

  const item = (
    key: string,
    children: ReactNode,
    onSelect: () => void,
    keyHint?: string,
    tall = false,
  ) => (
    <CommandItem key={key} value={key} onSelect={onSelect} className={tall ? "group" : "group h-9"}>
      {children}
      {keyHint && <Kbd className="ml-auto">{keyHint}</Kbd>}
    </CommandItem>
  );

  const shownAgents = actionsOnly ? [] : sorted.filter((a) => matches(a.name));
  // A page is found by its translated name and by its English one, so
  // somebody who knows the product in English still lands.
  const shownPages = actionsOnly ? [] : PAGES.filter((p) => matches(lookup(t, p.label), p.label));
  const actions = [
    context && canWrite
      ? {
          key: "new-thread",
          label: t("New thread"),
          icon: SquarePen,
          hint: "N",
          run: () => startThread(context.id),
        }
      : null,
    canWrite
      ? { key: "new-agent", label: t("New agent"), icon: Plus, run: () => shell.openCreateAgent() }
      : null,
    context && canWrite
      ? {
          key: "new-brainstorm",
          label: t("New brainstorm with {{agent}}", { agent: context.name }),
          icon: Sparkles,
          run: async () => {
            const s = await startBrainstorm(context.id);
            void navigate({
              to: "/agents/$agentId/chat",
              params: { agentId: context.id },
              search: { s: s.id },
            });
          },
        }
      : null,
    canWrite
      ? {
          key: "upload",
          label: t("Upload to Knowledge"),
          icon: Upload,
          run: () => navigate({ to: "/knowledge" }),
        }
      : null,
    {
      key: "invite",
      label: t("Invite a member"),
      icon: UserPlus,
      run: () => navigate({ to: "/team", search: { invite: true } }),
    },
    { key: "feedback", label: t("Send feedback"), icon: Send, run: () => setFeedbackOpen(true) },
    {
      key: "docs",
      label: t("Documentation"),
      icon: BookOpen,
      run: () => window.open(DOCS_HOME, "_blank", "noreferrer"),
    },
  ].filter((a): a is NonNullable<typeof a> => a !== null && matches(a.label));

  return (
    <>
      <CommandDialog
        open={open}
        onOpenChange={(v) => (v ? setOpen(true) : close())}
        label={t("Command palette")}
        commandProps={{
          shouldFilter: false,
          value: highlighted,
          onValueChange: setHighlighted,
          onKeyDown: (e) => {
            // ⌘↵ on an agent: always a new thread, even beside a running one.
            if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
            if (!highlighted.startsWith("agent-")) return;
            e.preventDefault();
            run(() => startThread(highlighted.slice("agent-".length)));
          },
        }}
        footer={
          <>
            <span className="flex items-center gap-1">
              <Kbd>↑</Kbd> <Kbd>↓</Kbd> {t("Navigate")}
            </span>
            <span className="flex items-center gap-1">
              <Kbd>↵</Kbd> {t("Open")}
            </span>
            <span className="flex items-center gap-1 max-sm:hidden">
              <Kbd>⌘</Kbd>
              <Kbd>↵</Kbd> {t("New thread with agent")}
            </span>
            <span className="ml-auto flex items-center gap-1 max-sm:hidden">
              <Trans
                t={t}
                i18nKey="Type <kbd>{{key}}</kbd> for commands"
                values={{ key: ">" }}
                components={{ kbd: <Kbd>{null}</Kbd> }}
              />
            </span>
          </>
        }
      >
        <CommandInput
          placeholder={t("Search threads, agents and pages, or type a command…")}
          value={query}
          onValueChange={setQuery}
        />
        <CommandList className="max-h-[min(60vh,440px)]">
          <CommandEmpty>{t("Nothing matches.")}</CommandEmpty>

          {shownAgents.length > 0 && (
            <CommandGroup heading={t("Agents")}>
              {shownAgents.map((a) => {
                const running = runningThread(a.id);
                return item(
                  `agent-${a.id}`,
                  <>
                    <AgentMark agent={a} size={24} />
                    <span className="font-medium">{a.name}</span>
                    <span className="min-w-0 truncate text-meta text-muted-foreground">
                      {running
                        ? t("Running · {{thread}}", { thread: sessionLabel(running, t) })
                        : t("Start a thread")}
                    </span>
                    <span className="ml-auto flex items-center gap-2">
                      {running && <StatusDot state="running" />}
                      <Kbd className="hidden group-data-[selected=true]:inline-flex">↵</Kbd>
                    </span>
                  </>,
                  () =>
                    run(() =>
                      running
                        ? navigate({
                            to: "/agents/$agentId/chat",
                            params: { agentId: a.id },
                            search: { s: running.id },
                          })
                        : startThread(a.id),
                    ),
                  undefined,
                  true,
                );
              })}
            </CommandGroup>
          )}

          {shownPages.length > 0 && (
            <CommandGroup heading={t("Pages")}>
              {shownPages.map((p) =>
                item(
                  `page-${p.to}`,
                  <>
                    <p.icon className="size-4 text-muted-foreground" strokeWidth={1.75} />
                    {lookup(t, p.label)}
                    {p.to === "/inbox" && counts && counts.needsYou > 0 && (
                      <span className="text-meta text-muted-foreground">
                        {t("{{count}} needs you", {
                          count: counts.needsYou,
                          defaultValue_other: "{{count}} need you",
                        })}
                      </span>
                    )}
                  </>,
                  () => run(() => navigate({ to: p.to })),
                  goKeyFor(p.to),
                ),
              )}
            </CommandGroup>
          )}

          {actions.length > 0 && (
            <CommandGroup heading={t("Actions")}>
              {actions.map((a) =>
                item(
                  `action-${a.key}`,
                  <>
                    <a.icon className="size-4 text-muted-foreground" strokeWidth={1.75} />
                    {a.label}
                  </>,
                  () => run(a.run),
                  a.hint,
                ),
              )}
            </CommandGroup>
          )}

          {hits.length > 0 && (
            <CommandGroup heading={t("Messages")}>
              {hits.map((m) =>
                item(
                  `message-${m.id}`,
                  <>
                    <MessageSquare
                      className="size-4 shrink-0 text-muted-foreground"
                      strokeWidth={1.75}
                    />
                    <span className="line-clamp-1 min-w-0 flex-1">{m.content}</span>
                    {m.sessionTitle && (
                      <span className="shrink-0 text-meta text-muted-foreground">
                        {m.sessionTitle}
                      </span>
                    )}
                  </>,
                  () => {
                    if (!m.sessionId || !m.agentId) return;
                    const { sessionId, agentId: id } = m;
                    run(() =>
                      navigate({
                        to: "/agents/$agentId/chat",
                        params: { agentId: id },
                        search: { s: sessionId },
                      }),
                    );
                  },
                ),
              )}
            </CommandGroup>
          )}
        </CommandList>
      </CommandDialog>
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} path="/" />
    </>
  );
}
