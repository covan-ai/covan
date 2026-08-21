import { supabase } from "./supabase/client";
import type { Agent, ChatSession, Idea, Message } from "./agents-store";
import type {
  Routine,
  RoutineRun,
  DeliveryChannel,
  RoutineDraft,
  CreateRoutineInput,
  UpdateRoutineInput,
} from "./routines-api";

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  /** Model new agents start on. `null` means the interface picks. */
  defaultModel: string | null;
};

export type WorkspaceMember = {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  avatarUrl: string | null;
};

export type Me = {
  user: { id: string; name: string | null; email: string | null; avatarUrl: string | null };
  workspace: Workspace;
  members: WorkspaceMember[];
};

export type WorkspaceSummary = { id: string; name: string; slug: string; role: string };

export type PendingInvitation = { id: string; email: string; role: string; createdAt: number };

export type IncomingInvitation = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
  createdAt: number;
};

export type Bundle = {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  createdAt: number;
};

export type IdeaSuggestion = { title: string; detail: string | null };

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// Exposed so callers that need a raw `fetch` (e.g. SSE streaming, which the
// JSON-only `request()` helper below doesn't support) can attach the same
// bearer token without duplicating the Supabase session lookup.
export async function getAccessToken(): Promise<string | undefined> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = await getAccessToken();

  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${import.meta.env.VITE_API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const errBody = await res.json();
      if (errBody && typeof errBody.error === "string") {
        message = errBody.error;
      }
      // 402 is the one refusal with a machine-readable shape, and its `error`
      // field is a code rather than a sentence. Turned into prose here so every
      // caller — upload, persona, routine draft — reports it the same way
      // without each one knowing about quotas.
      if (res.status === 402 && errBody?.error === "quota_exceeded") {
        const resets =
          typeof errBody.resetsAt === "string"
            ? new Date(errBody.resetsAt).toLocaleDateString(undefined, {
                month: "long",
                day: "numeric",
              })
            : null;
        message = resets
          ? `You've used this month's allowance. It resets on ${resets}.`
          : "You've used this month's allowance.";
      }
    } catch {
      // ignore JSON parse failure, fall back to statusText
    }
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  const text = await res.text();
  if (!text) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

// XHR-based upload with progress. Kept separate from `request()` because the
// JSON helper can't report upload progress. Token lookup rejects on failure
// (see commit 02d3a15) so a missing session surfaces as an error, not a silent
// unauthenticated request.
// Extract text from a PDF in the browser (where pdf.js runs reliably). unpdf is
// lazy-imported so its pdf.js payload only loads when a PDF is actually picked.
async function extractPdfText(file: File): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const buf = await file.arrayBuffer();
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n\n") : (text ?? "");
}

function uploadWithProgress<T>(
  path: string,
  file: File,
  onProgress?: (pct: number) => void,
  fields?: Record<string, string>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    getAccessToken()
      .then((token) => {
        const form = new FormData();
        form.append("file", file);
        if (fields) {
          for (const [k, v] of Object.entries(fields)) form.append(k, v);
        }
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${import.meta.env.VITE_API_URL}${path}`);
        if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
        xhr.upload.onprogress = (e) => {
          if (onProgress && e.lengthComputable) {
            onProgress(Math.round((e.loaded / e.total) * 100));
          }
        };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              resolve(JSON.parse(xhr.responseText));
            } catch {
              reject(new ApiError(xhr.status, "invalid server response"));
            }
          } else {
            let message = xhr.statusText;
            try {
              const body = JSON.parse(xhr.responseText);
              if (body && typeof body.error === "string") message = body.error;
            } catch {
              // fall back to statusText
            }
            reject(new ApiError(xhr.status, message));
          }
        };
        xhr.onerror = () => reject(new ApiError(0, "network error"));
        xhr.send(form);
      })
      .catch((e) => {
        reject(
          e instanceof ApiError
            ? e
            : new ApiError(0, e instanceof Error ? e.message : "upload failed"),
        );
      });
  });
}

export const api = {
  agents: {
    list: (): Promise<Agent[]> => request("GET", "/agents"),
    create: (input: {
      name: string;
      emoji?: string;
      model?: string;
      persona?: string;
      mode?: "normal" | "brainstorm";
    }): Promise<Agent> => request("POST", "/agents", input),
    update: (
      id: string,
      patch: Partial<Pick<Agent, "name" | "emoji" | "model" | "persona" | "mode">>,
    ): Promise<Agent> => request("PATCH", `/agents/${id}`, patch),
    remove: (id: string): Promise<void> => request("DELETE", `/agents/${id}`),
    toggleFavorite: (id: string): Promise<{ favorited: boolean }> =>
      request("POST", `/agents/${id}/favorite`),
  },
  documents: {
    remove: (id: string): Promise<void> => request("DELETE", `/documents/${id}`),
    reindex: (id: string): Promise<Agent["documents"][number]> =>
      request("POST", `/documents/${id}/reindex`),
    download: async (id: string, name: string): Promise<void> => {
      const token = await getAccessToken();
      const res = await fetch(`${import.meta.env.VITE_API_URL}/documents/${id}/download`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new ApiError(res.status, "failed to download");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  },
  bundles: {
    list: (): Promise<Bundle[]> => request("GET", "/bundles"),
    create: (name: string, description?: string): Promise<Bundle> =>
      request("POST", "/bundles", { name, description }),
    remove: (id: string): Promise<{ ok: true }> => request("DELETE", `/bundles/${id}`),
    attach: (agentId: string, bundleId: string): Promise<{ ok: true }> =>
      request("POST", `/agents/${agentId}/bundles/${bundleId}`),
    detach: (agentId: string, bundleId: string): Promise<{ ok: true }> =>
      request("DELETE", `/agents/${agentId}/bundles/${bundleId}`),
    upload: async (
      bundleId: string,
      file: File,
      onProgress?: (pct: number) => void,
    ): Promise<Agent["documents"][number]> => {
      // pdf.js can't run on the Workers runtime, so PDFs are parsed here in the
      // browser and the extracted text is sent alongside the file for indexing.
      let fields: Record<string, string> | undefined;
      if (file.name.toLowerCase().endsWith(".pdf")) {
        const text = await extractPdfText(file).catch(() => "");
        if (text) fields = { text };
      }
      return uploadWithProgress(`/bundles/${bundleId}/documents/upload`, file, onProgress, fields);
    },
  },
  favorites: {
    list: (): Promise<string[]> => request("GET", "/favorites"),
  },
  sessions: {
    list: (): Promise<ChatSession[]> => request("GET", "/sessions"),
    create: (input: {
      agentId: string;
      title?: string;
      kind?: "chat" | "brainstorm";
    }): Promise<ChatSession> => request("POST", "/sessions", input),
    remove: (id: string): Promise<void> => request("DELETE", `/sessions/${id}`),
    messages: (id: string): Promise<Message[]> => request("GET", `/sessions/${id}/messages`),
    setVisibility: (id: string, visibility: "private" | "shared"): Promise<ChatSession> =>
      request("PATCH", `/sessions/${id}`, { visibility }),
  },
  messages: {
    create: (input: { sessionId: string; role: "user"; content: string }): Promise<Message> =>
      request("POST", "/messages", input),
    update: (id: string, content: string): Promise<Message> =>
      request("PATCH", `/messages/${id}`, { content }),
    deleteAfter: (id: string): Promise<void> => request("DELETE", `/messages/after/${id}`),
  },
  ideas: {
    list: (sessionId: string): Promise<Idea[]> => request("GET", `/sessions/${sessionId}/ideas`),
    create: (
      sessionId: string,
      input: { title: string; detail?: string; stage?: Idea["stage"]; sourceMessageId?: string },
    ): Promise<Idea> => request("POST", `/sessions/${sessionId}/ideas`, input),
    update: (
      id: string,
      patch: Partial<Pick<Idea, "title" | "detail" | "stage" | "position">>,
    ): Promise<Idea> => request("PATCH", `/ideas/${id}`, patch),
    remove: (id: string): Promise<{ ok: true }> => request("DELETE", `/ideas/${id}`),
  },
  brainstorm: {
    suggest: (sessionId: string): Promise<{ ideas: IdeaSuggestion[] }> =>
      request("POST", "/brainstorm/ideas/suggest", { sessionId }),
  },
  persona: {
    suggest: (name: string, model?: string): Promise<{ persona: string }> =>
      request("POST", "/persona/suggest", { name, model }),
  },
  me: (): Promise<Me> => request("GET", "/me"),
  profile: {
    update: (patch: { name: string }): Promise<Me["user"]> => request("PATCH", "/me", patch),
  },
  workspaces: {
    list: (): Promise<WorkspaceSummary[]> => request("GET", "/workspaces"),
    create: (name: string): Promise<{ id: string }> => request("POST", "/workspaces", { name }),
  },
  workspace: {
    update: (patch: {
      name?: string;
      slug?: string;
      defaultModel?: string | null;
    }): Promise<Workspace> => request("PATCH", "/workspace", patch),
    setActive: (workspaceId: string): Promise<{ ok: true }> =>
      request("POST", "/workspace/active", { workspaceId }),
    members: {
      updateRole: (userId: string, role: "admin" | "member"): Promise<{ ok: true }> =>
        request("PATCH", `/workspace/members/${userId}`, { role }),
      remove: (userId: string): Promise<{ ok: true }> =>
        request("DELETE", `/workspace/members/${userId}`),
    },
  },
  invitations: {
    list: (): Promise<PendingInvitation[]> => request("GET", "/invitations"),
    create: (input: { email: string; role: "admin" | "member" }): Promise<PendingInvitation> =>
      request("POST", "/invitations", input),
    revoke: (id: string): Promise<{ ok: true }> => request("DELETE", `/invitations/${id}`),
    incoming: (): Promise<IncomingInvitation[]> => request("GET", "/invitations/incoming"),
    accept: (id: string): Promise<{ workspaceId: string }> =>
      request("POST", `/invitations/${id}/accept`),
  },
  routines: {
    list: (): Promise<Routine[]> => request("GET", "/routines"),
    create: (input: CreateRoutineInput): Promise<Routine> => request("POST", "/routines", input),
    update: (id: string, patch: UpdateRoutineInput): Promise<Routine> =>
      request("PATCH", `/routines/${id}`, patch),
    remove: (id: string): Promise<void> => request("DELETE", `/routines/${id}`),
    runs: (id: string): Promise<RoutineRun[]> => request("GET", `/routines/${id}/runs`),
    /** Runs it now instead of waiting for the schedule. Resolves when the run ends. */
    run: (id: string): Promise<{ status: "ok" | "skipped" | "failed"; itemsNew: number }> =>
      request("POST", `/routines/${id}/run`),
    draft: (text: string, timezone: string): Promise<RoutineDraft> =>
      request("POST", "/routines/draft", { text, timezone }),
  },
  deliveryChannels: {
    list: (): Promise<DeliveryChannel[]> => request("GET", "/delivery-channels"),
    create: (input: {
      kind: "slack_webhook" | "email";
      secret: string;
    }): Promise<DeliveryChannel> => request("POST", "/delivery-channels", input),
    remove: (id: string): Promise<void> => request("DELETE", `/delivery-channels/${id}`),
  },
  usage: (): Promise<UsageResponse> => request("GET", "/usage"),
  notifications: {
    get: (): Promise<NotificationPreferences> => request("GET", "/notification-preferences"),
    update: (patch: Partial<NotificationPreferences>): Promise<NotificationPreferences> =>
      request("PATCH", "/notification-preferences", patch),
  },
};

/**
 * Which engine notices this person wants. Not the routine output itself — that
 * is what a routine is for.
 */
export type NotificationPreferences = {
  routinePaused: boolean;
  quotaExhausted: boolean;
};

export type AgentUsage = {
  agentId: string;
  name: string;
  emoji: string | null;
  model: string;
  messageCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estCostUsd: number;
};

/**
 * What the caller may still spend this period. `limit: null` means unmetered —
 * a self-hosted Covan brings its own OpenAI key and has no allowance to show,
 * so the interface renders nothing at all for this.
 */
export type QuotaSnapshot = {
  used: number;
  limit: number | null;
  resetsAt: string | null;
};

export type UsageResponse = {
  agents: AgentUsage[];
  quota: QuotaSnapshot;
  totals: {
    messageCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estCostUsd: number;
  };
};
