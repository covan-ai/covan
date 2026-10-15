import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, ApiError, type Bundle, type UploadPhase } from "./api-client";
import { indexingNow } from "./index-status";
import { canWriteAsRole } from "./roles";
import type { ReasoningEffort } from "./agent-meta";
import type { AgentAccess, AgentShare, AgentSharing } from "./agent-access";
import { chatBundleMarker, chatBundleName, findChatBundle } from "./chat-uploads";
import { useHasSession } from "./session-presence";

/**
 * The cache key for one bundle's contents.
 *
 * Exported so the explorer and the writes that change a bundle agree on it. The
 * writes invalidate the whole `["bundle-documents"]` prefix rather than one
 * key: a move changes two bundles at once, and the one it came from is not
 * always on screen to be named.
 */
export const bundleDocumentsKey = (bundleId: string) => ["bundle-documents", bundleId] as const;
const BUNDLE_DOCUMENTS = ["bundle-documents"] as const;

export type Agent = {
  id: string;
  name: string;
  emoji: string;
  model: string;
  persona: string;
  mode: "normal" | "brainstorm";
  /**
   * How much the model may vary its wording, 0 to 2, or null for Auto.
   *
   * Null is a setting and not a missing value: it means the mode decides, which
   * is 0.9 for a brainstorm agent and nothing at all for a normal one. Every
   * agent is on it until somebody moves the dial, so `0` and `null` are
   * different answers and the form has to keep them apart.
   */
  temperature: number | null;
  /** How long the agent thinks first, or null for whatever the model does. */
  reasoningEffort: ReasoningEffort | null;
  /** Whether the agent can search the web to answer questions. */
  webSearch: boolean;
  documents: {
    id: string;
    name: string;
    size: number;
    /** When it was uploaded, which for a document is the whole of its freshness. */
    createdAt: number;
    chunkCount: number;
    indexed: boolean;
    /**
     * Which bundle holds it. Optional, and absent rather than null when the
     * response did not carry it: the three endpoints that answer with one
     * document somebody just acted on already know where it went, while the two
     * that answer with a list — a bundle's contents and this agent's documents —
     * both say. The explorer needs it on every row it renders, which is what a
     * bundle chip reads and what a move knows it is moving away from.
     */
    bundleId?: string;
    /**
     * The connected source that owns it, or null for a file somebody uploaded.
     * Undefined means the response did not say, which is not the same answer.
     * A synced document may be moved, but its name and its text are the
     * source's, so the interface says so rather than offering a rename.
     */
    connectionId?: string | null;
    /** The page or file at the source, for a synced document. */
    externalUrl?: string | null;
    /**
     * The routine that wrote it, or null for an upload or a synced file.
     *
     * Provenance is derived from this rather than declared: no `kind` column,
     * no new chip, no new colour. A filed summary is an ordinary document and
     * behaves like one — it is only the line under the filename that differs.
     */
    routineId?: string | null;
    /**
     * That routine's name, or null when the caller cannot see the routine.
     *
     * A colleague's private routine filing into a shared bundle produces
     * exactly that: a real id with no name. The document is theirs to read and
     * the routine is not theirs to see, so the line says "a routine".
     */
    routineName?: string | null;
    /**
     * Where its indexing has got: `queued` and `indexing` while the job runs,
     * `ready`, `partial` when the text was cut at the indexing limit, `failed`
     * with `indexError`. Null for a document indexed before jobs existed —
     * `indexed` describes those. Mirrors `DocumentDTO` in worker/src/lib/dto.ts.
     */
    indexStatus?: "queued" | "indexing" | "ready" | "partial" | "failed" | null;
    indexProgress?: { done: number; total: number } | null;
    indexError?: string | null;
  }[];
  bundleIds: string[];
  createdAt: number;
  /**
   * Who made it, and so who always has Full access to it. Null once that
   * account is deleted — admins are then the ones who can still manage it.
   */
  createdBy: string | null;
  /** What every member gets, or null when it is not shared with the workspace. */
  workspaceAccess: AgentAccess | null;
  /** The people it is shared with by name, each at a level. Never the owner. */
  shares: AgentShare[];
  /**
   * What the caller may do with it, as the database worked it out — the owner,
   * an admin, the workspace level, a share and the viewer cap already folded
   * in. Read through `canEditAgent` and `canManageAgent`, never compared by
   * hand, so a fourth level would have one place to go.
   */
  myAccess: AgentAccess;
};

/** What creating an agent takes. Sharing left out means Only me. */
export type NewAgent = Pick<
  Agent,
  "name" | "emoji" | "model" | "persona" | "mode" | "webSearch"
> & {
  sharing?: AgentSharing;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  /**
   * The documents that grounded an assistant reply — real citations, absent or
   * empty when the reply used no retrieved knowledge.
   *
   * `id` is null on every reply written before ids were stored: the column held
   * bare names then, and a name cannot be resolved back to a document without
   * guessing. Those citations still render, they just cannot say how old the
   * document was.
   */
  sources?: { id: string | null; name: string }[];
  // In a shared session, the human author of a user message. Absent for
  // assistant messages and for one's own optimistic messages before refetch.
  sender?: { id: string; name: string | null; avatarUrl: string | null };
  /**
   * Every version of this answer, oldest first, when there is more than one.
   *
   * Absent on a reply nobody has regenerated, which is almost all of them.
   * Ids only — the screen asks the server for whichever one it wants to show
   * rather than holding five drafts of an answer nobody is reading.
   */
  versions?: string[];
  /**
   * Token usage for assistant replies. Null on user messages and on replies
   * written before 0006. cachedTokens is null on replies written before 0025,
   * cacheWriteTokens on replies written before 0062 — and on every reply from
   * an OpenAI model, whose cache costs nothing to fill.
   */
  /**
   * What the reply did before it wrote, when it did anything — one entry per
   * tool it ran, in the order it ran them.
   *
   * Absent on every reply that ran no tool, which is most of them and all of
   * them written before the harness existed.
   *
   * `resultExcerpt` is the FIRST PART of what the tool returned, not the whole
   * of it — capped at 2,000 characters by the worker that stored it (0060),
   * which is what makes it cheap enough to send with every transcript. The
   * paragraph that used to sit here said the result was deliberately left out
   * because it was already in the answer above; that was true of the whole
   * result and never true of the excerpt, which was being trimmed for this
   * journey and then not taking it. A step that failed or was refused has its
   * reason here and nowhere else on the screen.
   */
  steps?: {
    index: number;
    tool: string;
    status: "ok" | "failed" | "refused" | "pending";
    request: unknown;
    durationMs: number | null;
    resultExcerpt: string | null;
  }[];
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedTokens?: number | null;
  cacheWriteTokens?: number | null;
  /**
   * How the turn ended, as `messages.outcome` recorded it (0065): `answered`,
   * or the ceiling (`budget`, `tokens`, `runtime`) or other reason it stopped.
   * Absent on replies written before it existed.
   *
   * What tells a reloaded transcript that its last reply stopped short — the
   * stream that said so live is gone by then.
   */
  outcome?: string;
};

export type ChatSession = {
  id: string;
  agentId: string;
  title: string | null;
  messages: Message[];
  messageCount: number;
  updatedAt: number;
  visibility: "private" | "shared";
  ownerId: string;
  kind: "chat" | "brainstorm";
  /*
   * How THIS conversation is answered, where it differs from its agent: the
   * dial in the composer. Every one is null until somebody turns it, and null
   * means "the agent's" — not "none" — which is how a conversation that has
   * never been tuned keeps behaving exactly as it did before there was a dial,
   * and how it follows the agent when the agent's settings change later.
   *
   * Per conversation rather than per person or per agent because that is the
   * unit the choice is about: the hard question goes to a bigger model in the
   * thread where it was asked, and the agent everybody else talks to is left
   * alone. The server applies these to every reply in the conversation —
   * a new question, Continue, Regenerate and an approval resuming a turn.
   * Optional in the type only so a session built before the server sent them
   * (and every test fixture) still reads as "all inherited".
   */
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  webSearch?: boolean | null;
  mode?: "normal" | "brainstorm" | null;
};

/** What the composer's dial may change about a conversation. Null clears. */
export type SessionTuning = Partial<
  Pick<ChatSession, "model" | "reasoningEffort" | "webSearch" | "mode">
>;

export type IdeaStage = "review" | "promising" | "in_progress" | "parked";

export type Idea = {
  id: string;
  sessionId: string;
  title: string;
  detail: string | null;
  stage: IdeaStage;
  position: number;
  createdBy: string | null;
  sourceMessageId: string | null;
  createdAt: number;
};

type Store = {
  agents: Agent[];
  sessions: ChatSession[];
  favorites: string[];
  bundles: Bundle[];
  /**
   * Whether the caller may change the things this workspace SHARES — agents,
   * bundles, documents, and what knowledge an agent carries. False for a
   * viewer, which is the only role it is false for.
   *
   * It sits on this store because the store is already where that line is
   * drawn: createAgent, updateAgent, createBundle, uploadToBundle,
   * attachBundle, detachBundle, removeBundle, removeDocument, reindexDocument
   * and deleteAgent are exactly the calls `can_write_in_workspace` guards,
   * while startSession, updateMessage, deleteSession and toggleFavorite are
   * the caller's own and never gated. Consumers read one flag from somewhere
   * they already read.
   *
   * It gates the CONTROLS, not the calls. The policies refuse a viewer whether
   * or not the button was there; this is so the button is not there.
   *
   * Since 0104 it is only half the answer for an agent that already exists:
   * changing one takes Can edit on that agent, and sharing or deleting it Full
   * access — `canEditAgent` and `canManageAgent` in `lib/agent-access`. This
   * flag still decides creating an agent, and everything about bundles and
   * documents, which are the workspace's rather than any one agent's.
   */
  canWrite: boolean;
  /**
   * The tuning settings (temperature, reasoningEffort) are absent here and
   * required nowhere else: a new agent is created on Auto, and both surfaces
   * that create one say so by not mentioning them. Settings is where they are
   * chosen, once there is an agent to choose them for. webSearch is required
   * and defaults to false.
   */
  createAgent: (a: NewAgent) => Promise<Agent>;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  /**
   * Who can reach the agent. Awaited, unlike `updateAgent`: the dialog that
   * calls it stays open until the server has agreed, and shows its refusal.
   */
  setSharing: (id: string, sharing: AgentSharing) => Promise<Agent>;
  removeDocument: (docId: string) => Promise<void>;
  reindexDocument: (docId: string) => Promise<Agent["documents"][number]>;
  moveDocument: (docId: string, bundleId: string) => Promise<void>;
  createBundle: (name: string, description?: string) => Promise<Bundle>;
  updateBundle: (id: string, patch: { name?: string; description?: string }) => Promise<Bundle>;
  ensureChatBundle: (agent: { id: string; name: string }) => Promise<Bundle>;
  uploadToBundle: (
    bundleId: string,
    file: File,
    onProgress?: (pct: number) => void,
    onPhase?: (phase: UploadPhase) => void,
  ) => Promise<Agent["documents"][number]>;
  attachBundle: (agentId: string, bundleId: string) => void;
  detachBundle: (agentId: string, bundleId: string) => void;
  removeBundle: (id: string) => void;
  deleteAgent: (id: string) => void;
  startSession: (agentId: string) => Promise<ChatSession>;
  startBrainstorm: (agentId: string) => Promise<ChatSession>;
  updateMessage: (sessionId: string, messageId: string, content: string) => void;
  deleteMessagesAfter: (sessionId: string, messageId: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  toggleFavorite: (agentId: string) => void;
};

const StoreCtx = createContext<Store | null>(null);

export function AgentsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  // This provider wraps every route, public ones included — the command
  // palette lives inside it and is rendered at the root. So the five queries
  // below have to ask whether there is anybody to ask FOR. Without this they
  // ran on `/`, `/privacy`, `/sign-in` and `/sign-up`, answered 401, and were
  // retried three times each: twenty requests to the API before the visitor
  // had an account. `=== true` and not `!== false` on purpose — see
  // useHasSession for why the third state matters.
  const signedIn = useHasSession() === true;

  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list(),
    enabled: signedIn,
    // While any document is still being indexed, ask again every few seconds
    // so its status moves on screen; once none is, stop asking.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((a) => a.documents.some(indexingNow)) ? 4_000 : false,
  });
  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.sessions.list(),
    enabled: signedIn,
  });
  const { data: favorites = [] } = useQuery({
    queryKey: ["favorites"],
    queryFn: () => api.favorites.list(),
    enabled: signedIn,
  });
  const { data: bundles = [] } = useQuery({
    queryKey: ["bundles"],
    queryFn: () => api.bundles.list(),
    enabled: signedIn,
  });
  // Already in the cache; the app shell fetches it. `me.members` carries the
  // caller's own row, so the role comes from the server rather than from
  // anything the client could have decided for itself.
  const { data: me } = useQuery({ queryKey: ["me"], queryFn: () => api.me(), enabled: signedIn });

  // Undefined while `me` loads. Defaulting to false would flicker every write
  // control out of existence on each cold load, which reads as "you have been
  // demoted" rather than as "still loading" — so an unknown role writes.
  const canWrite = me ? canWriteAsRole(me.members.find((m) => m.id === me.user.id)?.role) : true;

  const value = useMemo<Store>(() => {
    return {
      agents,
      sessions,
      favorites,
      bundles,
      canWrite,

      createAgent: async (input) => {
        const agent = await api.agents.create(input);
        await queryClient.invalidateQueries({ queryKey: ["agents"] });
        return agent;
      },

      updateAgent: (id, patch) => {
        void api.agents
          .update(id, patch)
          .then(() => queryClient.invalidateQueries({ queryKey: ["agents"] }))
          // The server's sentence when it has one: a 403 here means the
          // caller's access was narrowed after this screen loaded, and "could
          // not save" would not tell them that.
          .catch((e) =>
            toast.error(e instanceof ApiError ? e.message : "Couldn't save the agent."),
          );
      },

      // Written straight into the cache from the answer, which is the agent
      // as the server now has it. A refetch follows anyway: the list is the
      // one place the caller's own `myAccess` could have changed, and an admin
      // narrowing an agent is still an admin, but nothing else on this screen
      // should have to know that to be right.
      setSharing: async (id, sharing) => {
        const agent = await api.agents.setSharing(id, sharing);
        queryClient.setQueryData<Agent[]>(["agents"], (old = []) =>
          old.map((a) => (a.id === id ? agent : a)),
        );
        void queryClient.invalidateQueries({ queryKey: ["agents"] });
        return agent;
      },

      removeDocument: async (docId) => {
        await api.documents.remove(docId);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["agents"] }),
          queryClient.invalidateQueries({ queryKey: ["bundles"] }),
          queryClient.invalidateQueries({ queryKey: BUNDLE_DOCUMENTS }),
        ]);
      },

      createBundle: async (name, description) => {
        const bundle = await api.bundles.create(name, description);
        await queryClient.invalidateQueries({ queryKey: ["bundles"] });
        return bundle;
      },

      updateBundle: async (id, patch) => {
        const bundle = await api.bundles.update(id, patch);
        await queryClient.invalidateQueries({ queryKey: ["bundles"] });
        return bundle;
      },

      // The bundle a file dropped into a conversation goes to, created on the
      // first drop and attached so the agent can read it immediately. Awaited
      // end to end, unlike `attachBundle` above: the upload that follows needs
      // the attachment to have actually landed, not to have been started.
      ensureChatBundle: async (agent) => {
        const existing = findChatBundle(bundles, agent.id);
        const bundle =
          existing ??
          (await api.bundles.create(chatBundleName(agent.name), chatBundleMarker(agent.id)));
        if (!existing) await queryClient.invalidateQueries({ queryKey: ["bundles"] });

        const attached = agents.find((a) => a.id === agent.id)?.bundleIds.includes(bundle.id);
        if (!attached) {
          await api.bundles.attach(agent.id, bundle.id);
          await queryClient.invalidateQueries({ queryKey: ["agents"] });
        }
        return bundle;
      },

      uploadToBundle: async (bundleId, file, onProgress, onPhase) => {
        const doc = await api.bundles.upload(bundleId, file, onProgress, onPhase);
        // Refresh bundles (doc counts), agents (the document list + per-doc
        // indexing status) and the explorer's per-bundle listing.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["bundles"] }),
          queryClient.invalidateQueries({ queryKey: ["agents"] }),
          queryClient.invalidateQueries({ queryKey: BUNDLE_DOCUMENTS }),
        ]);
        return doc;
      },

      moveDocument: async (docId, bundleId) => {
        await api.documents.move(docId, bundleId);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["bundles"] }),
          queryClient.invalidateQueries({ queryKey: ["agents"] }),
          queryClient.invalidateQueries({ queryKey: BUNDLE_DOCUMENTS }),
        ]);
      },

      reindexDocument: async (docId) => {
        const doc = await api.documents.reindex(docId);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["agents"] }),
          queryClient.invalidateQueries({ queryKey: BUNDLE_DOCUMENTS }),
        ]);
        return doc;
      },

      attachBundle: (agentId, bundleId) => {
        void api.bundles
          .attach(agentId, bundleId)
          .then(() => queryClient.invalidateQueries({ queryKey: ["agents"] }))
          .catch(() => toast.error("Couldn't attach the knowledge bundle."));
      },

      detachBundle: (agentId, bundleId) => {
        void api.bundles
          .detach(agentId, bundleId)
          .then(() => queryClient.invalidateQueries({ queryKey: ["agents"] }))
          .catch(() => toast.error("Couldn't remove the knowledge bundle."));
      },

      removeBundle: (id) => {
        void api.bundles
          .remove(id)
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: ["bundles"] });
            void queryClient.invalidateQueries({ queryKey: ["agents"] });
            void queryClient.invalidateQueries({ queryKey: BUNDLE_DOCUMENTS });
          })
          .catch(() => toast.error("Couldn't delete the knowledge bundle."));
      },

      deleteAgent: (id) => {
        void api.agents
          .remove(id)
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: ["agents"] });
            void queryClient.invalidateQueries({ queryKey: ["sessions"] });
          })
          .catch(() => toast.error("Couldn't delete the agent."));
      },

      startSession: async (agentId) => {
        const session = await api.sessions.create({ agentId });
        await queryClient.invalidateQueries({ queryKey: ["sessions"] });
        return session;
      },

      startBrainstorm: async (agentId) => {
        const session = await api.sessions.create({ agentId, kind: "brainstorm" });
        await queryClient.invalidateQueries({ queryKey: ["sessions"] });
        return session;
      },

      deleteSession: (id) => {
        void api.sessions
          .remove(id)
          .then(() => queryClient.invalidateQueries({ queryKey: ["sessions"] }))
          .catch(() => toast.error("Couldn't delete the conversation."));
      },

      // Optimistic, unlike deleteSession: the name is already on screen in the
      // field the user just left, and a round trip before it settles reads as
      // the rename not having taken. A failure puts the old list back and says
      // so, the same shape as toggleFavorite below.
      renameSession: (id, title) => {
        const key = ["sessions"] as const;
        const previous = queryClient.getQueryData<ChatSession[]>(key);
        queryClient.setQueryData<ChatSession[]>(key, (old = []) =>
          old.map((s) => (s.id === id ? { ...s, title } : s)),
        );

        void api.sessions
          .rename(id, title)
          .catch(() => {
            queryClient.setQueryData<ChatSession[]>(key, previous);
            toast.error("Couldn't rename the conversation.");
          })
          .finally(() => {
            void queryClient.invalidateQueries({ queryKey: key });
          });
      },

      updateMessage: (sessionId, messageId, content) => {
        void api.messages
          .update(messageId, content)
          .then(() => queryClient.invalidateQueries({ queryKey: ["messages", sessionId] }))
          .catch(() => toast.error("Couldn't update the message."));
      },

      deleteMessagesAfter: (sessionId, messageId) => {
        void api.messages
          .deleteAfter(messageId)
          .then(() => queryClient.invalidateQueries({ queryKey: ["messages", sessionId] }))
          .catch(() => toast.error("Couldn't update the conversation."));
      },

      toggleFavorite: (agentId) => {
        const key = ["favorites"] as const;
        const previous = queryClient.getQueryData<string[]>(key);
        queryClient.setQueryData<string[]>(key, (old = []) =>
          old.includes(agentId) ? old.filter((x) => x !== agentId) : [agentId, ...old],
        );

        void api.agents
          .toggleFavorite(agentId)
          .catch(() => {
            queryClient.setQueryData<string[]>(key, previous);
            toast.error("Couldn't update favorites.");
          })
          .finally(() => {
            void queryClient.invalidateQueries({ queryKey: ["favorites"] });
          });
      },
    };
  }, [agents, sessions, favorites, bundles, canWrite, queryClient]);

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useAgentsStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useAgentsStore must be used inside AgentsProvider");
  return ctx;
}
