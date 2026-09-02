import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Textarea } from "@/components/ui/textarea";
import { useAgentsStore, type ChatSession, type Message } from "@/lib/agents-store";
import { api, getAccessToken, type FeedbackKind } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { IdeaBoard } from "@/components/idea-board";
import {
  ArrowUp,
  Copy,
  FileText,
  Lock,
  Pencil,
  RefreshCw,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  Upload,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { AgentAvatar } from "@/components/avatars";
import { ChatAttach, ChatReceipts } from "@/components/chat-attach";
import { ChatMic } from "@/components/chat-mic";
import { appendDictation, useDictation } from "@/lib/use-dictation";
import { useChatUploads } from "@/lib/use-chat-uploads";
import { useQuota, quotaSentence } from "@/lib/quota";
import { startersFor } from "@/lib/chat-starters";
import { SourceChip } from "@/components/source-chip";
import { FeedbackDialog } from "@/components/feedback-dialog";

export const Route = createFileRoute("/_authed/agents/$agentId/chat")({
  component: ChatTab,
  validateSearch: (search: Record<string, unknown>): { s?: string } => ({
    s: typeof search.s === "string" ? search.s : undefined,
  }),
});

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ChatTab() {
  const { agentId } = Route.useParams();
  const { s: activeId } = Route.useSearch();
  const navigate = useNavigate();
  const { agents, sessions, startSession, canWrite } = useAgentsStore();
  const agent = agents.find((a) => a.id === agentId)!;
  const queryClient = useQueryClient();

  // Files dropped, pasted or picked in this conversation. They land in the
  // agent's chat bundle, which is created on the first one.
  const uploads = useChatUploads(agent);
  const [dragging, setDragging] = useState(false);

  // Named after a real file once one is indexed, so the first tap on a fresh
  // agent returns an answer with a citation on it rather than a general one.
  const starters = useMemo(() => startersFor(agent.documents), [agent.documents]);

  // Citations carry a document id; the age lives on the agent's document list,
  // which this screen already has. Resolved by id rather than by name on
  // purpose — two documents can share a name, and a chip that dated an answer
  // from the wrong file would be worse than one that says nothing.
  const uploadedAt = useMemo(
    () => new Map(agent.documents.map((d) => [d.id, d.createdAt])),
    [agent.documents],
  );

  // Only the hosted service meters anything; self-hosted installs answer with
  // `limit: null` and nothing below renders. Refetched by the invalidation that
  // already follows every reply, which is exactly when the number moves.
  // An allowance nobody can see is a trap: the first a user hears of it is the
  // reply that doesn't come. So it is on screen from the first message — as a
  // quiet line in the composer footer while there is room, and as a banner once
  // it is nearly gone. `useQuota` returns null on a self-hosted install, where
  // there is no allowance and none of this renders.
  const quota = useQuota();

  const agentSessions = useMemo(
    () => sessions.filter((s) => s.agentId === agentId).sort((a, b) => b.updatedAt - a.updatedAt),
    [sessions, agentId],
  );
  const active: ChatSession | undefined =
    agentSessions.find((s) => s.id === activeId) ?? agentSessions[0];

  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const currentUserId = me?.user.id;
  const isOwner = !!active && active.ownerId === currentUserId;
  const isShared = active?.visibility === "shared";
  const isBrainstorm = active?.kind === "brainstorm";
  const setVisibilityMutation = useMutation({
    mutationFn: ({ id, visibility }: { id: string; visibility: "private" | "shared" }) =>
      api.sessions.setVisibility(id, visibility),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sessions"] }),
  });

  const [suggestions, setSuggestions] = useState<{ title: string; detail: string | null }[]>([]);
  const suggestMutation = useMutation({
    mutationFn: (sessionId: string) => api.brainstorm.suggest(sessionId),
    onSuccess: (res) => {
      setSuggestions(res.ideas);
      if (res.ideas.length === 0) toast.message("No clear ideas to extract yet.");
    },
    onError: () => toast.error("Could not extract ideas."),
  });
  const addIdeaMutation = useMutation({
    mutationFn: ({
      sessionId,
      title,
      detail,
    }: {
      sessionId: string;
      title: string;
      detail: string | null;
    }) => api.ideas.create(sessionId, { title, detail: detail ?? undefined }),
    onSuccess: (_i, vars) => {
      setSuggestions((prev) => prev.filter((s) => s.title !== vars.title));
      void queryClient.invalidateQueries({ queryKey: ["ideas", vars.sessionId] });
      toast.success("Added to the board");
    },
    onError: () => toast.error("Could not add it to the board."),
  });

  // Messages for the active session live under their own query — the store's
  // `sessions` no longer carry messages.
  const { data: messages = [] } = useQuery({
    queryKey: ["messages", active?.id],
    queryFn: () => api.sessions.messages(active!.id),
    enabled: !!active?.id,
  });

  // Make sure a session always exists, and keep the URL pointing at the active
  // one so the sidebar highlight and this view stay in sync.
  const initedFor = useRef<string | null>(null);
  useEffect(() => {
    if (agentSessions.length === 0) {
      if (initedFor.current === agentId) return;
      initedFor.current = agentId;
      void startSession(agentId).then((s) => {
        navigate({
          to: "/agents/$agentId/chat",
          params: { agentId },
          search: { s: s.id },
          replace: true,
        });
      });
    } else if (active && activeId !== active.id) {
      navigate({
        to: "/agents/$agentId/chat",
        params: { agentId },
        search: { s: active.id },
        replace: true,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, activeId, agentSessions.length]);

  // Live-sync peer + assistant messages for shared sessions. Private
  // sessions never open a subscription.
  useEffect(() => {
    if (!activeId || active?.visibility !== "shared") return;

    const channel = supabase
      .channel(`messages:${activeId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `session_id=eq.${activeId}`,
        },
        (payload) => {
          const row = payload.new as {
            id: string;
            role: "user" | "assistant";
            content: string;
            created_at: string;
          };
          const key = ["messages", activeId] as const;
          queryClient.setQueryData<Message[]>(key, (old) => {
            const list = old ?? [];
            if (list.some((m) => m.id === row.id)) return list; // dedupe by id
            const incoming: Message = {
              id: row.id,
              role: row.role,
              content: row.content,
              createdAt: new Date(row.created_at).getTime(),
            };
            return [...list, incoming];
          });
          // Refetch so embedded sender/sources (not in the Realtime payload) fill in.
          void queryClient.invalidateQueries({ queryKey: ["messages", activeId] });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeId, active?.visibility, queryClient]);

  const [input, setInput] = useState("");
  // Spoken into the composer rather than typed. The transcript is appended to
  // the draft and left there — nothing is sent until the person sends it, since
  // a transcription is a guess and this is where they get to correct it.
  const dictation = useDictation(
    useCallback((text: string) => setInput((draft) => appendDictation(draft, text)), []),
  );
  // Reply-in-progress state, scoped to the session it belongs to. `thinking`
  // shows the typing bubble; `streamText` reveals the answer character by
  // character before it's committed to the store.
  const [replyingIn, setReplyingIn] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [streamText, setStreamText] = useState("");
  const streamAbort = useRef<AbortController | null>(null);
  // Tracks the pending reconcile timeout (from `stop()` or the drop-fallback
  // below) so a fast stop→resend can't let a stale timer fire mid-stream.
  const reconcileTimer = useRef<number | null>(null);
  const busy = replyingIn !== null;

  useEffect(() => {
    return () => streamAbort.current?.abort();
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages.length, thinking, streamText]);

  const invalidateMessages = (sessionId: string) => {
    void queryClient.invalidateQueries({ queryKey: ["messages", sessionId] });
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    // Token usage changed with the new reply — refresh the dashboard figures.
    void queryClient.invalidateQueries({ queryKey: ["usage"] });
  };

  // Stream a real reply for `sessionId` from the Worker's SSE endpoint. The
  // session's message history (already persisted) is read server-side, so
  // the caller only needs to make sure the latest user turn has landed.
  const streamReply = async (sessionId: string) => {
    if (streamAbort.current) return;
    if (reconcileTimer.current) {
      window.clearTimeout(reconcileTimer.current);
      reconcileTimer.current = null;
    }
    setReplyingIn(sessionId);
    setThinking(true);
    setStreamText("");

    const controller = new AbortController();
    streamAbort.current = controller;
    let partial = "";

    try {
      const token = await getAccessToken();
      const res = await fetch(`${import.meta.env.VITE_API_URL}/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ sessionId }),
        signal: controller.signal,
      });

      if (res.status === 402) {
        // Out of allowance. The user's message is already saved, so the
        // conversation isn't lost — only the reply is refused.
        const body = (await res.json().catch(() => null)) as { resetsAt?: string } | null;
        const resets = body?.resetsAt
          ? new Date(body.resetsAt).toLocaleDateString(undefined, {
              month: "long",
              day: "numeric",
            })
          : null;
        toast.error(
          resets
            ? `You've used this month's allowance. It resets on ${resets}.`
            : "You've used this month's allowance.",
        );
        setThinking(false);
        setStreamText("");
        setReplyingIn(null);
        void queryClient.invalidateQueries({ queryKey: ["usage"] });
        return;
      }

      if (!res.ok || !res.body) {
        toast.error("Couldn't reach the assistant. Please try again.");
        setThinking(false);
        setStreamText("");
        setReplyingIn(null);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let terminalSeen = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";

        for (const block of blocks) {
          const line = block.trim();
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice("data: ".length);
          let event: { type: string; text?: string; message?: Message; error?: string };
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }

          if (event.type === "delta" && typeof event.text === "string") {
            setThinking(false);
            partial += event.text;
            setStreamText(partial);
          } else if (event.type === "done") {
            terminalSeen = true;
            setStreamText("");
            setThinking(false);
            setReplyingIn(null);
            invalidateMessages(sessionId);
          } else if (event.type === "error") {
            terminalSeen = true;
            toast.error(event.error ?? "The assistant hit an error.");
            setStreamText("");
            setThinking(false);
            setReplyingIn(null);
          }
        }
      }

      if (!terminalSeen && !controller.signal.aborted) {
        setThinking(false);
        setReplyingIn(null);
        // The server persists the partial (service-role) when the connection
        // drops before a terminal event; keep the revealed text visible until
        // the refetch reconciles so it doesn't flash out.
        const hadPartial = partial.trim().length > 0;
        if (reconcileTimer.current) window.clearTimeout(reconcileTimer.current);
        reconcileTimer.current = window.setTimeout(() => {
          setStreamText("");
          invalidateMessages(sessionId);
        }, 700);
        if (hadPartial) toast.error("The connection dropped before the reply finished.");
      }
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (isAbort) {
        // Handled by `stop()`, which owns reconciling from the server.
        return;
      }
      toast.error("The assistant hit an error.");
      setStreamText("");
      setThinking(false);
      setReplyingIn(null);
    } finally {
      streamAbort.current = null;
    }
  };

  // Stop streaming and keep whatever has been revealed so far. The server
  // persists the partial (service-role) on abort, so the client only needs
  // to reconcile from it — keep the revealed text visible until the refetch
  // lands so it doesn't flash out.
  const stop = () => {
    if (!replyingIn) return;
    const sessionId = replyingIn;
    streamAbort.current?.abort();
    // Cleared here as well as in the stream's own finally: that runs a
    // microtask later, and a resend started in between would find a stale
    // handle and return without doing anything.
    streamAbort.current = null;
    setThinking(false);
    setReplyingIn(null);
    if (reconcileTimer.current) window.clearTimeout(reconcileTimer.current);
    reconcileTimer.current = window.setTimeout(() => {
      setStreamText("");
      invalidateMessages(sessionId);
    }, 700);
  };

  const submit = async (raw: string) => {
    const text = raw.trim();
    if (!text || !active || busy) return;
    setInput("");
    const sessionId = active.id;

    const key = ["messages", sessionId] as const;
    const optimistic: Message = {
      id: `temp-${crypto.randomUUID()}`,
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    queryClient.setQueryData<Message[]>(key, (old = []) => [...old, optimistic]);

    try {
      await api.messages.create({ sessionId, role: "user", content: text });
    } catch {
      toast.error("Couldn't send your message.");
      invalidateMessages(sessionId);
      return;
    }
    invalidateMessages(sessionId);
    await streamReply(sessionId);
  };

  const send = () => void submit(input);

  // The home composer stashes the first message under `chat-draft:<id>` and
  // opens this route. When the session lands empty, send that draft once.
  const draftConsumed = useRef<string | null>(null);
  useEffect(() => {
    if (!active || busy || messages.length > 0) return;
    if (draftConsumed.current === active.id) return;
    let draft: string | null;
    try {
      draft = sessionStorage.getItem(`chat-draft:${active.id}`);
    } catch {
      draft = null;
    }
    if (!draft) return;
    draftConsumed.current = active.id;
    try {
      sessionStorage.removeItem(`chat-draft:${active.id}`);
    } catch {
      /* ignore */
    }
    // The last of the eleven in #68, and the one that stays. The other ten were
    // effects copying something into state that could have been read or derived
    // instead; this one sends a message. `submit` sets state on the way — that
    // is what the rule sees — but the state is a consequence of the send, not
    // the point of the effect, and there is nothing to derive it from: the
    // draft is a handoff from another route, it is deleted as it is read, and
    // it can only go once the session is loaded and still empty. Doing it
    // during render would send a message twice under StrictMode.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void submit(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, messages.length, busy]);

  // Regenerate: drop the reply after a user turn and answer it again. The
  // user message is unchanged, so we only need its id to trim after it.
  const regenerate = async (userMessageId: string) => {
    if (!active || busy) return;
    try {
      await api.messages.deleteAfter(userMessageId);
    } catch {
      toast.error("Couldn't update the conversation.");
      invalidateMessages(active.id);
      return;
    }
    invalidateMessages(active.id);
    await streamReply(active.id);
  };

  // Edit a past user message, discard everything after it, and re-answer.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const startEdit = (id: string, content: string) => {
    setEditingId(id);
    setEditText(content);
  };
  const saveEdit = async (id: string) => {
    const text = editText.trim();
    if (!active || !text || busy) return;
    setEditingId(null);
    try {
      await api.messages.update(id, text);
      await api.messages.deleteAfter(id);
    } catch {
      toast.error("Couldn't update the conversation.");
      invalidateMessages(active.id);
      return;
    }
    invalidateMessages(active.id);
    await streamReply(active.id);
  };

  const copyMessage = (content: string) => {
    navigator.clipboard?.writeText(content).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Couldn't copy"),
    );
  };

  /**
   * Which answer somebody is writing about, and which thumb opened the box.
   *
   * These two buttons used to be a `useState` map and a toast that said "Thanks
   * for the feedback". Nothing was stored, nothing read it, and it was gone on
   * reload — the same shape of bug the sign-in page's Remember me box had.
   *
   * They are not a rating now, because a rating has to be changeable and
   * `feedback` is deliberately immutable (0039). They open the same box the
   * sidebar opens, with the kind chosen and the answer attached, so what the
   * operator gets is a sentence about a specific reply rather than a tally.
   */
  const [rating, setRating] = useState<{ messageId: string; kind: FeedbackKind } | null>(null);

  const isEmpty = !active || messages.length === 0;

  const chatPane = (
    <section
      className="relative flex h-[calc(100dvh-3.5rem)] min-h-0 flex-col lg:h-screen"
      // The whole pane takes a drop, not just the composer: a file dragged at a
      // conversation is aimed at the conversation, and a 40px target under the
      // text is a worse answer than the obvious one.
      onDragOver={(e) => {
        if (!canWrite || !e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        // Fires on every child boundary too; only the pane itself ends the drag.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        if (!canWrite) return;
        e.preventDefault();
        setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length > 0) void uploads.addFiles(files);
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-xl border border-dashed border-accent-orange bg-background/80">
          <div className="flex flex-col items-center gap-2">
            <Upload className="h-6 w-6 text-accent-orange" />
            <div className="font-dm text-[17px] font-medium">Drop to add to {agent.name}</div>
            <div className="text-xs text-muted-foreground">TXT, Markdown, CSV, JSON, PDF</div>
          </div>
        </div>
      )}
      {/* Conversation header */}
      <div className="flex items-center justify-between gap-3 border-b border-border bg-background/80 px-4 py-3 backdrop-blur lg:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <AgentAvatar emoji={agent.emoji} tone="accent" className="h-9 w-9 text-base" />
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2 text-sm font-semibold leading-tight">
              <span className="truncate">{agent.name}</span>
              {agent.mode === "brainstorm" && (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  🧠 Brainstorm
                </span>
              )}
            </div>
            <div className="truncate text-xs leading-tight text-muted-foreground">
              {agent.model} · {isShared ? "shared with your workspace" : "private to you"}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {isOwner && active && (
            <button
              type="button"
              onClick={() =>
                setVisibilityMutation.mutate({
                  id: active.id,
                  visibility: isShared ? "private" : "shared",
                })
              }
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-secondary"
            >
              <Users className="h-3.5 w-3.5" />
              {isShared ? "Shared" : "Share"}
            </button>
          )}
          {/* Owners get the toggle above; everyone else gets the read-only
              state. One home per control (DESIGN.md §5). */}
          {!isOwner && (
            <span className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground sm:inline-flex">
              {isShared ? (
                <>
                  <Users className="h-3 w-3" />
                  Shared
                </>
              ) : (
                <>
                  <Lock className="h-3 w-3" />
                  Private
                </>
              )}
            </span>
          )}
        </div>
      </div>

      {/* Conversation */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-background">
        <div
          className={cn(
            "mx-auto flex min-h-full w-full max-w-3xl flex-col px-4 py-8 lg:px-6",
            isEmpty && "items-center justify-center",
          )}
        >
          {isEmpty ? (
            <div className="w-full max-w-md text-center">
              <AgentAvatar
                emoji={agent.emoji}
                tone="accent"
                className="mx-auto h-16 w-16 rounded-xl text-3xl"
              />
              <h3 className="mt-5 font-dm text-[28px] font-medium leading-[1.05] tracking-[-0.01em]">
                {agent.name}
              </h3>
              <p className="mx-auto mt-2 max-w-xs text-[15px] leading-[1.45] text-muted-foreground">
                Ask anything — this chat is private to you, grounded in your team's shared
                knowledge.
              </p>
              <div className="mt-8 grid gap-2.5 sm:grid-cols-2">
                {starters.map((s) => (
                  <button
                    key={s}
                    onClick={() => void submit(s)}
                    className="rounded-md border border-border bg-surface px-4 py-3 text-left text-sm transition-colors duration-200 hover:bg-surface-hover"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-8">
              {messages.map((m, idx, arr) => {
                // `role`, not ownership — this decides the LAYOUT. A
                // teammate's message in a shared session is still somebody's
                // turn and still draws as one, with their name above it.
                const isPersonsTurn = m.role === "user";
                if (isPersonsTurn) {
                  if (editingId === m.id) {
                    return (
                      <div key={m.id} className="flex flex-col items-end gap-1.5">
                        <div className="w-full max-w-[560px] rounded-2xl bg-popover p-2 shadow-card">
                          <Textarea
                            value={editText}
                            onChange={(e) => setEditText(e.target.value)}
                            rows={2}
                            autoFocus
                            className="min-h-[40px] resize-none border-0 bg-transparent p-1.5 text-sm shadow-none focus-visible:ring-0"
                          />
                          <div className="flex justify-end gap-1.5 pt-1">
                            <button
                              onClick={() => setEditingId(null)}
                              className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => void saveEdit(m.id)}
                              disabled={!editText.trim()}
                              className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                            >
                              Save & send
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={m.id} className="group flex flex-col items-end gap-1">
                      {isShared && m.sender && (
                        <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                          {m.sender.avatarUrl ? (
                            <img src={m.sender.avatarUrl} alt="" className="h-4 w-4 rounded-full" />
                          ) : null}
                          <span>{m.sender.name ?? "Someone"}</span>
                        </div>
                      )}
                      <span className="px-1 text-xs text-muted-foreground">
                        {formatTime(m.createdAt)}
                      </span>
                      <div className="max-w-[560px] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-4 py-3 text-[15px] leading-[1.45] text-primary-foreground">
                        {m.content}
                      </div>
                      {/* Ownership, not role. This used to branch on the same
                          flag as the layout above, so in a shared session an
                          Edit button appeared over a colleague's message —
                          and answered 404, because messages_update_owner is
                          keyed to whoever owns the SESSION. Editing also
                          discards every reply after the edited turn, which is
                          not something to offer over somebody else's
                          conversation even if the policy allowed it. */}
                      {isOwner && (
                        <button
                          onClick={() => startEdit(m.id, m.content)}
                          disabled={busy}
                          className="flex items-center gap-1 px-1 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100 disabled:hidden"
                        >
                          <Pencil className="h-3 w-3" /> Edit
                        </button>
                      )}
                    </div>
                  );
                }
                const sources = m.sources ?? [];
                const prevUser = idx > 0 && arr[idx - 1].role === "user" ? arr[idx - 1] : null;
                const isLast = idx === arr.length - 1;
                return (
                  <div key={m.id} className="group flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <AgentAvatar emoji={agent.emoji} className="h-7 w-7 text-sm" />
                      <span className="text-sm font-semibold">{agent.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {formatTime(m.createdAt)}
                      </span>
                    </div>
                    <div className="pl-9">
                      <Markdown
                        content={m.content}
                        className="text-[15px] leading-relaxed text-foreground"
                      />

                      {sources.length > 0 && (
                        <div className="mt-3 flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">Sources</span>
                          {sources.map((source, i) => (
                            <SourceChip
                              key={source.id ?? `${source.name}:${i}`}
                              source={source}
                              uploadedAt={source.id ? uploadedAt.get(source.id) : undefined}
                            />
                          ))}
                        </div>
                      )}

                      <div className="mt-2 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <MsgAction label="Copy" onClick={() => copyMessage(m.content)}>
                          <Copy className="h-3.5 w-3.5" />
                        </MsgAction>
                        <MsgAction
                          label="This answer was good — say why"
                          onClick={() => setRating({ messageId: m.id, kind: "other" })}
                        >
                          <ThumbsUp className="h-3.5 w-3.5" />
                        </MsgAction>
                        <MsgAction
                          label="Something's wrong with this answer"
                          onClick={() => setRating({ messageId: m.id, kind: "problem" })}
                        >
                          <ThumbsDown className="h-3.5 w-3.5" />
                        </MsgAction>
                        {isLast && prevUser && (
                          <MsgAction
                            label="Regenerate"
                            onClick={() => void regenerate(prevUser.id)}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </MsgAction>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}

              {replyingIn === active?.id && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <AgentAvatar emoji={agent.emoji} className="h-7 w-7 text-sm" />
                    <span className="text-sm font-semibold">{agent.name}</span>
                  </div>
                  <div className="pl-9">
                    {thinking ? (
                      <div
                        className="flex items-center gap-1.5 text-xs text-muted-foreground"
                        aria-label={`${agent.name} is thinking`}
                      >
                        <span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground" />
                        <span
                          className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground"
                          style={{ animationDelay: "0.15s" }}
                        />
                        <span
                          className="typing-dot h-1.5 w-1.5 rounded-full bg-muted-foreground"
                          style={{ animationDelay: "0.3s" }}
                        />
                        <span className="ml-1">Thinking…</span>
                      </div>
                    ) : (
                      <span className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
                        {streamText}
                        <span className="stream-caret ml-0.5 inline-block h-4 w-[3px] translate-y-0.5 rounded-sm bg-foreground/70 align-middle" />
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Composer */}
      <div className="border-t border-border bg-background px-4 pb-4 pt-3 lg:px-6">
        <div className="mx-auto max-w-3xl">
          {quota && quota.level !== "fine" && (
            <div className="mb-2 flex items-center gap-2 rounded-sm border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              <span className="h-2 w-2 shrink-0 bg-accent-orange" />
              <span>{quotaSentence(quota)}</span>
            </div>
          )}
          <div className="rounded-3xl bg-popover shadow-card transition-colors duration-200">
            <ChatReceipts uploads={uploads} />
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={(e) => {
                // A file on the clipboard is an upload; text on the clipboard is
                // just typing, and must fall through untouched.
                const files = Array.from(e.clipboardData.files);
                if (!canWrite || files.length === 0) return;
                e.preventDefault();
                void uploads.addFiles(files);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={`Message ${agent.name}`}
              rows={1}
              className="max-h-44 min-h-[44px] w-full resize-none border-0 bg-transparent px-4 pt-3 text-sm shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between px-3 pb-2.5">
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-sm bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                  <span className="text-sm leading-none">{agent.emoji}</span>
                  {agent.name}
                </span>
                <ChatAttach uploads={uploads} canWrite={canWrite} />
                <ChatMic dictation={dictation} />
              </div>
              {busy ? (
                <button
                  onClick={stop}
                  aria-label="Stop generating"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-foreground text-background transition-opacity duration-200 hover:opacity-90"
                >
                  <Square className="h-3.5 w-3.5 fill-current" />
                </button>
              ) : (
                <button
                  onClick={send}
                  disabled={!input.trim()}
                  aria-label="Send message"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-accent-orange text-[#251f19] transition-opacity duration-200 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ArrowUp className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
          <p className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            {isShared ? <Users className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
            {isShared ? "Shared with your workspace" : "Private to you"} · grounded in{" "}
            {agent.documents.length} team {agent.documents.length === 1 ? "document" : "documents"}
            {quota?.level === "fine" && <> · {quotaSentence(quota)}</>}
          </p>
        </div>
      </div>

      {/* Inside the pane so both layouts get it — the brainstorm view returns a
          split panel around this same variable. Radix portals it either way. */}
      <FeedbackDialog
        // Remounts per answer, so a note started under one reply cannot appear
        // under the next one.
        key={rating?.messageId ?? "none"}
        open={rating !== null}
        onOpenChange={(next) => {
          if (!next) setRating(null);
        }}
        path={`/agents/${agentId}/chat`}
        about={rating ? { messageId: rating.messageId, label: `${agent.name}'s answer` } : null}
        initialKind={rating?.kind ?? null}
      />
    </section>
  );

  if (!isBrainstorm || !active) return chatPane;

  return (
    <ResizablePanelGroup className="h-[calc(100dvh-3.5rem)] lg:h-screen">
      <ResizablePanel defaultSize="55" minSize="35">
        {chatPane}
      </ResizablePanel>
      <ResizableHandle className="w-1 bg-border transition-colors hover:bg-primary/40" />
      <ResizablePanel defaultSize="45" minSize="25">
        <div className="flex h-full flex-col border-l border-border">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="h-4 w-4 text-muted-foreground" /> Fikir Panosu
            </div>
            {/* Secondary on purpose: the composer's send is this view's one
                primary action (DESIGN.md §2). */}
            <button
              type="button"
              onClick={() => suggestMutation.mutate(active.id)}
              disabled={suggestMutation.isPending}
              className="rounded-md border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-accent disabled:opacity-40"
            >
              {suggestMutation.isPending ? "Extracting…" : "Extract ideas"}
            </button>
          </div>
          {suggestions.length > 0 && (
            <div className="border-b border-border bg-muted/30 p-2">
              <div className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">
                Candidate ideas — click to add one to the board
              </div>
              <div className="flex flex-col gap-1.5">
                {suggestions.map((s) => (
                  <div
                    key={s.title}
                    className="flex items-start justify-between gap-2 rounded-lg border border-border bg-card p-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{s.title}</div>
                      {s.detail && <div className="text-xs text-muted-foreground">{s.detail}</div>}
                    </div>
                    <button
                      type="button"
                      onClick={() =>
                        addIdeaMutation.mutate({
                          sessionId: active.id,
                          title: s.title,
                          detail: s.detail,
                        })
                      }
                      className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-secondary"
                    >
                      Board'a ekle
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="min-h-0 flex-1">
            <IdeaBoard sessionId={active.id} />
          </div>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function MsgAction({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-accent",
        active ? "text-primary" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
