import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { Textarea } from "@/components/ui/textarea";
import { useAgentsStore, type ChatSession, type Message } from "@/lib/agents-store";
import { ApiError, api, getAccessToken, type FeedbackKind } from "@/lib/api-client";
import { supabase } from "@/lib/supabase/client";
import { IdeaBoard } from "@/components/idea-board";
import {
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  Lock,
  Pencil,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  ThumbsDown,
  ThumbsUp,
  Upload,
  Users,
  Volume2,
  VolumeX,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Markdown } from "@/components/markdown";
import { AgentAvatar } from "@/components/avatars";
import { ChatAttach, ChatReceipts } from "@/components/chat-attach";
import { ChatReport, ChatReportReceipt } from "@/components/chat-report";
import { ChatMic } from "@/components/chat-mic";
import { appendDictation, useDictation } from "@/lib/use-dictation";
import { useChatUploads } from "@/lib/use-chat-uploads";
import { useReportWriter } from "@/lib/use-report";
import { parseReportCommand } from "@/lib/reports";
import { useQuota, quotaSentence } from "@/lib/quota";
import { startersFor } from "@/lib/chat-starters";
import { modelsFor } from "@/lib/agent-meta";
import { estimateCostUsd, formatCost, formatTokens } from "@/lib/pricing";
import { groupMessagesByDate } from "@/lib/message-groups";
import { useTTS } from "@/lib/use-tts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { isPinnedToBottom } from "@/lib/chat-scroll";
import { useAutoGrow } from "@/lib/use-auto-grow";
import { useIsMobile } from "@/hooks/use-mobile";
import { mergeRealtimeMessage, optimisticId, settleMessage } from "@/lib/chat-messages";
import { SourceChip } from "@/components/source-chip";
import { FeedbackDialog } from "@/components/feedback-dialog";

export const Route = createFileRoute("/_authed/agents/$agentId/chat")({
  component: ChatTab,
  validateSearch: (search: Record<string, unknown>): { s?: string } => ({
    s: typeof search.s === "string" ? search.s : undefined,
  }),
});

/**
 * How much of a conversation loads at once, and how much more each press of
 * "Load earlier" asks for.
 *
 * Matches the default the endpoint serves (`MESSAGE_PAGE_DEFAULT`,
 * `worker/src/routes/sessions.ts`). They are two constants rather than one
 * because the frontend cannot import from the worker, and the only thing that
 * goes wrong if they drift is that the first page arrives smaller than this
 * screen expected — which is why `hasEarlier` is derived from what came back
 * rather than from what was asked for.
 */
const MESSAGE_PAGE = 100;

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
  /**
   * What the reader is searching for in this conversation.
   *
   * Local only — no server round-trip, no index. Full-text against content
   * and sender name; case-insensitive; results highlighted in place.
   */
  const [searchQuery, setSearchQuery] = useState("");

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

  // Writing this conversation up as a document. Declared here rather than
  // beside `uploads` above because it needs the session the report is written
  // from, and that is only resolved on the line above this one.
  const reports = useReportWriter(active?.id ?? null, agent);

  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me() });
  const currentUserId = me?.user.id;
  // What "try that again on something else" can offer: what this deployment
  // can actually serve, minus the model the agent is already on. Offering that
  // one back is not an offer.
  const pickableModels = useMemo(
    () => modelsFor(me?.models, agent.model).filter((m) => m !== agent.model),
    [me?.models, agent.model],
  );
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
  //
  // How much of the conversation is loaded, and deliberately *not* part of the
  // query key. Keying on it would make every "load earlier" its own cache
  // entry, and the entry the streamed reply is handed to at the end of a turn
  // is `["messages", id]` — one key, or the answer lands somewhere nothing is
  // reading. Held as state rather than a ref because the button below renders
  // from it, and because `queryFn` is rebuilt every render and so always
  // closes over the current value: the refetch after each reply re-reads
  // however much was loaded instead of snapping back to the first page and
  // throwing the scrollback away.
  //
  // It is not reset when the reader opens another conversation. Somebody who
  // asked for more of one is telling you how much conversation they like to
  // have, and taking it back on the next one is answering a question they did
  // not ask.
  const [pageSize, setPageSize] = useState(MESSAGE_PAGE);
  const { data: allMessages = [] } = useQuery({
    queryKey: ["messages", active?.id],
    queryFn: () => api.sessions.messages(active!.id, { limit: pageSize }),
    enabled: !!active?.id,
  });

  // What the screen actually shows: either everything, or what matches the
  // search. Filtered in the client because the query is live — every keystroke
  // re-runs it, and a server round-trip per keystroke is not a search box.
  const lowerQuery = searchQuery.toLowerCase();
  const messages = searchQuery
    ? allMessages.filter(
        (m) =>
          m.content.toLowerCase().includes(lowerQuery) ||
          m.sender?.name?.toLowerCase().includes(lowerQuery),
      )
    : allMessages;

  // A full page came back, so there is probably another behind it. "Probably"
  // is the honest word: a conversation of exactly a hundred turns offers a
  // button that loads nothing and then goes away, which is a better failure
  // than a conversation that silently begins in the middle.
  const hasEarlier = messages.length >= pageSize;
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const loadEarlier = async () => {
    if (!active) return;
    const next = pageSize + MESSAGE_PAGE;
    setPageSize(next);
    setLoadingEarlier(true);
    try {
      // Fetched and written rather than refetched: `refetch()` would re-run
      // the `queryFn` from *this* render, which still closes over the old
      // size, and load the same page again.
      const deeper = await api.sessions.messages(active.id, { limit: next });
      queryClient.setQueryData<Message[]>(["messages", active.id], deeper);
    } catch {
      toast.error("Couldn't load earlier messages.");
    } finally {
      setLoadingEarlier(false);
    }
  };

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
  // `max-h-44` on the composer below was unreachable until this: nothing grew
  // the box, so its minimum was its only height. See `use-auto-grow.ts`.
  const composerRef = useAutoGrow<HTMLTextAreaElement>(input);
  // Enter means something different on a phone, where it is the newline key
  // and the send button is already under your thumb.
  const isMobile = useIsMobile();
  // Spoken into the composer rather than typed. The transcript is appended to
  // the draft and left there — nothing is sent until the person sends it, since
  // a transcription is a guess and this is where they get to correct it.
  const dictation = useDictation(
    useCallback((text: string) => setInput((draft) => appendDictation(draft, text)), []),
  );
  const tts = useTTS();
  // Reply-in-progress state, scoped to the session it belongs to. `thinking`
  // shows the typing bubble; `streamText` reveals the answer character by
  // character before it's committed to the store.
  const [replyingIn, setReplyingIn] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [streamText, setStreamText] = useState("");
  /**
   * The model's account of how it got to the answer, while it is getting
   * there.
   *
   * Live only. It is not written to the row and not sent back as history, so
   * it goes when the reply settles — which is the honest thing for something
   * the transcript does not contain. Keeping it would mean a column and a
   * migration, and that is a decision about what a message *is* rather than a
   * decision about this screen.
   *
   * What it is for is the pause. On a reasoning model at a real effort there
   * is a long silence before the first word of the answer, and a silence is
   * indistinguishable from a product that has stopped working.
   */
  const [thinkingText, setThinkingText] = useState("");
  // The session whose revealed text is waiting for the server's copy to arrive.
  // Separate from `replyingIn` because the two end at different moments: the
  // composer is handed back the instant a stream stops, while the text that was
  // already on screen has to stay there until the refetch replaces it. Both
  // used to be the same flag, so the "keep it visible" delay below was keeping
  // nothing visible — the answer blinked out and blinked back 700ms later.
  const [settlingIn, setSettlingIn] = useState<string | null>(null);
  /**
   * The reply that stopped at its length limit, and is offering to go on.
   *
   * A chat reply is capped at 1536 output tokens, which is a cost decision
   * rather than an accident — so an answer running past it is a normal event
   * and not an error. What was wrong was how it was reported: a toast, which
   * is gone in four seconds, over an answer that looks finished and is not.
   *
   * Held for as long as the conversation is open rather than stored on the
   * row. There is no column for it, and this is an offer to act now rather
   * than a fact about the message — the same reason an undo lives in a toast
   * and not in the database. Somebody who reloads can still ask in words.
   */
  const [truncated, setTruncated] = useState<{ sessionId: string; messageId: string } | null>(null);
  // The reply a continuation is being written into, so the text arriving can
  // be drawn on the end of it rather than under it as a second answer.
  const [continuingId, setContinuingId] = useState<string | null>(null);
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
  // state because it changes on every scroll event, and the effect below — the
  // thing that acts on it — runs after render either way.
  const pinned = useRef(true);
  // The same fact, for the one thing that does render from it: the jump button.
  //
  // Holds the conversation somebody has scrolled up inside, rather than a bare
  // boolean — the shape `replyingIn` and `settlingIn` above already use, and
  // for the same reason. A boolean would need clearing when the reader opens
  // another conversation, which is an effect writing state for no reason other
  // than that another piece of state moved; scoped to a session it is simply
  // read against the open one and a flag left over from somewhere else does
  // not match.
  //
  // Setting it on every scroll event is cheap: React drops an update to the
  // value already held, so this re-renders when the answer flips rather than
  // once a frame while somebody drags a scrollbar.
  const [adriftIn, setAdriftIn] = useState<string | null>(null);
  const adrift = adriftIn !== null && adriftIn === active?.id;

  const followEnd = useCallback((el: HTMLDivElement) => {
    // Instant, never smooth.
    //
    // A smooth scroll is an animation that outlives the token that started it,
    // and the effect below refires on every token. So each one restarted the
    // animation from wherever the last had got to, and while that was in
    // flight the element sat far enough from the bottom that the listener
    // above read it as the reader having scrolled away — `pinned` latched
    // false, and the rest of a long answer arrived off-screen with nothing
    // left to bring it back.
    //
    // An instant scroll has no such window: `scrollTop` is final before the
    // scroll event is dispatched, so the listener sees the bottom, which is
    // where it actually is. The animation was never worth a reply you have to
    // chase.
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, []);

  // Re-registered when the open conversation changes, so the handler closes
  // over the session it is actually reporting about.
  const openSessionId = active?.id;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !openSessionId) return;
    const onScroll = () => {
      const atEnd = isPinnedToBottom(el);
      pinned.current = atEnd;
      setAdriftIn(atEnd ? null : openSessionId);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [openSessionId]);
  // Opening a conversation starts at its end, wherever the last one was left.
  useEffect(() => {
    pinned.current = true;
  }, [openSessionId]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pinned.current) return;
    followEnd(el);
  }, [messages.length, thinking, streamText, followEnd]);

  // Back to the end, from wherever the reader had got to. Also re-arms the
  // follow above, which is the point: the button is what somebody presses to
  // say "carry on taking me with you".
  const jumpToEnd = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinned.current = true;
    setAdriftIn(null);
    followEnd(el);
  };

  const invalidateMessages = (sessionId: string) => {
    void queryClient.invalidateQueries({ queryKey: ["messages", sessionId] });
    void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    // Token usage changed with the new reply — refresh the dashboard figures.
    void queryClient.invalidateQueries({ queryKey: ["usage"] });
  };

  // Stream a real reply for `sessionId` from the Worker's SSE endpoint. The
  // session's message history (already persisted) is read server-side, so
  // the caller only needs to make sure the latest user turn has landed.
  const streamReply = async (
    sessionId: string,
    opts: { continuing?: string; regenerate?: boolean; model?: string } = {},
  ) => {
    if (streamAbort.current) return;
    if (reconcileTimer.current) {
      window.clearTimeout(reconcileTimer.current);
      reconcileTimer.current = null;
    }
    setReplyingIn(sessionId);
    setSettlingIn(null);
    // Whatever was cut off is being dealt with now, one way or the other.
    setTruncated(null);
    setContinuingId(opts.continuing ?? null);
    // Nothing is "thinking" on a continuation: the answer is already on
    // screen and the next words land on the end of it.
    setThinking(!opts.continuing);
    setStreamText("");
    setThinkingText("");
    // Whether the model ran into the cap again on the way. Local to this
    // stream — the id it belongs to is not known until `done` carries it.
    let ranLong = false;

    const controller = new AbortController();
    streamAbort.current = controller;
    let partial = "";
    let reasoning = "";

    try {
      const token = await getAccessToken();
      const res = await fetch(`${import.meta.env.VITE_API_URL}/chat/stream`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          sessionId,
          ...(opts.continuing ? { continue: true } : {}),
          ...(opts.regenerate ? { regenerate: true } : {}),
          ...(opts.model ? { model: opts.model } : {}),
        }),
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
          // Settings is where the wall itself lives — the workspace's own key,
          // a message to us, and self-hosting, nearest first. See
          // `quota-wall.tsx`. There is no `/settings/usage` route; `UsageSection`
          // is one of several sections on the single `/settings` page.
          { action: { label: "Options", onClick: () => navigate({ to: "/settings" }) } },
        );
        setThinking(false);
        setStreamText("");
        setThinkingText("");
        setReplyingIn(null);
        void queryClient.invalidateQueries({ queryKey: ["usage"] });
        return;
      }

      if (!res.ok || !res.body) {
        toast.error("Couldn't reach the assistant. Please try again.");
        setThinking(false);
        setStreamText("");
        setThinkingText("");
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
          } else if (event.type === "thinking" && typeof event.text === "string") {
            // The dots stand for "something is happening and we cannot say
            // what". Once the model is saying what, they have nothing to add.
            setThinking(false);
            reasoning += event.text;
            setThinkingText(reasoning);
          } else if (event.type === "truncated") {
            // The model ran into its output cap. The answer stops mid-thought
            // and otherwise looks finished, which is the worst way for a reply
            // to be wrong: nothing on screen says the end is missing.
            //
            // Recorded rather than announced. This used to be a toast, which
            // is gone in four seconds and leaves the half-finished answer
            // sitting there looking whole. What it becomes instead is a button
            // under the reply, and the button is the only way the cap is
            // survivable at all — see `truncated` above.
            ranLong = true;
          } else if (event.type === "notice" && typeof event.text === "string") {
            // The worker sends this at most once, when the agent's stored
            // model was Claude but this reply ran on a workspace key with no
            // Anthropic half and quietly answered from the default instead.
            // A toast, like the 402 above, because it is a fact about this one
            // reply — not a banner that should still be sitting there next turn.
            toast.message(event.text);
          } else if (event.type === "done") {
            terminalSeen = true;
            // The server sends the row it has just written, and until now this
            // threw it away and asked for it again.
            //
            // That cost a gap at the end of every single reply. Clearing
            // `replyingIn` below unmounts the block the streamed text was
            // drawn in, and the answer did not exist anywhere else until the
            // refetch landed a round trip later — so it blinked out and back,
            // every turn, on the product's main screen. It is the same defect
            // `settlingIn` was added for on the dropped-connection path; the
            // path that works had it too.
            //
            // `mergeRealtimeMessage` rather than a bare append: it is already
            // the function that folds a server copy into this list, and it
            // drops the matching optimistic turn and keeps the order right on
            // the way through.
            // `settleMessage` and not `mergeRealtimeMessage`: a continuation
            // comes back under the id already on screen, with the whole answer
            // in it. Merging would see a known id and keep the first half.
            const settled = event.message;
            if (settled) {
              queryClient.setQueryData<Message[]>(["messages", sessionId], (old) =>
                settleMessage(old ?? [], settled),
              );
              if (ranLong) setTruncated({ sessionId, messageId: settled.id });
            }
            setStreamText("");
            setThinkingText("");
            setThinking(false);
            setReplyingIn(null);
            setContinuingId(null);
            // Still invalidated, but now for what the stream could not carry —
            // the session list's ordering and the usage figures — rather than
            // for the answer itself.
            invalidateMessages(sessionId);
          } else if (event.type === "error") {
            terminalSeen = true;
            toast.error(event.error ?? "The assistant hit an error.");
            setStreamText("");
            setThinkingText("");
            setThinking(false);
            setReplyingIn(null);
            setContinuingId(null);
          }
        }
      }

      if (!terminalSeen && !controller.signal.aborted) {
        setThinking(false);
        setReplyingIn(null);
        setContinuingId(null);
        // The server persists the partial (service-role) when the connection
        // drops before a terminal event; keep the revealed text visible until
        // the refetch reconciles so it doesn't flash out.
        const hadPartial = partial.trim().length > 0;
        setSettlingIn(hadPartial ? sessionId : null);
        if (reconcileTimer.current) window.clearTimeout(reconcileTimer.current);
        reconcileTimer.current = window.setTimeout(() => {
          setSettlingIn(null);
          setStreamText("");
          setThinkingText("");
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
      setThinkingText("");
      setThinking(false);
      setReplyingIn(null);
      setSettlingIn(null);
      setContinuingId(null);
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
    setContinuingId(null);
    setSettlingIn(sessionId);
    if (reconcileTimer.current) window.clearTimeout(reconcileTimer.current);
    reconcileTimer.current = window.setTimeout(() => {
      setSettlingIn(null);
      setStreamText("");
      setThinkingText("");
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

  // `/report …` asks for a document instead of a reply.
  //
  // Read here rather than inside `submit`, which is also reached from the draft
  // effect below — a command branch there is a setState run synchronously from
  // an effect, which is a cascading render and a lint error besides.
  //
  // Only where the person can actually write one. For a viewer the command is
  // not a command, it is text, and it is sent as typed — the same way the
  // button beside the composer is simply absent rather than disabled.
  const send = () => {
    if (canWrite) {
      const command = parseReportCommand(input);
      if (command) {
        setInput("");
        // Nothing after the command means "I want a report and have not said
        // what about", which is this dialog's question rather than an error.
        if (command.instruction) void reports.write(command.instruction);
        else reports.setDialogOpen(true);
        return;
      }
    }
    void submit(input);
  };

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
    // `/report` typed into the home composer is not a report — this conversation
    // is empty, so there is nothing to write up yet. Dropped rather than sent,
    // so it does not arrive as a puzzling first message the agent tries to
    // answer. It is already out of sessionStorage by here, so this ends it.
    if (parseReportCommand(draft)) return;
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

  // Finish an answer that stopped at its length cap. The server writes the
  // rest into the same row, so there is one reply on screen and one reply in
  // the transcript — which is also what the next turn will send.
  const carryOn = (messageId: string) => {
    if (!active || busy) return;
    void streamReply(active.id, { continuing: messageId });
  };

  // Answer the last question again, keeping the answer that is already there.
  //
  // This used to delete: `deleteAfter` dropped the reply, then the stream
  // wrote a new one, and there was no way back — so what the button asked was
  // "are you sure the next answer will be better than this one", which nobody
  // can know before seeing it. The server versions it now (0050), so pressing
  // this is free and the old answer is one click away.
  //
  // `model` is for one reply only. The agent's own model is a setting somebody
  // chose, and "try that again on something stronger" has no business
  // overwriting it.
  const regenerate = (model?: string) => {
    if (!active || busy) return;
    void streamReply(active.id, { regenerate: true, model });
  };

  // Back to a version that was put aside. The server does the swap in one
  // statement — see 0050 for why it cannot be two.
  const showVersion = async (messageId: string) => {
    if (!active || busy) return;
    try {
      await api.messages.show(messageId);
    } catch (e) {
      rewriteFailed(e);
    }
    invalidateMessages(active.id);
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
   * `feedback` is deliberately immutable (0041). They open the same box the
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
          {/* Conversation search: local filter, Esc to clear. */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              id="conversation-search"
              type="text"
              placeholder="Search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setSearchQuery("");
                  e.currentTarget.blur();
                }
              }}
              className="h-7 w-40 rounded-md border border-input bg-background pl-7 pr-2 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
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
              {/*
                A log, which is what a transcript is, and what makes a screen
                reader read a reply out when it lands instead of leaving the
                screen silent. `additions` and not the default `additions text`
                on purpose: an edited message rewrites text that has already
                been read, and re-reading it is not what anyone asked for.

                The reply *while it is arriving* is deliberately outside this —
                see the block below. Announcing a growing string on every token
                is not access, it is a torrent.
              */}
              {hasEarlier && (
                <div className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => void loadEarlier()}
                    disabled={loadingEarlier}
                    className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-secondary disabled:opacity-40"
                  >
                    {loadingEarlier ? "Loading…" : "Load earlier messages"}
                  </button>
                </div>
              )}
              <div
                role="log"
                aria-label="Conversation"
                aria-relevant="additions"
                className="space-y-8"
              >
                {messages.map((m, idx, arr) => {
                  // Date divider: show when date changes
                  const showDateDivider = (() => {
                    if (idx === 0) return true;
                    const prev = arr[idx - 1];
                    const prevDate = new Date(prev.createdAt).toDateString();
                    const currDate = new Date(m.createdAt).toDateString();
                    return prevDate !== currDate;
                  })();

                  const dateLabel = (() => {
                    const date = new Date(m.createdAt);
                    const today = new Date();
                    const yesterday = new Date(today);
                    yesterday.setDate(yesterday.getDate() - 1);
                    const isSameDay = (a: Date, b: Date) =>
                      a.getFullYear() === b.getFullYear() &&
                      a.getMonth() === b.getMonth() &&
                      a.getDate() === b.getDate();
                    if (isSameDay(date, today)) return "Today";
                    if (isSameDay(date, yesterday)) return "Yesterday";
                    const sameYear = date.getFullYear() === today.getFullYear();
                    return date.toLocaleDateString("en-US", {
                      month: "long",
                      day: "numeric",
                      ...(sameYear ? {} : { year: "numeric" }),
                    });
                  })();

                  // `role`, not ownership — this decides the LAYOUT. A
                  // teammate's message in a shared session is still somebody's
                  // turn and still draws as one, with their name above it.
                  const isPersonsTurn = m.role === "user";
                  if (isPersonsTurn) {
                    if (editingId === m.id) {
                      return (
                        <EditTurn
                          key={m.id}
                          value={editText}
                          onChange={setEditText}
                          onCancel={() => setEditingId(null)}
                          onSave={() => void saveEdit(m.id)}
                        />
                      );
                    }
                    return (
                      <div key={m.id} className="group flex flex-col items-end gap-1">
                        {isShared && m.sender && (
                          <div className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
                            {m.sender.avatarUrl ? (
                              <img
                                src={m.sender.avatarUrl}
                                alt=""
                                className="h-4 w-4 rounded-full"
                              />
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
                        {/* Show pending uploads under user message while composing */}
                        {idx === arr.length - 1 && uploads.receipts.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {uploads.receipts.map((r) => (
                              <div
                                key={r.id}
                                className="flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs"
                              >
                                <FileText className="h-3 w-3 text-muted-foreground" />
                                <span className="text-muted-foreground">{r.name}</span>
                                {r.state === "uploading" && (
                                  <span className="tabular-nums text-muted-foreground">
                                    {r.progress}%
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
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
                    <>
                      {showDateDivider && (
                        <div className="flex items-center gap-3 py-4">
                          <div className="h-px flex-1 bg-border" />
                          <span className="text-xs font-medium text-muted-foreground">
                            {dateLabel}
                          </span>
                          <div className="h-px flex-1 bg-border" />
                        </div>
                      )}
                      <div key={m.id} className="group flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                        <AgentAvatar emoji={agent.emoji} className="h-7 w-7 text-sm" />
                        <span className="text-sm font-semibold">{agent.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {formatTime(m.createdAt)}
                        </span>
                      </div>
                      <div className="pl-9">
                        {/* A continuation is drawn on the end of the reply it
                            finishes, not under it. The server writes it into
                            the same row, so anything else would show two
                            answers for the length of the stream and then
                            silently become one. */}
                        <Markdown
                          content={
                            continuingId === m.id && replyingIn === active?.id
                              ? m.content + streamText
                              : m.content
                          }
                          className={cn(
                            "text-[15px] leading-relaxed text-foreground",
                            continuingId === m.id && replyingIn === active?.id && "stream-live",
                          )}
                        />

                        {/* Which take on this answer is showing, when there
                            is more than one. Beside the answer rather than in
                            the hover actions, because it is a fact about what
                            is on screen: somebody reading a regenerated reply
                            needs to know the other one still exists without
                            having to go looking. */}
                        {m.versions && m.versions.length > 1 && (
                          <VersionPicker
                            versions={m.versions}
                            current={m.id}
                            busy={busy}
                            onShow={(id) => void showVersion(id)}
                          />
                        )}

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

                        {/* Not hidden behind hover like the actions below it.
                            Those are conveniences; this one is the only thing
                            saying the answer above it is unfinished, and an
                            answer that stops mid-thought otherwise looks
                            exactly like one that finished. */}
                        {truncated?.messageId === m.id && truncated.sessionId === active?.id && (
                          <div className="mt-3 flex items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              This answer hit its length limit.
                            </span>
                            <button
                              type="button"
                              onClick={() => carryOn(m.id)}
                              disabled={busy}
                              className="rounded-full border border-border px-2.5 py-1 text-xs font-medium transition-colors hover:bg-secondary disabled:opacity-40"
                            >
                              Continue
                            </button>
                          </div>
                        )}

                        {/* Token usage badge - hover only, assistant messages only */}
                        {m.role === "assistant" &&
                          m.promptTokens != null &&
                          m.completionTokens != null && (
                            <div className="mt-2 text-xs text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                              {formatTokens(m.promptTokens)} in · {formatTokens(m.completionTokens)}{" "}
                              out
                              {m.cachedTokens != null && m.cachedTokens > 0 && (
                                <> · {formatTokens(m.cachedTokens)} cached</>
                              )}
                              {" · "}
                              {formatCost(
                                estimateCostUsd(
                                  agent.model || "gpt-4.1",
                                  m.promptTokens,
                                  m.completionTokens,
                                  m.cachedTokens ?? 0,
                                ),
                              )}
                            </div>
                          )}

                        <div className="mt-2 flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                          <MsgAction label="Copy" onClick={() => copyMessage(m.content)}>
                            <Copy className="h-3.5 w-3.5" />
                          </MsgAction>
                          {tts.supported && (
                            <MsgAction
                              label={tts.speaking ? "Stop reading" : "Read aloud"}
                              onClick={() => (tts.speaking ? tts.stop() : tts.speak(m.content))}
                            >
                              {tts.speaking ? (
                                <VolumeX className="h-3.5 w-3.5" />
                              ) : (
                                <Volume2 className="h-3.5 w-3.5" />
                              )}
                            </MsgAction>
                          )}
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
                          {/* Ownership, not role — the same rule as Edit
                            above. `messages_delete_owner` is keyed to whoever
                            owns the SESSION, and so is `show_message_version`;
                            offered to a colleague reading a shared thread this
                            changed nothing, reported nothing, and then failed
                            to answer a question that already had an answer
                            under it.

                            The last answer only. Regenerating one in the
                            middle would leave every turn after it replying to
                            something no longer there, and making those turns a
                            branch is a conversation tree rather than a version
                            list — a different feature, and a much larger one. */}
                          {isLast && prevUser && isOwner && (
                            <>
                              <MsgAction label="Regenerate" onClick={() => regenerate()}>
                                <RefreshCw className="h-3.5 w-3.5" />
                              </MsgAction>
                              <RetryOn models={pickableModels} onPick={regenerate} />
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    </>
                  );
                })}
              </div>

              {/* Not while a continuation is running: those words are being
                  drawn on the end of the reply above instead. */}
              {continuingId === null &&
                (replyingIn === active?.id || settlingIn === active?.id) && (
                  // Outside the log, and silent. The words arrive here one token
                  // at a time; a screen reader is told *that* a reply is coming
                  // by the status line below, and reads the reply itself once it
                  // lands in the log above as a finished thing.
                  <div className="flex flex-col gap-2" aria-live="off">
                    <div className="flex items-center gap-2">
                      <AgentAvatar emoji={agent.emoji} className="h-7 w-7 text-sm" />
                      <span className="text-sm font-semibold">{agent.name}</span>
                    </div>
                    <div className="pl-9">
                      {/*
                      What the model is working through, while it works
                      through it. A `<details>` rather than a state flag and a
                      chevron: it opens and closes on its own, it is in the tab
                      order, and a screen reader already knows what it is.

                      Closed by default. This is context for a pause, not the
                      answer — somebody who wants to know why an answer came out
                      the way it did can open it, and everybody else should not
                      have to scroll past it to read the reply.
                    */}
                      {thinkingText && (
                        <details className="mb-3 rounded-lg border border-border bg-muted/40">
                          <summary className="cursor-pointer select-none px-3 py-1.5 text-xs text-muted-foreground marker:text-muted-foreground hover:text-foreground">
                            Thinking
                          </summary>
                          <div className="border-t border-border px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                            <Markdown content={thinkingText} className="text-xs" />
                          </div>
                        </details>
                      )}
                      {thinking ? (
                        // `aria-hidden`, where this used to carry an `aria-label`
                        // on a bare `<div>` — a label on an element with no role
                        // is a string most screen readers have nowhere to put.
                        // The words are in the status line at the foot of the
                        // conversation instead, where they are announced rather
                        // than merely present.
                        <div
                          className="flex items-center gap-1.5 text-xs text-muted-foreground"
                          aria-hidden="true"
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
                        // The same renderer the settled answer uses, so the
                        // reply arrives in the shape it will keep. It used to be
                        // plain `whitespace-pre-wrap`, which meant watching raw
                        // `**`, bare `|` rows and unopened fences for the length
                        // of the answer and then having the whole thing reflow
                        // into something else the moment it finished. That
                        // reflow was the single most visible difference between
                        // this and the chat products people arrive from.
                        //
                        // Measured before it was written: a full parse and mount
                        // of a 700-character answer costs ~1.1ms per delta under
                        // jsdom, which re-mounts the tree every time. A browser
                        // re-renders an existing one. There is nothing here to
                        // batch.
                        //
                        // `stream-live` is what draws the caret — see
                        // `styles.css`. A sibling span cannot: the answer is
                        // blocks now, and a span after them sits on its own line
                        // under the last paragraph rather than at the end of it.
                        // Dropped once the stream stops, because at that point
                        // the text is waiting to be replaced by the server's
                        // copy rather than still arriving.
                        <Markdown
                          content={streamText}
                          className={cn(
                            "text-[15px] leading-relaxed text-foreground",
                            replyingIn === active?.id && "stream-live",
                          )}
                        />
                      )}
                    </div>
                  </div>
                )}
            </div>
          )}

          {/*
            What the conversation is doing, for somebody who cannot see it.
            Derived rather than stored: every value here is already on screen
            as a typing indicator, a caret or their absence, and a second copy
            in state would be a second thing to keep true.

            It says what is happening and not what is being said. The saying is
            the log's job, once there is a whole answer to read.
          */}
          <span role="status" aria-live="polite" className="sr-only">
            {replyingIn === active?.id
              ? thinking
                ? `${agent.name} is thinking`
                : `${agent.name} is replying`
              : ""}
          </span>
        </div>
      </div>

      {/* Search results indicator */}
      {searchQuery && (
        <div className="border-t border-border bg-muted/30 px-4 py-2">
          <div className="flex items-center gap-2 text-sm">
            <Search className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">
              {messages.length === 0
                ? "No matches"
                : messages.length === allMessages.length
                  ? `All ${messages.length} messages`
                  : `${messages.length} of ${allMessages.length} messages`}
            </span>
            <button
              type="button"
              onClick={() => setSearchQuery("")}
              className="ml-auto text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Composer */}
      <div className="relative border-t border-border bg-background px-4 pb-4 pt-3 lg:px-6">
        {/* Back to the end. Floats just above the composer rather than inside
            the transcript, because it is a control and the transcript is
            content — and because anchored here it cannot scroll away from the
            reader who needs it. Hidden on an empty conversation, where there
            is no end to go back to. */}
        {adrift && !isEmpty && (
          <button
            type="button"
            onClick={jumpToEnd}
            aria-label="Jump to the latest message"
            className="absolute -top-5 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-card transition-colors duration-200 hover:text-foreground"
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
        <div className="mx-auto max-w-3xl">
          {quota && quota.level !== "fine" && (
            <div className="mb-2 flex items-center gap-2 rounded-sm border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              <span className="h-2 w-2 shrink-0 bg-accent-orange" />
              <span>{quotaSentence(quota)}</span>
            </div>
          )}
          <div className="rounded-3xl bg-popover shadow-card transition-colors duration-200">
            <ChatReceipts uploads={uploads} />
            <ChatReportReceipt reports={reports} />
            <Textarea
              ref={composerRef}
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
              // Every shortcut this screen has lives on the composer rather
              // than on the document. A global key listener here would be
              // fighting three Radix dialogs, the command palette and the
              // rename field in the sidebar over the same keys — and the
              // person these are for has their hands in this box already.
              onKeyDown={(e) => {
                // Sends from anywhere, phone included, where a bare Enter is
                // the newline key.
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  send();
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey) {
                  // Mid-composition. An IME takes Enter to mean "accept the
                  // word you are suggesting", so without this a Japanese,
                  // Chinese or Korean sentence posted itself one word in — and
                  // the half-written question is then what the agent answers.
                  if (e.nativeEvent.isComposing) return;
                  // On a phone Enter is how you start a new line and the send
                  // button is under your thumb already. Sending on it turns
                  // every paragraph break into a premature message.
                  if (isMobile) return;
                  e.preventDefault();
                  send();
                  return;
                }
                // Stop, without reaching for the mouse. Scoped to the reply
                // running in *this* conversation, the same rule the button
                // beside it follows.
                if (e.key === "Escape" && replyingIn === active?.id) {
                  e.preventDefault();
                  stop();
                  return;
                }
                // An empty composer and the up arrow: edit what you last said.
                // Only your own turn, and only in a conversation you own —
                // editing discards every reply after it, which is the same
                // reason the Edit button beside a message is ownership-gated.
                if (e.key === "ArrowUp" && input === "" && !busy && isOwner) {
                  const mine = [...messages].reverse().find((m) => m.role === "user");
                  if (mine) {
                    e.preventDefault();
                    startEdit(mine.id, mine.content);
                  }
                }
              }}
              placeholder={`Message ${agent.name}`}
              rows={1}
              className="max-h-44 min-h-[44px] w-full resize-none overflow-y-auto border-0 bg-transparent px-4 pt-3 text-sm shadow-none focus-visible:ring-0"
            />
            <div className="flex items-center justify-between px-3 pb-2.5">
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 rounded-sm bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
                  <span className="text-sm leading-none">{agent.emoji}</span>
                  {agent.name}
                </span>
                <ChatAttach uploads={uploads} canWrite={canWrite} />
                <ChatReport reports={reports} canWrite={canWrite} />
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

  // Report preview: show split layout when report content is loaded
  if (reports.content && active) {
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
                <FileText className="h-4 w-4 text-muted-foreground" /> Report preview
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={reports.download}
                  className="rounded-sm px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                >
                  Download
                </button>
                <button
                  type="button"
                  onClick={reports.dismiss}
                  className="rounded-sm px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="Close preview"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-6">
              {reports.loadingContent ? (
                <div className="flex items-center justify-center py-12">
                  <p className="text-sm text-muted-foreground">Loading preview...</p>
                </div>
              ) : (
                <div className="prose prose-sm max-w-none dark:prose-invert">
                  <Markdown content={reports.content} />
                </div>
              )}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    );
  }

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

/**
 * A past question, open for editing.
 *
 * Its own component only so it can hold a hook: `useAutoGrow` cannot be called
 * from inside the message loop, which renders this conditionally. The box had
 * the same fixed-height problem as the composer and for the same reason — two
 * rows, no growing — and it is the worse of the two places to have it, because
 * what is being edited is by definition something already long enough to be
 * worth fixing.
 */
function EditTurn({
  value,
  onChange,
  onCancel,
  onSave,
}: {
  value: string;
  onChange: (next: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const ref = useAutoGrow<HTMLTextAreaElement>(value);
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="w-full max-w-[560px] rounded-2xl bg-popover p-2 shadow-card">
        <Textarea
          ref={ref}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && value.trim()) {
              e.preventDefault();
              onSave();
            }
          }}
          rows={1}
          autoFocus
          aria-label="Edit your message"
          className="max-h-60 min-h-[40px] resize-none overflow-y-auto border-0 bg-transparent p-1.5 text-sm shadow-none focus-visible:ring-0"
        />
        <div className="flex justify-end gap-1.5 pt-1">
          <button
            onClick={onCancel}
            className="rounded-md px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            disabled={!value.trim()}
            className="rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Save & send
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Which take on an answer is showing, and how to get to the others.
 *
 * `‹ 2/3 ›` rather than a list, because the versions have no names and never
 * will: they are the same question answered twice. What somebody wants is to
 * flick between them and stop on the one they liked, which is two buttons and
 * a count.
 */
function VersionPicker({
  versions,
  current,
  busy,
  onShow,
}: {
  versions: string[];
  current: string;
  busy: boolean;
  onShow: (id: string) => void;
}) {
  const at = versions.indexOf(current);
  // A chain that does not contain the message showing is a transcript and a
  // version list that disagree, and drawing `0/3` over it helps nobody.
  if (at === -1) return null;
  const step = (by: number) => onShow(versions[at + by]);
  return (
    <div className="mt-2 flex items-center gap-0.5 text-xs text-muted-foreground">
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={busy || at === 0}
        aria-label="Previous version of this answer"
        className="grid h-6 w-6 place-items-center rounded transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <span className="tabular-nums" aria-label={`Version ${at + 1} of ${versions.length}`}>
        {at + 1}/{versions.length}
      </span>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={busy || at === versions.length - 1}
        aria-label="Next version of this answer"
        className="grid h-6 w-6 place-items-center rounded transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Answer that again, on something else.
 *
 * Beside Regenerate rather than replacing it: the common press is "try again",
 * and burying it behind a menu to make room for a choice nobody makes most of
 * the time is a worse default. Absent entirely on a deployment that serves one
 * model, where the menu would have nothing in it.
 */
function RetryOn({ models, onPick }: { models: string[]; onPick: (model: string) => void }) {
  if (models.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Answer again on another model"
          aria-label="Answer again on another model"
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Sparkles className="h-3.5 w-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {models.map((model) => (
          <DropdownMenuItem
            key={model}
            onSelect={() => onPick(model)}
            className="font-mono text-xs"
          >
            {model}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
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
