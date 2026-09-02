import { supabase } from "./supabase/client";
import { ApiError, errorMessage } from "./api-error";
import type { WorkspaceRole } from "./roles";
import type { Agent, ChatSession, Idea, Message } from "./agents-store";
import type { AnswerPatch, OnboardingAnswers } from "./onboarding-flow";
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
  onboarding: { completed: boolean; answers: OnboardingAnswers };
};

export type WorkspaceSummary = { id: string; name: string; slug: string; role: string };

export type PendingInvitation = {
  id: string;
  email: string;
  role: string;
  createdAt: number;
  /**
   * Whether an email actually reached them. Only on the invitation you just
   * created — nothing stores it, so the pending list cannot answer it. Undefined
   * means "not something this response knows", never "no".
   */
  emailed?: boolean;
};

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

export type DocumentCitations = {
  /**
   * The oldest reply that could be counted, as a timestamp — or null when there
   * is none. Not "when we started counting": it is read from the data, so it
   * moves as old conversations are deleted and stays honest either way.
   */
  since: number | null;
  /** Document id to the number of answers citing it. A document with none is absent. */
  counts: Record<string, number>;
};

export type IdeaSuggestion = { title: string; detail: string | null };

// Defined in api-error.ts and re-exported here, so every call site keeps its
// one import. See the note there for why it moved.
export { ApiError };

// Exposed so callers that need a raw `fetch` (e.g. SSE streaming, which the
// JSON-only `request()` helper below doesn't support) can attach the same
// bearer token without duplicating the Supabase session lookup.
export async function getAccessToken(): Promise<string | undefined> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token;
}

/**
 * The filename a `Content-Disposition` asked for, or null.
 *
 * Only the RFC 5987 `filename*=UTF-8''...` form, which is what the Worker
 * sends and the only one that survives a non-ASCII workspace name. A header
 * that does not match returns null and the caller names the file itself,
 * rather than this half-parsing something and producing a name with quotes in
 * it.
 */
function filenameFrom(header: string | null): string | null {
  const match = header?.match(/filename\*=UTF-8''([^;]+)/i);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
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
      message = errorMessage(res.status, await res.json(), res.statusText);
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
              message = errorMessage(xhr.status, JSON.parse(xhr.responseText), xhr.statusText);
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
  /**
   * A recording from the composer, back as text. Sent through the multipart
   * transport rather than `request` because it carries a file; the progress
   * callback it offers is left unused, since a recording is under half a
   * megabyte and finishes before a bar would mean anything.
   */
  transcribe: (recording: File): Promise<{ text: string }> =>
    uploadWithProgress("/transcribe", recording),
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
    // Takes the document's chunks with it — retrieval scope is read from those,
    // not from the document row.
    move: (id: string, bundleId: string): Promise<Agent["documents"][number]> =>
      request("PATCH", `/documents/${id}`, { bundleId }),
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
    /**
     * How many answers cite each document in the workspace, and how far back
     * the counting reaches.
     *
     * `since` is not decoration. Replies written before citations carried ids
     * cannot be matched to a document at all, so every count is over a window —
     * showing the numbers without saying which window turns a sample into a
     * census. `null` means nothing has been counted yet, which is a different
     * screen from every document scoring zero.
     */
    citations: (): Promise<DocumentCitations> => request("GET", "/bundles/citations"),
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
    /**
     * Downloads the whole workspace as one archive.
     *
     * Fetched with the bearer token and handed to the browser as a blob, the
     * same way a document download works — an `<a href>` cannot carry an
     * Authorization header, and putting the token in a query string would put
     * it in every log between here and the Worker.
     *
     * The filename comes from the response rather than from here: the server
     * knows the workspace slug and the date it actually built the archive, and
     * two files called `export.zip` in a downloads folder are two files nobody
     * can tell apart.
     */
    exportArchive: async (workspaceId: string): Promise<void> => {
      const token = await getAccessToken();
      const res = await fetch(`${import.meta.env.VITE_API_URL}/workspaces/${workspaceId}/export`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        let message = res.statusText;
        try {
          message = errorMessage(res.status, await res.json(), res.statusText);
        } catch {
          // A failure that is not JSON is still a failure; keep the status text.
        }
        throw new ApiError(res.status, message);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFrom(res.headers.get("Content-Disposition")) ?? "covan-export.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    members: {
      updateRole: (userId: string, role: WorkspaceRole): Promise<{ ok: true }> =>
        request("PATCH", `/workspace/members/${userId}`, { role }),
      remove: (userId: string): Promise<{ ok: true }> =>
        request("DELETE", `/workspace/members/${userId}`),
      /**
       * How many live API keys somebody has, for the sentence in the removal
       * dialog. `null` means the deployment cannot answer — the migration is not
       * applied yet — which the dialog treats as "say nothing" rather than "none".
       */
      keyCount: (userId: string): Promise<{ count: number | null }> =>
        request("GET", `/workspace/members/${userId}/key-count`),
      /**
       * Leave the workspace you are currently in. `me` is a literal, not a user
       * id — the server resolves the caller from the session, so this cannot be
       * pointed at anybody else.
       */
      leave: (): Promise<{ ok: true }> => request("DELETE", "/workspace/members/me"),
    },
  },
  invitations: {
    list: (): Promise<PendingInvitation[]> => request("GET", "/invitations"),
    create: (input: { email: string; role: WorkspaceRole }): Promise<PendingInvitation> =>
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
  workspaceUsage: (): Promise<WorkspaceUsageResponse> => request("GET", "/usage/workspace"),
  apiKeys: {
    list: (): Promise<ApiKeyList> => request("GET", "/api-keys"),
    /** The only response that carries the key itself. Nothing can return it again. */
    create: (name: string): Promise<ApiKey & { token: string }> =>
      request("POST", "/api-keys", { name }),
    revoke: (id: string): Promise<{ ok: true }> => request("DELETE", `/api-keys/${id}`),
  },
  account: {
    /**
     * Closes the caller's own account. The path carries no id — the server
     * resolves the person from the session, so this cannot be pointed at
     * anybody else, the same arrangement `members.leave` uses.
     *
     * A 409 is not a failure to retry: it means a workspace would be left
     * without an admin, and the message names which. Nothing has been deleted
     * when it arrives.
     */
    close: (): Promise<{ ok: true }> => request("DELETE", "/account"),
  },
  notifications: {
    get: (): Promise<NotificationPreferences> => request("GET", "/notification-preferences"),
    update: (patch: Partial<NotificationPreferences>): Promise<NotificationPreferences> =>
      request("PATCH", "/notification-preferences", patch),
  },
  onboarding: {
    update: (patch: AnswerPatch): Promise<OnboardingAnswers> =>
      request("PATCH", "/onboarding", patch),
    complete: (): Promise<{ completed: true }> => request("POST", "/onboarding/complete"),
  },
  feedback: {
    /**
     * One paragraph, addressed to whoever runs this install.
     *
     * Write-only from the client's side, and there is no `list` here on
     * purpose: nothing in the interface shows feedback back, because there is
     * nobody in the interface it would be right to show it to. See 0041.
     */
    send: (input: FeedbackDraft): Promise<{ id: string; createdAt: number }> =>
      request("POST", "/feedback", input),
  },
  trash: {
    /** 403 for a viewer, deliberately — an empty list would say the wrong thing. */
    list: (): Promise<TrashListing> => request("GET", "/trash"),
    /**
     * `kind` is the word the listing gave back, not a type the caller invents.
     * A 400 here is the one worth reading aloud: it means the document's bundle
     * is deleted too, and that has to go first.
     */
    restore: (kind: TrashKind, id: string): Promise<{ ok: true }> =>
      request("POST", `/trash/${kind}/${id}/restore`),
  },
  events: {
    /** Admin-only at the policy, so a member gets an empty page, not an error. */
    list: (params?: { limit?: number; before?: string }): Promise<EventPage> => {
      const q = new URLSearchParams();
      if (params?.limit) q.set("limit", String(params.limit));
      if (params?.before) q.set("before", params.before);
      const suffix = q.toString();
      return request("GET", `/events${suffix ? `?${suffix}` : ""}`);
    },
  },
};

export type FeedbackKind = "problem" | "idea" | "other";

export type FeedbackDraft = {
  message: string;
  kind?: FeedbackKind;
  /** The page they were on. A path, never a full URL — see the route. */
  path?: string;
  /**
   * The reply this is about, when the note started as a thumb under an answer.
   * 0042 refuses an id the sender could not read.
   */
  messageId?: string;
};

export type TrashKind = "agent" | "bundle" | "document";

export type TrashItem = {
  kind: TrashKind;
  id: string;
  name: string;
  /** Epoch milliseconds, like every other timestamp this API returns. */
  deletedAt: number;
  /** Null once the person who deleted it has closed their own account. */
  deletedBy: string | null;
  /** Which bundle a deleted document came out of; null for the other kinds. */
  parentName: string | null;
  purgesAt: number;
};

export type TrashListing = {
  items: TrashItem[];
  retentionDays: number;
};

export type WorkspaceEvent = {
  id: string;
  action: string;
  subjectType: string;
  subjectId: string | null;
  /** The name as it was at the time — the row it points at may be gone. */
  subjectLabel: string;
  detail: Record<string, unknown> | null;
  createdAt: number;
  /** What to pass as `before` for the next page — see the route for why. */
  cursor: string;
  actor: string | null;
};

export type EventPage = {
  events: WorkspaceEvent[];
  hasMore: boolean;
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
  /**
   * How many of `promptTokens` OpenAI served from its automatic prompt cache —
   * a subset of that figure, not an addition, so it is already reflected in
   * `estCostUsd` and deliberately not in `totalTokens`. Zero on replies stored
   * before the count was recorded (migration 0025).
   */
  cachedTokens: number;
  /**
   * The prompt tokens on replies that actually carry a cache measurement — the
   * denominator for a hit rate. Dividing `cachedTokens` by `promptTokens`
   * instead would fold in every reply from before the count existed and report
   * a rate that climbs on its own as those age out.
   */
  measuredPromptTokens: number;
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

export type UsageTotals = {
  messageCount: number;
  promptTokens: number;
  cachedTokens: number;
  measuredPromptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estCostUsd: number;
};

export type UsageResponse = {
  agents: AgentUsage[];
  quota: QuotaSnapshot;
  totals: UsageTotals;
};

/**
 * One month of the workspace's traffic. No cost: `messages` records no model,
 * so pricing a month would mean assuming every reply in it came from whatever
 * the agent is set to today. The per-agent rows carry the money.
 */
export type UsageMonth = {
  /** First day of the month, ISO. Oldest first, so it draws left to right. */
  month: string;
  messageCount: number;
  totalTokens: number;
  cachedTokens: number;
};

/**
 * The workspace's own figures, for an admin. Aggregated by agent and by month
 * and never by person — that is a property of the functions in `0032`, which
 * do not select, group by or return a `user_id` at all.
 *
 * `available` is false in exactly one situation: the API is deployed and
 * `0032` has not been applied yet. CI does not run migrations, so that window
 * is real, and it renders as the section being absent rather than as an error.
 */
export type WorkspaceUsageResponse = {
  available: boolean;
  agents: AgentUsage[];
  totals: UsageTotals;
  months: UsageMonth[];
};

export type ApiKey = {
  id: string;
  name: string;
  /** The visible head of the key. All of it that anything will ever show again. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
};

/**
 * `available: false` means this deployment cannot sign the token an API key is
 * exchanged for — no `SUPABASE_JWT_SECRET` — so keys are off rather than empty.
 * Two different sentences, and the section renders nothing for the first.
 */
export type ApiKeyList = { available: boolean; keys: ApiKey[] };
