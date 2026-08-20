import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Bundle } from "./api-client";

export type Agent = {
  id: string;
  name: string;
  emoji: string;
  model: string;
  persona: string;
  mode: "normal" | "brainstorm";
  documents: { id: string; name: string; size: number; chunkCount: number; indexed: boolean }[];
  bundleIds: string[];
  createdAt: number;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  // Names of the documents that grounded an assistant reply (real RAG
  // citations). Absent/empty when the reply used no retrieved knowledge.
  sources?: string[];
  // In a shared session, the human author of a user message. Absent for
  // assistant messages and for one's own optimistic messages before refetch.
  sender?: { id: string; name: string | null; avatarUrl: string | null };
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
  createAgent: (a: Omit<Agent, "id" | "createdAt" | "documents" | "bundleIds">) => Promise<Agent>;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  removeDocument: (agentId: string, docId: string) => Promise<void>;
  reindexDocument: (docId: string) => Promise<Agent["documents"][number]>;
  createBundle: (name: string, description?: string) => Promise<Bundle>;
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
  toggleFavorite: (agentId: string) => void;
};

const StoreCtx = createContext<Store | null>(null);

export function AgentsProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

  const { data: agents = [] } = useQuery({
    queryKey: ["agents"],
    queryFn: () => api.agents.list(),
  });
  const { data: sessions = [] } = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.sessions.list(),
  });
  const { data: favorites = [] } = useQuery({
    queryKey: ["favorites"],
    queryFn: () => api.favorites.list(),
  });
  const { data: bundles = [] } = useQuery({
    queryKey: ["bundles"],
    queryFn: () => api.bundles.list(),
  });

  const value = useMemo<Store>(() => {
    return {
      agents,
      sessions,
      favorites,
      bundles,

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

      removeDocument: async (agentId, docId) => {
        await api.documents.remove(docId);
        await queryClient.invalidateQueries({ queryKey: ["agents"] });
      },

      createBundle: async (name, description) => {
        const bundle = await api.bundles.create(name, description);
        await queryClient.invalidateQueries({ queryKey: ["bundles"] });
        return bundle;
      },

      uploadToBundle: async (bundleId, file, onProgress) => {
        const doc = await api.bundles.upload(bundleId, file, onProgress);
        // Refresh bundles (doc counts) and agents (the document list + per-doc
        // indexing status rendered on the Knowledge tab).
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["bundles"] }),
          queryClient.invalidateQueries({ queryKey: ["agents"] }),
        ]);
        return doc;
      },

      reindexDocument: async (docId) => {
        const doc = await api.documents.reindex(docId);
        await queryClient.invalidateQueries({ queryKey: ["agents"] });
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
  }, [agents, sessions, favorites, bundles, queryClient]);

  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useAgentsStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useAgentsStore must be used inside AgentsProvider");
  return ctx;
}
