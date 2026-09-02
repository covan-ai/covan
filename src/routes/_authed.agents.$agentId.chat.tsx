import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Textarea } from "@/components/ui/textarea";
import { useAgentsStore, type ChatSession, type Message } from "@/lib/agents-store";
import { ApiError, api, getAccessToken } from "@/lib/api-client";
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
import { isPinnedToBottom } from "@/lib/chat-scroll";
import { mergeRealtimeMessage, optimisticId } from "@/lib/chat-messages";
import { SourceChip } from "@/components/source-chip";

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

  // Candidate ideas carry a local id rather than being keyed by their title.
  // The extractor is a language model reading a conversation, and it will
  // happily propose the same title twice — which collided as a React key, and
  // meant adding one of them to the board removed both from the list.
  const [suggestions, setSuggestions] = useState<
    { id: string; title: string; detail: string | null }[]
  >([]);
  const suggestMutation = useMutation({
    mutationFn: (sessionId: string) => api.brainstorm.suggest(sessionId),
    onSuccess: (res) => {
      setSuggestions(res.ideas.map((idea) => ({ ...idea, id: crypto.randomUUID() })));
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
      id: string;
      sessionId: string;
      title: string;
      detail: string | null;
    }) => api.ideas.create(sessionId, { title, detail: detail ?? undefined }),
    onSuccess: (_i, vars) => {
      setSuggestions((prev) => prev.filter((s) => s.id !== vars.id));
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
          const incoming: Message = {
            id: row.id,
            role: row.role,
            content: row.content,
            createdAt: new Date(row.created_at).getTime(),
          };
          queryClient.setQueryData<Message[]>(key, (old) =>
            mergeRealtimeMessage(old ?? [], incoming),
          );
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
  // The session whose revealed text is waiting for the server's copy to arrive.
  // Separate from `replyingIn` because the two end at different moments: the
  // composer is handed back the instant a stream stops, while the text that was
  // already on screen has to stay there until the refetch replaces it. Both
  // used to be the same flag, so the "keep it visible" delay below was keeping
  // nothing visible — the answer blinked out and blinked back 700ms later.
  const [settlingIn, setSettlingIn] = useState<string | null>(null);
  const streamAbort = useRef<AbortController | null>(null);
  // Tracks the pending reconcile timeout (from `stop()` or the drop-fallback
  // below) so a fast stop→resend can't let a stale timer fire mid-stream.
  const reconcileTimer = useRef<number | null>(null);
  // A send is in flight. `busy` cannot cover this on its own: it is derived
  // from state, and the gap between the click and React re-rendering is long
  // enough to fit a second click — which sent the same question twice.
  const sending = useRef(false);
  const busy = replyingIn !== null;

  useEffect(() => {
    return () => {
      streamAbort.current?.abort();
      if (reconcileTimer.current) window.clearTimeout(reconcileTimer.current);
    };
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Whether the reader is still following the bottom. Kept in a ref rather than
  // state because it changes on every scroll event and nothing renders from it.
  const pinned = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = isPinnedToBottom(el);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  // Opening a conversation starts at its end, wherever the last one was left.
  useEffect(() => {
    pinned.current = true;
  }, [active?.id]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinned.current) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
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
    setSettlingIn(null);
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
          } else if (event.type === "truncated") {
            // The model ran into its output cap. The answer stops mid-thought
            // and otherwise looks finished, which is the worst way for a reply
            // to be wrong: nothing on screen says the end is missing.
            toast.message("That answer hit its length limit — ask it to carry on.");
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
        setSettlingIn(hadPartial ? sessionId : null);
        if (reconcileTimer.current) window.clearTimeout(reconcileTimer.current);
        reconcileTimer.current = window.setTimeout(() => {
          setSettlingIn(null);
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
      setSettlingIn(null);
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
    setSettlingIn(sessionId);
    if (reconcileTimer.current) window.clearTimeout(reconcileTimer.current);
    reconcileTimer.current = window.setTimeout(() => {
      setSettlingIn(null);
      setStreamText("");
      invalidateMessages(sessionId);
    }, 700);
  };

  const submit = async (raw: string) => {
    const text = raw.trim();
    // `sending` as well as `busy`: see the ref's declaration. Two taps on a
    // starter card, or a double-click on send, used to post the same question
    // twice — the second one then found the stream already open and returned
    // without answering it, leaving a question in the transcript that nothing
    // ever replied to.
    if (!text || !active || busy || sending.current) return;
    sending.current = true;
    setInput("");
    // Sending is a deliberate move to the end of the conversation, even if the
    // reader had scrolled up.
    pinned.current = true;
    const sessionId = active.id;

    const key = ["messages", sessionId] as const;
    const optimistic: Message = {
      id: optimisticId(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    queryClient.setQueryData<Message[]>(key, (old = []) => [...old, optimistic]);

    try {
      try {
        await api.messages.create({ sessionId, role: "user", content: text });
      } catch {
        toast.error("Couldn't send your message.");
        // Hand the words back. The composer was cleared optimistically, so a
        // failed send used to destroy what had just been typed — the one thing
        // the person could not get back, and the thing they were most likely
        // to want after being told to try again. Anything typed in the
        // meantime wins; this only refills an empty box.
        setInput((draft) => (draft.trim().length > 0 ? draft : text));
        invalidateMessages(sessionId);
        return;
      }
      invalidateMessages(sessionId);
      await streamReply(sessionId);
    } finally {
      sending.current = false;
    }
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
    // instead; this one sends a message. `submit` sets state on the way, but
    // the state is a consequence of the send, not the point of the effect, and
    // there is nothing to derive it from: the draft is a handoff from another
    // route, it is deleted as it is read, and it can only go once the session
    // is loaded and still empty. Doing it during render would send a message
    // twice under StrictMode.
    void submit(draft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, messages.length, busy]);

  // Rewriting a conversation — regenerating a reply or editing a past turn —
  // discards every message after the anchor, and the delete policy is keyed to
  // whoever owns the session. A non-owner reading a shared thread gets a 403,
  // which is worth reading out rather than flattening into "couldn't update".
  const rewriteFailed = (e: unknown) => {
    const message =
      e instanceof ApiError && e.status === 403
        ? "Only the person who started this conversation can rewrite it."
        : "Couldn't update the conversation.";
    toast.error(message);
  };

  // Regenerate: drop the reply after a user turn and answer it again. The
  // user message is unchanged, so we only need its id to trim after it.
  const regenerate = async (userMessageId: string) => {
    if (!active || busy) return;
    try {
      await api.messages.deleteAfter(userMessageId);
    } catch (e) {
      rewriteFailed(e);
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
    } catch (e) {
      rewriteFailed(e);
      invalidateMessages(active.id);
      return;
    }
    invalidateMessages(active.id);
    await streamReply(active.id);
  };

  const [feedback, setFeedback] = useState<Record<string, "up" | "down">>({});
  const copyMessage = (content: string) => {
    navigator.clipboard?.writeText(content).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Couldn't copy"),
    );
  };
  // A mark on a reply, and nothing more: nothing stores it, no endpoint
  // receives it, and it is gone the moment this component unmounts. It used to
  // answer with "Thanks for the feedback" — a sentence about somebody having
  // received something, when nobody had. The highlighted thumb is the whole of
  // what happens, so it is now the whole of what is claimed. Wiring it to a
  // real store is a feature, not a fix, and needs a table to put it in.
  const rate = (id: string, v: "up" | "down") => {
    setFeedback((prev) => {
      const next = { ...prev };
      if (next[id] === v) delete next[id];
      else next[id] = v;
      return next;
    });
  };

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
                const fb = feedback[m.id];
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
                          label="Good response"
                          active={fb === "up"}
                          onClick={() => rate(m.id, "up")}
                        >
                          <ThumbsUp className="h-3.5 w-3.5" />
                        </MsgAction>
                        <MsgAction
                          label="Bad response"
                          active={fb === "down"}
                          onClick={() => rate(m.id, "down")}
                        >
                          <ThumbsDown className="h-3.5 w-3.5" />
                        </MsgAction>
                        {/* Ownership, not role — the same rule as Edit above,
                            and for the same reason. Regenerating discards
                            every message after the anchor, and
                            messages_delete_owner is keyed to whoever owns the
                            SESSION. Offered to a colleague reading a shared
                            thread it deleted nothing, reported nothing, and
                            then failed to answer a question that already had
                            an answer sitting under it. */}
                        {isLast && prevUser && isOwner && (
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

              {(replyingIn === active?.id || settlingIn === active?.id) && (
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
                        {/* No caret once the stream has stopped — this text is
                            waiting to be replaced by the server's copy, not
                            still arriving. */}
                        {replyingIn === active?.id && (
                          <span className="stream-caret ml-0.5 inline-block h-4 w-[3px] translate-y-0.5 rounded-sm bg-foreground/70 align-middle" />
                        )}
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
              {/* Stop belongs to the conversation that is actually streaming.
                  There is one stream at a time, so opening a second
                  conversation while a reply runs used to show a Stop button
                  over a composer with nothing to stop — and pressing it cut
                  off the answer in the tab you had just left. */}
              {replyingIn === active?.id ? (
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
                  disabled={!input.trim() || busy}
                  aria-label="Send message"
                  title={busy ? "Waiting for the current reply to finish" : undefined}
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
              <Sparkles className="h-4 w-4 text-muted-foreground" /> Idea board
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
                    key={s.id}
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
                          id: s.id,
                          sessionId: active.id,
                          title: s.title,
                          detail: s.detail,
                        })
                      }
                      className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-secondary"
                    >
                      Add to board
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
