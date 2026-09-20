import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Bundle } from "./api-client";
import { canWriteAsRole } from "./roles";
import type { ReasoningEffort } from "./agent-meta";
import { chatBundleMarker, chatBundleName, findChatBundle } from "./chat-uploads";
import { reportBundleMarker, reportBundleName, findReportBundle } from "./reports";
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
  }[];
  bundleIds: string[];
  createdAt: number;
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
   * written before 0006. cachedTokens is null on replies written before 0025.
   */
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedTokens?: number | null;
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
};

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
   */
  canWrite: boolean;
  /**
   * The tuning settings (temperature, reasoningEffort) are optional here and
   * required nowhere else: a new agent is created on Auto, and both surfaces
   * that create one say so by not mentioning them. Settings is where they are
   * chosen, once there is an agent to choose them for. webSearch is required
   * and defaults to false.
   */
  createAgent: (
    a: Omit<
      Agent,
      "id" | "createdAt" | "documents" | "bundleIds" | "temperature" | "reasoningEffort"
    >,
  ) => Promise<Agent>;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  removeDocument: (docId: string) => Promise<void>;
  reindexDocument: (docId: string) => Promise<Agent["documents"][number]>;
  moveDocument: (docId: string, bundleId: string) => Promise<void>;
  createBundle: (name: string, description?: string) => Promise<Bundle>;
  updateBundle: (id: string, patch: { name?: string; description?: string }) => Promise<Bundle>;
  ensureChatBundle: (agent: { id: string; name: string }) => Promise<Bundle>;
  ensureReportBundle: (agent: { id: string; name: string }) => Promise<Bundle>;
  writeReport: (
    sessionId: string,
    agent: { id: string; name: string },
    instruction: string,
  ) => Promise<Agent["documents"][number]>;
  uploadToBundle: (
    bundleId: string,
    file: File,
    onProgress?: (pct: number) => void,
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
    // Hoisted rather than written inline twice: `writeReport` needs the bundle
    // before it can ask for a report, and the store is a plain object literal,
    // so one entry has no way to call another.
    const ensureReportBundle = async (agent: { id: string; name: string }): Promise<Bundle> => {
      const existing = findReportBundle(bundles, agent.id);
      const bundle =
        existing ??
        (await api.bundles.create(reportBundleName(agent.name), reportBundleMarker(agent.id)));
      if (!existing) await queryClient.invalidateQueries({ queryKey: ["bundles"] });

      // Attached, or the Knowledge tab never shows it: that list is
      // `agent.documents`, which is every document in every *attached* bundle.
      // An unattached report would be a file with no screen.
      const attached = agents.find((a) => a.id === agent.id)?.bundleIds.includes(bundle.id);
      if (!attached) {
        await api.bundles.attach(agent.id, bundle.id);
        await queryClient.invalidateQueries({ queryKey: ["agents"] });
      }
      return bundle;
    };

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
          .catch(() => toast.error("Couldn't save the agent."));
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

      // A separate bundle from chat uploads on purpose: chat uploads are
      // sources the agent was given, reports are what it produced. Keeping them
      // apart is what lets someone detach the reports — so the agent stops
      // reading its own output back as evidence — without also detaching the
      // files they uploaded.
      ensureReportBundle,

      writeReport: async (sessionId, agent, instruction) => {
        const bundle = await ensureReportBundle(agent);
        const doc = await api.reports.create(sessionId, { instruction, bundleId: bundle.id });
        // Same refresh as an upload: bundle counts, and the agent's document
        // list with the per-document indexing state the Knowledge tab renders.
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["bundles"] }),
          queryClient.invalidateQueries({ queryKey: ["agents"] }),
          queryClient.invalidateQueries({ queryKey: BUNDLE_DOCUMENTS }),
        ]);
        return doc;
      },

      uploadToBundle: async (bundleId, file, onProgress) => {
        const doc = await api.bundles.upload(bundleId, file, onProgress);
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
