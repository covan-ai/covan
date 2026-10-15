import { supabase } from "./supabase/client";
import { ApiError, errorMessage } from "./api-error";
import { assetSrc } from "./asset-src";
import type { WorkspaceRole } from "./roles";
import type { Agent, ChatSession, Idea, Message, SessionTuning } from "./agents-store";
import type { AgentSharing } from "./agent-access";

import type { AnswerPatch, OnboardingAnswers } from "./onboarding-flow";
import type {
  Connection,
  ComposioCategoriesResponse,
  ComposioToolkitDetailResponse,
  ComposioToolkitsResponse,
  ConnectionRun,
  ConnectionsResponse,
  DriveFolder,
  ProviderId,
  SlackState,
  SyncOutcome,
  ToolConnection,
  ToolConnectionGrant,
  ToolConnectionsResponse,
} from "./connections-api";
import type {
  Routine,
  RoutineRun,
  DeliveryChannel,
  DeliveryChannelKind,
  CreatedDeliveryChannel,
  ConfirmationOutcome,
  RoutineDraft,
  RoutineTrigger,
  CreateRoutineInput,
  UpdateRoutineInput,
} from "./routines-api";

// Where the sharing vocabulary lives, re-exported so a caller that already
// imports the client's types does not need a second import for these.
export type { AgentAccess, AgentShare, AgentSharing } from "./agent-access";

export type Workspace = {
  id: string;
  name: string;
  slug: string;
  /** Model new agents start on. `null` means the interface picks. */
  defaultModel: string | null;
  /**
   * Whether this workspace has turned the coverage report on.
   *
   * Optional for the reason `models` is: a frontend deployed ahead of its API
   * gets nothing here, and the template picker reads the absence as off —
   * which is the safe direction, since the alternative is offering a routine
   * the engine would refuse.
   */
  gapReportEnabled?: boolean;
};

export type WorkspaceMember = {
  id: string;
  name: string | null;
  email: string | null;
  role: string;
  avatarUrl: string | null;
  /** Optional because an API older than profile fields sends neither. */
  bio?: string | null;
  timezone?: string | null;
};

/**
 * You, as `PATCH /me` and the avatar routes answer. `bio`, `locale` and
 * `timezone` are optional for the same reason they are on `WorkspaceMember`.
 */
export type Profile = {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  bio?: string | null;
  /** BCP 47, e.g. "tr-TR". Null follows the browser. */
  locale?: string | null;
  /** IANA, e.g. "Europe/Istanbul". Null follows the device. */
  timezone?: string | null;
};

/**
 * What `PATCH /me` accepts. Only the keys present are written; null clears a
 * field. Email and avatar are not here: email changes through Supabase Auth,
 * which owns the address, and the avatar through its own upload route.
 */
export type ProfilePatch = {
  name?: string;
  bio?: string | null;
  locale?: string | null;
  timezone?: string | null;
};

export type Me = {
  user: Profile;
  workspace: Workspace;
  members: WorkspaceMember[];
  /**
   * The model ids this deployment can serve, in picker order.
   *
   * Optional because it is newer than this client: a frontend deployed ahead of
   * its API would otherwise render an empty picker rather than the built-in
   * list. `modelsFor` in `lib/agent-meta` handles the absence.
   */
  models?: string[];
  /**
   * What each of those ids accepts — whether a temperature may be sent, and
   * whether the model thinks before it answers. Optional for the same reason
   * `models` is: a frontend deployed ahead of its API gets nothing here, and
   * `specFor` in `lib/agent-meta` answers for an id it was told nothing about.
   */
  modelSpecs?: Record<string, { temperature: boolean; reasoning: boolean; webSearch: boolean }>;
  /**
   * Estimated USD for one reference reply per model. Optional because an API
   * older than this field sends none, and empty on a deployment whose
   * `OPENAI_MODEL` makes the picked id irrelevant — both mean "no price".
   */
  modelCosts?: Record<string, number>;
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
  /**
   * The link with the token in it. Only on the response that minted it —
   * creating or resending an invitation — because nothing can show it again.
   * With no mail configured, passing it on is how the invitee receives it.
   */
  inviteUrl?: string;
  /** Its link ran out, or it predates links: it needs Resend to be accepted. */
  needsResend: boolean;
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
  /**
   * Whether the workspace can see it (0106). Private bundles are their maker's
   * alone: the files, what they say, and the answers they ground. Optional so
   * a fixture or an older response reads as the shared bundle it was.
   */
  shared?: boolean;
  /** Whether the caller made it — who may share it or stop sharing it. */
  mine?: boolean;
};

/**
 * One document, with the text the agent has of it.
 *
 * The excerpt and the file are two different answers and the preview screen
 * shows both: `GET /documents/:id/preview` returns what was indexed — the
 * extracted text cut at `excerptLimit`, which is exactly what grounds a reply
 * when no passage matched — while the bytes come separately from
 * `documents.bytes` for rendering the file as it is.
 */
export type DocumentPreview = Agent["documents"][number] & {
  excerpt: string;
  excerptLimit: number;
  /**
   * Whether the excerpt runs to the limit, which means the stored text stops
   * before the document does. It is not a count of what is missing: nothing
   * stores the full length, so the screen says where the excerpt ends rather
   * than how much came after.
   */
  excerptTruncated: boolean;
  /** When a connected source last refreshed it, or null for an upload. */
  syncedAt: number | null;
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

/**
 * A document's stored bytes, with the type the store recorded for them.
 *
 * Outside `request()` because the response is a file rather than JSON, and
 * shared by `documents.download` and `documents.bytes` so the preview and the
 * download are reading the same thing through the same route.
 */
async function fetchDocumentBytes(id: string): Promise<{ blob: Blob; contentType: string }> {
  const token = await getAccessToken();
  const res = await fetch(`${import.meta.env.VITE_API_URL}/documents/${id}/download`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError(res.status, "failed to download");
  return { blob: await res.blob(), contentType: res.headers.get("Content-Type") ?? "" };
}

/**
 * A Markdown document as Word or PDF, saved to the person's downloads.
 *
 * Answers `"print"` instead of throwing when the server has no browser to
 * print a PDF with (501, `fallback: "print"`): the caller then prints the
 * document in this browser, which is the same PDF by another road.
 */
async function exportDocument(id: string, format: "docx" | "pdf"): Promise<"saved" | "print"> {
  const token = await getAccessToken();
  const res = await fetch(`${import.meta.env.VITE_API_URL}/documents/${id}/export/${format}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 501 && format === "pdf") return "print";
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = errorMessage(res.status, await res.json(), res.statusText);
    } catch {
      // not JSON; the status text stands
    }
    throw new ApiError(res.status, message);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filenameFrom(res.headers.get("Content-Disposition")) ?? `document.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return "saved";
}

// Defined in asset-src.ts, which imports nothing, so the avatar helper that
// builds on it can be tested without this module's Supabase client.
export { assetSrc };

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

/**
 * One file as multipart, with the same errors `request()` throws.
 *
 * Not `uploadWithProgress`, which is POST-only and built around a progress
 * bar; an avatar is a few kilobytes by the time it is sent and replaces
 * whatever was there, so it is a PUT and there is nothing to watch.
 */
async function sendForm<T>(method: string, path: string, file: Blob): Promise<T> {
  const token = await getAccessToken();
  const form = new FormData();
  form.append("file", file, file instanceof File ? file.name : "upload");
  const res = await fetch(`${import.meta.env.VITE_API_URL}${path}`, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
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
  return (await res.json()) as T;
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

/**
 * How much of a document's text is indexed — `MAX_INDEX_CHARS` in
 * `worker/src/lib/extract.ts`. A PDF's text is cut here before it is sent,
 * since the server keeps no more than this of it anyway.
 */
const MAX_INDEX_CHARS = 2_000_000;

/**
 * Files up to this go in one request; anything bigger goes in parts. Under the
 * one-request route's 10 MB, so the text a PDF carries beside it still fits.
 */
const ONE_REQUEST_BYTES = 8 * 1024 * 1024;

/** What an upload is doing, for the line under the file's name. */
export type UploadPhase = "reading" | "uploading";

/** One part of an upload, PUT with progress. Retried twice on a dropped connection. */
async function putPart(
  token: string,
  n: number,
  body: Blob,
  to: "file" | "text",
  onLoaded: (bytes: number) => void,
): Promise<{ partNumber: number; etag: string }> {
  const auth = await getAccessToken();
  for (let attempt = 0; ; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", `${import.meta.env.VITE_API_URL}/uploads/parts?n=${n}&to=${to}`);
        if (auth) xhr.setRequestHeader("Authorization", `Bearer ${auth}`);
        xhr.setRequestHeader("X-Upload-Token", token);
        xhr.upload.onprogress = (e) => onLoaded(e.loaded);
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            onLoaded(body.size);
            resolve(JSON.parse(xhr.responseText));
            return;
          }
          let message = xhr.statusText;
          try {
            message = errorMessage(xhr.status, JSON.parse(xhr.responseText), xhr.statusText);
          } catch {
            // fall back to statusText
          }
          reject(new ApiError(xhr.status, message));
        };
        xhr.onerror = () => reject(new ApiError(0, "network error"));
        xhr.send(body);
      });
    } catch (e) {
      const retryable = e instanceof ApiError && (e.status === 0 || e.status >= 500);
      if (!retryable || attempt >= 2) throw e;
      onLoaded(0);
    }
  }
}

/**
 * A file sent in parts (`worker/src/routes/uploads.ts`): start, every part in
 * order, then complete — or abort, so a failed upload leaves nothing behind.
 */
async function uploadInParts<T>(
  bundleId: string,
  file: File,
  text: string,
  onProgress?: (pct: number) => void,
): Promise<T> {
  const textBlob = text ? new Blob([text], { type: "text/plain" }) : null;
  const { token, partSize } = await request<{ token: string; partSize: number }>(
    "POST",
    `/bundles/${bundleId}/uploads`,
    { name: file.name, size: file.size, withText: Boolean(textBlob) },
  );
  const total = file.size + (textBlob?.size ?? 0);
  let done = 0;
  const report = (inFlight: number) =>
    onProgress?.(Math.min(99, Math.round(((done + inFlight) / total) * 100)));

  const send = async (blob: Blob, to: "file" | "text") => {
    const parts: Array<{ partNumber: number; etag: string }> = [];
    for (let offset = 0, n = 1; offset < blob.size; offset += partSize, n++) {
      const slice = blob.slice(offset, offset + partSize);
      parts.push(await putPart(token, n, slice, to, report));
      done += slice.size;
    }
    return parts;
  };

  try {
    const parts = await send(file, "file");
    const textParts = textBlob ? await send(textBlob, "text") : undefined;
    const doc = await request<T>("POST", "/uploads/complete", { token, parts, textParts });
    onProgress?.(100);
    return doc;
  } catch (e) {
    void request("POST", "/uploads/abort", { token }).catch(() => {});
    throw e;
  }
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
      /** Who else can reach it. Left out, the server makes it Only me. */
      sharing?: AgentSharing;
    }): Promise<Agent> => request("POST", "/agents", input),
    update: (
      id: string,
      patch: Partial<
        Pick<
          Agent,
          "name" | "emoji" | "model" | "persona" | "mode" | "temperature" | "reasoningEffort"
        >
      >,
    ): Promise<Agent> => request("PATCH", `/agents/${id}`, patch),
    remove: (id: string): Promise<void> => request("DELETE", `/agents/${id}`),
    /**
     * Who can reach the agent, and how far. The list is the whole list: anybody
     * left out of `shares` loses their row. 403 for anyone short of Full access.
     */
    setSharing: (id: string, sharing: AgentSharing): Promise<Agent> =>
      request("PUT", `/agents/${id}/sharing`, sharing),
    toggleFavorite: (id: string): Promise<{ favorited: boolean }> =>
      request("POST", `/agents/${id}/favorite`),
  },
  documents: {
    remove: (id: string): Promise<void> => request("DELETE", `/documents/${id}`),
    /** A new name. Refused (409) for a synced file, whose name is its source's. */
    rename: (id: string, name: string): Promise<Agent["documents"][number]> =>
      request("PATCH", `/documents/${id}`, { name }),
    reindex: (id: string): Promise<Agent["documents"][number]> =>
      request("POST", `/documents/${id}/reindex`),
    // Takes the document's chunks with it — retrieval scope is read from those,
    // not from the document row.
    move: (id: string, bundleId: string): Promise<Agent["documents"][number]> =>
      request("PATCH", `/documents/${id}`, { bundleId }),
    /**
     * What was indexed, rather than what was uploaded. One row, no store read.
     */
    preview: (id: string): Promise<DocumentPreview> => request("GET", `/documents/${id}/preview`),
    /**
     * The file itself, for rendering it in place.
     *
     * The same endpoint `download` uses, and fetching it as a blob is what
     * discards its `Content-Disposition: attachment` — the header only ever
     * addressed a browser navigating straight to the URL, which this client
     * cannot do anyway (the route needs a bearer token). So the type is the
     * only protection the bytes arrive with, and it is no longer the type
     * whoever uploaded them chose: the server derives it from the document's
     * own name (`worker/src/lib/extract.ts`, `contentTypeFor`) and says
     * `nosniff`. Callers that make an object URL of the blob must still pin
     * the type themselves — a `blob:` document runs in this origin — which is
     * why `document-preview-dialog.tsx` re-slices before it frames one.
     */
    bytes: fetchDocumentBytes,
    download: async (id: string, name: string): Promise<void> => {
      const { blob } = await fetchDocumentBytes(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    export: exportDocument,
  },
  reports: {
    /**
     * Start writing this conversation up as a document.
     *
     * Answers at once with the job, not the document: the engine writes it
     * section by section in the background and the conversation follows it
     * through `sessions.documentJobs`. Unset `bundleId` means the agent's
     * reports bundle, which the server finds or makes.
     */
    create: (
      sessionId: string,
      body: { instruction: string; bundleId?: string },
    ): Promise<DocumentJob> => request("POST", `/sessions/${sessionId}/report`, body),
  },
  documentJobs: {
    get: (id: string): Promise<DocumentJob> => request("GET", `/document-jobs/${id}`),
    /** Keep what is written, write no more. */
    stop: (id: string): Promise<void> => request("POST", `/document-jobs/${id}/stop`),
    /** Pick a failed or stopped document up where it ended. */
    retry: (id: string): Promise<void> => request("POST", `/document-jobs/${id}/retry`),
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
    /**
     * What is in one bundle.
     *
     * Asked for per bundle rather than folded into `list`, and lazily: a
     * workspace with thirty bundles is a workspace where twenty-nine of the
     * lists are not being looked at. It is also the only way to read a bundle no
     * agent has attached — the agent's own document list covers the attached
     * ones and nothing covers the rest.
     */
    documents: (id: string): Promise<Agent["documents"]> =>
      request("GET", `/bundles/${id}/documents`),
    /** Private to its maker unless `shared`. */
    create: (name: string, description?: string, shared?: boolean): Promise<Bundle> =>
      request("POST", "/bundles", { name, description, ...(shared ? { shared: true } : {}) }),
    /** Rename one, change the line under its name, or share it / stop sharing it. */
    update: (
      id: string,
      patch: { name?: string; description?: string; shared?: boolean },
    ): Promise<Bundle> => request("PATCH", `/bundles/${id}`, patch),
    remove: (id: string): Promise<{ ok: true }> => request("DELETE", `/bundles/${id}`),
    attach: (agentId: string, bundleId: string): Promise<{ ok: true }> =>
      request("POST", `/agents/${agentId}/bundles/${bundleId}`),
    detach: (agentId: string, bundleId: string): Promise<{ ok: true }> =>
      request("DELETE", `/agents/${agentId}/bundles/${bundleId}`),
    upload: async (
      bundleId: string,
      file: File,
      onProgress?: (pct: number) => void,
      onPhase?: (phase: UploadPhase) => void,
    ): Promise<Agent["documents"][number]> => {
      // pdf.js can't run on the Workers runtime, so PDFs are parsed here in the
      // browser and the extracted text is sent alongside the file for indexing.
      let text = "";
      if (file.name.toLowerCase().endsWith(".pdf")) {
        onPhase?.("reading");
        try {
          text = (await extractPdfText(file)).slice(0, MAX_INDEX_CHARS);
        } catch {
          // Said here rather than left to the server, which would only see "no
          // text" and call a locked or damaged PDF a scan.
          throw new ApiError(
            0,
            `${file.name}: this PDF could not be opened — it may be password-protected or damaged`,
          );
        }
      }
      onPhase?.("uploading");
      if (file.size <= ONE_REQUEST_BYTES) {
        return uploadWithProgress(
          `/bundles/${bundleId}/documents/upload`,
          file,
          onProgress,
          text ? { text } : undefined,
        );
      }
      return uploadInParts(bundleId, file, text, onProgress);
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
    /**
     * The transcript, newest `limit` turns of it, oldest first.
     *
     * The limit is the endpoint's whether or not it is named here — it serves
     * a hundred turns by default. Naming one is how the screen asks for more
     * of a conversation somebody has scrolled back through.
     */
    messages: (id: string, opts?: { limit?: number }): Promise<Message[]> =>
      request(
        "GET",
        opts?.limit ? `/sessions/${id}/messages?limit=${opts.limit}` : `/sessions/${id}/messages`,
      ),
    setVisibility: (id: string, visibility: "private" | "shared"): Promise<ChatSession> =>
      request("PATCH", `/sessions/${id}`, { visibility }),
    rename: (id: string, title: string): Promise<ChatSession> =>
      request("PATCH", `/sessions/${id}`, { title }),
    /**
     * Turn the dial on one conversation: its model, how hard it thinks, its
     * mode, and whether it may search the web. Only the fields named are
     * sent; a null puts that one back to the agent's own. Owner-only, by the
     * same policy that guards rename and share — the server refuses anyone
     * else whether or not the control was showing.
     */
    tune: (id: string, patch: SessionTuning): Promise<ChatSession> =>
      request("PATCH", `/sessions/${id}`, patch),
    /**
     * Whether the conversation has a turn running on the server — usually the
     * one this browser asked for before it opened another conversation or
     * closed the tab. `mine` is whether this caller may stop it. Null when
     * there is none, and always null on a deployment whose turns end with
     * their request.
     */
    turn: (
      id: string,
    ): Promise<{ turn: { running: boolean; mine: boolean; startedAt: number } | null }> =>
      request("GET", `/sessions/${id}/turn`),
    /**
     * Stop the conversation's turn, answering once it has written down what it
     * had. `message` is the reply it kept, when it kept one; `stopped` is false
     * when nothing was running on the server to stop.
     */
    stopTurn: (id: string): Promise<{ stopped: boolean; message: Message | null }> =>
      request("POST", `/sessions/${id}/turn/stop`),
    /**
     * The browser beside one conversation: its tasks newest first, the
     * browser's own state, what the agent did since the last ask, and whether
     * this ask is the one that delivered an answer.
     *
     * A table read rather than an SSE event, and that is the point: the
     * approval card is driven only by a `confirm` event into in-memory state
     * and does not survive a reload, while the browser panel has to. It is
     * also the live endpoint — each call asks the provider how the run is
     * going — so the panel polls it every three seconds while something is
     * happening and not at all otherwise.
     */
    browserTasks: (id: string): Promise<ConversationBrowser> =>
      request("GET", `/sessions/${id}/browser-tasks`),
    /**
     * The documents this person asked for in one conversation, newest first,
     * each with its sections so far. Polled while one is being written; on a
     * deployment with no document host each poll is also what moves it on.
     */
    documentJobs: (id: string): Promise<DocumentJob[]> =>
      request("GET", `/sessions/${id}/document-jobs`),
  },
  messages: {
    create: (input: { sessionId: string; role: "user"; content: string }): Promise<Message> =>
      request("POST", "/messages", input),
    update: (id: string, content: string): Promise<Message> =>
      request("PATCH", `/messages/${id}`, { content }),
    deleteAfter: (id: string): Promise<void> => request("DELETE", `/messages/after/${id}`),
    /**
     * Put a different version of an answer back on screen.
     *
     * Regenerating keeps the reply it replaced rather than deleting it (0050),
     * and this is how somebody goes back to one.
     */
    show: (id: string): Promise<{ ok: true }> => request("POST", `/messages/${id}/show`),
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
  search: {
    /**
     * Full-text search across messages.
     *
     * Returns only what RLS allows: the caller's own conversations plus any
     * shared into their workspace. Ordered newest first; relevance is the
     * tiebreaker within the same timestamp.
     */
    messages: (q: string, opts?: { limit?: number }): Promise<Message[]> =>
      request(
        "GET",
        opts?.limit
          ? `/search/messages?q=${encodeURIComponent(q)}&limit=${opts.limit}`
          : `/search/messages?q=${encodeURIComponent(q)}`,
      ),
  },
  profile: {
    update: (patch: ProfilePatch): Promise<Profile> => request("PATCH", "/me", patch),
    /** Already resized by `resizeAvatar`; the server still checks it is an image. */
    uploadAvatar: (image: Blob): Promise<Profile> => sendForm("PUT", "/me/avatar", image),
    removeAvatar: (): Promise<Profile> => request("DELETE", "/me/avatar"),
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
    /** A new link: the old one stops working and the seven days start again. */
    resend: (id: string): Promise<PendingInvitation> =>
      request("POST", `/invitations/${id}/resend`),
    incoming: (): Promise<IncomingInvitation[]> => request("GET", "/invitations/incoming"),
    /** `token` is the one the invitation email's link carried. See `invite-stash.ts`. */
    accept: (id: string, token: string): Promise<{ workspaceId: string }> =>
      request("POST", `/invitations/${id}/accept`, { token }),
  },
  connections: {
    list: (): Promise<ConnectionsResponse> => request("GET", "/connections"),
    runs: (id: string): Promise<ConnectionRun[]> => request("GET", `/connections/${id}/runs`),
    /**
     * Begin a grant. Returns the provider's consent URL rather than following a
     * redirect: a cross-origin 302 from `fetch` lands as a CORS error, not a
     * login page, so the navigation has to happen in the page.
     */
    start: (provider: ProviderId, bundleId: string, nonceHash: string): Promise<{ url: string }> =>
      request("POST", `/connections/${provider}/start`, { bundleId, nonceHash }),
    /**
     * A new grant for a connection that already exists.
     *
     * The same consent flow as `start`, aimed at a row rather than at a bundle.
     * The alternative — delete and connect again — left a second connection
     * pointed at the same bundle and the old one sitting there paused.
     */
    reconnect: (id: string, nonceHash: string): Promise<{ url: string }> =>
      request("POST", `/connections/${id}/reconnect`, { nonceHash }),
    /**
     * Finish a grant the provider sent this tab back with. `nonce` is the one
     * this tab started the flow with (`lib/flow-nonce.ts`).
     */
    complete: (input: {
      grant: string;
      nonce: string;
    }): Promise<{ provider: ProviderId; connectionId: string; reconnected: boolean }> =>
      request("POST", "/connections/complete", input),
    /** One level of a Drive tree. The browser holds no Google token of its own. */
    folders: (id: string, parent?: string): Promise<DriveFolder[]> =>
      request("GET", `/connections/${id}/folders${parent ? `?parent=${parent}` : ""}`),
    update: (
      id: string,
      patch: {
        status?: "active" | "paused";
        syncIntervalMinutes?: number;
        folderId?: string;
        folderName?: string;
      },
    ): Promise<Connection> => request("PATCH", `/connections/${id}`, patch),
    sync: (id: string): Promise<SyncOutcome> => request("POST", `/connections/${id}/sync`),
    /**
     * `keep` is the default, and the schema agrees: disconnecting a source is
     * not a request to unlearn what it taught.
     */
    remove: (id: string, documents: "keep" | "delete" = "keep"): Promise<void> =>
      request("DELETE", `/connections/${id}?documents=${documents}`),
  },
  /**
   * Services an agent can call, which is a different table and a different
   * idea from `connections` above — see `ToolConnection` for the distinction.
   *
   * `headers` goes up once, on create, and never comes back: the worker
   * encrypts it and 0059 grants the column to nobody. Changing a credential
   * is removing the connection and making it again, which is the honest
   * shape of "the token has been rotated".
   */
  toolConnections: {
    list: (): Promise<ToolConnectionsResponse> => request("GET", "/tool-connections"),
    create: (input: {
      label: string;
      transport: "http" | "sql";
      baseUrl: string;
      headers: Record<string, string>;
      allowedMethods?: string[];
      rpc?: string;
      summary?: string;
      /** Share it with the workspace. Personal when absent. */
      shared?: boolean;
    }): Promise<ToolConnection> => request("POST", "/tool-connections", input),
    update: (
      id: string,
      patch: {
        label?: string;
        allowedMethods?: string[];
        rpc?: string;
        summary?: string;
        shared?: boolean;
      },
    ): Promise<ToolConnection> => request("PATCH", `/tool-connections/${id}`, patch),
    remove: (id: string): Promise<void> => request("DELETE", `/tool-connections/${id}`),
  },
  /**
   * The catalogue, and what an agent may do with what it finds there.
   *
   * `toolkits` is a proxy rather than a direct call: `COMPOSIO_API_KEY` is a
   * deployment secret, so the browser never sees it and the worker does the
   * searching. `connect` answers with a URL rather than redirecting, for the
   * reason `connections.start` does — a `fetch` cannot follow a cross-origin
   * redirect to a consent screen, so a 302 there is a CORS error rather than a
   * login page.
   */
  composio: {
    toolkits: (query: {
      search?: string;
      category?: string;
      cursor?: string;
    }): Promise<ComposioToolkitsResponse> => {
      const params = new URLSearchParams();
      if (query.search) params.set("search", query.search);
      if (query.category) params.set("category", query.category);
      if (query.cursor) params.set("cursor", query.cursor);
      const qs = params.toString();
      return request("GET", `/composio/toolkits${qs ? `?${qs}` : ""}`);
    },
    toolkit: (slug: string): Promise<ComposioToolkitDetailResponse> =>
      request("GET", `/composio/toolkits/${encodeURIComponent(slug)}`),
    categories: (): Promise<ComposioCategoriesResponse> => request("GET", "/composio/categories"),
    connect: (input: {
      toolkit: string;
      label?: string;
    }): Promise<{ url: string; connection: ToolConnection }> =>
      request("POST", "/composio/connect", input),
    status: (id: string): Promise<{ status: "pending" | "active" | "failed" }> =>
      request("GET", `/composio/connections/${id}/status`),
    /**
     * Finish a connection with the nonce Composio sent this browser back with.
     * Only the person who started it can; anybody else's account is revoked.
     */
    complete: (nonce: string): Promise<{ status: string }> =>
      request("POST", "/composio/complete", { nonce }),
    grants: (agentId?: string): Promise<{ grants: ToolConnectionGrant[] }> =>
      request("GET", `/composio/grants${agentId ? `?agentId=${agentId}` : ""}`),
    setGrant: (input: {
      agentId: string;
      connectionId: string;
      slug: string;
      mode: "ask" | "always";
    }): Promise<ToolConnectionGrant> => request("PUT", "/composio/grants", input),
    removeGrant: (input: { agentId: string; connectionId: string; slug: string }): Promise<void> =>
      request(
        "DELETE",
        `/composio/grants?agentId=${input.agentId}&connectionId=${input.connectionId}` +
          `&slug=${encodeURIComponent(input.slug)}`,
      ),
  },
  /**
   * The other road to a database: a Supabase account, and the projects it
   * opens.
   *
   * `connect` answers with the project list as well as the account, so the
   * picker can be shown without a second round trip — pasting a token and
   * choosing what it may be used for is one action from where a person is
   * standing, and it reads as one.
   */
  slack: {
    get: (): Promise<SlackState> => request("GET", "/slack"),
    start: (nonceHash: string): Promise<{ url: string }> =>
      request("POST", "/slack/install/start", { nonceHash }),
    /** Finish an install Slack sent this tab back from. */
    complete: (input: { grant: string; nonce: string }): Promise<{ provider: "slack" }> =>
      request("POST", "/slack/complete", input),
    setAgent: (agentId: string): Promise<{ id: string; agentId: string }> =>
      request("PATCH", "/slack/installation", { agentId }),
    remove: (): Promise<void> => request("DELETE", "/slack/installation"),
  },
  routines: {
    list: (): Promise<Routine[]> => request("GET", "/routines"),
    /**
     * `confirmation` is there when the routine brought a new address with it
     * that is not the caller's own: it has been mailed a link, and nothing is
     * delivered to it until it is opened.
     */
    create: (
      input: CreateRoutineInput,
    ): Promise<Routine & { confirmation?: ConfirmationOutcome }> =>
      request("POST", "/routines", input),
    update: (id: string, patch: UpdateRoutineInput): Promise<Routine> =>
      request("PATCH", `/routines/${id}`, patch),
    remove: (id: string): Promise<void> => request("DELETE", `/routines/${id}`),
    runs: (id: string): Promise<RoutineRun[]> => request("GET", `/routines/${id}/runs`),
    /** Runs it now instead of waiting for the schedule. Resolves when the run ends. */
    run: (
      id: string,
    ): Promise<{ status: "ok" | "skipped" | "failed" | "waiting"; itemsNew: number }> =>
      request("POST", `/routines/${id}/run`),
    draft: (text: string, timezone: string): Promise<RoutineDraft> =>
      request("POST", "/routines/draft", { text, timezone }),
    /** Whether a webhook trigger is wired up, and when it last fired. */
    trigger: (id: string): Promise<RoutineTrigger> => request("GET", `/routines/${id}/trigger`),
    /**
     * Mint an ingest token, or replace the one this routine has. The only
     * response that carries the token; rotating invalidates the old one at once.
     */
    createTrigger: (id: string): Promise<{ token: string; path: string }> =>
      request("POST", `/routines/${id}/trigger`),
    removeTrigger: (id: string): Promise<void> => request("DELETE", `/routines/${id}/trigger`),
  },
  deliveryChannels: {
    list: (): Promise<DeliveryChannel[]> => request("GET", "/delivery-channels"),
    /**
     * The only response that ever carries a webhook's signing secret. Show it
     * once; there is no endpoint that will hand it over again.
     */
    create: (input: {
      kind: DeliveryChannelKind;
      secret: string;
    }): Promise<CreatedDeliveryChannel> => request("POST", "/delivery-channels", input),
    /** A new signing secret for a webhook channel. The destination is unchanged. */
    rotate: (id: string): Promise<{ signingSecret: string }> =>
      request("POST", `/delivery-channels/${id}/rotate`),
    /**
     * One message through the channel, now. 502 carries what the receiver
     * said, which is the whole reason the button is worth having.
     */
    test: (id: string): Promise<void> => request("POST", `/delivery-channels/${id}/test`),
    remove: (id: string): Promise<void> => request("DELETE", `/delivery-channels/${id}`),
  },
  /**
   * An address saying yes to routine results, from the link it was mailed.
   * Needs no session: whoever is at the address may have no account.
   */
  addressConfirmations: {
    confirm: (token: string): Promise<void> => request("POST", "/address-confirmations", { token }),
  },
  usage: (): Promise<UsageResponse> => request("GET", "/usage"),
  /** The active workspace's recent charges and grants. Admins only, by policy. */
  creditLedger: (limit = 50): Promise<{ entries: CreditLedgerEntry[] }> =>
    request("GET", `/usage/credits/ledger?limit=${limit}`),
  workspaceUsage: (): Promise<WorkspaceUsageResponse> => request("GET", "/usage/workspace"),
  coverage: {
    /** Admin only; 403 otherwise. `days` is clamped to 1–365 on both sides. */
    workspace: (days = 30): Promise<CoverageResponse> =>
      request("GET", `/coverage/workspace?days=${days}`),
    /** The workspace's own switch. Admin only; 403 otherwise. */
    setEnabled: (enabled: boolean): Promise<{ ok: true }> =>
      request("PATCH", "/coverage/settings", { enabled }),
    /** The caller's own opt-out — nobody else's, not even an admin's. */
    preference: (): Promise<{ excluded: boolean }> => request("GET", "/coverage/preference"),
    /** Idempotent: setting the same value twice is not an error. */
    setPreference: (excluded: boolean): Promise<{ ok: true }> =>
      request("PUT", "/coverage/preference", { excluded }),
  },
  apiKeys: {
    list: (): Promise<ApiKeyList> => request("GET", "/api-keys"),
    /** The only response that carries the key itself. Nothing can return it again. */
    create: (name: string): Promise<ApiKey & { token: string }> =>
      request("POST", "/api-keys", { name }),
    revoke: (id: string): Promise<{ ok: true }> => request("DELETE", `/api-keys/${id}`),
  },
  /**
   * The v2 takeover — a separate browser rented for a login wall, signed into
   * in a new tab — kept for tasks drained from before 0078 and for anybody
   * part-way through one when the browser panel shipped (ruling R18). A v4
   * task is the panel's, through `browser` below. A takeover with no task is
   * the panel's too: the person's own browser, from `open` (Task 3.1).
   */
  takeovers: {
    /**
     * Mint a live browser for its owner.
     *
     * The `liveUrl` comes back here and nowhere else. browser-use is explicit
     * about what it is — *"Treat the URL as a credential: anyone with it can
     * interact with the active browser"* — so it is never stored, never put
     * in a query cache that outlives the tab, and never logged.
     */
    takeOver: (browserTaskId: string): Promise<Takeover> =>
      request("POST", "/browser/takeovers", { browserTaskId }),
    /**
     * A browser of the person's own, with no task behind it — the browser
     * panel's Open browser (Task 3.1), to sign in ahead of time so the agent's
     * browser later finds them signed in. The same primitive and the same
     * credential as `takeOver`; 409 says a conversation's browser is in use,
     * or one of these is already open.
     */
    open: (): Promise<Takeover> => request("POST", "/browser/takeovers"),
    /** What a reloaded tab asks, so a reload does not lock somebody out of their own browser. */
    current: (): Promise<{ takeover: Takeover | null }> =>
      request("GET", "/browser/takeovers/current"),
    /**
     * Done signing in.
     *
     * Closing is what stops the provider session, and stopping is the only
     * thing that saves the cookie jar — so this is the step that makes the
     * sign-in persist, not a tidy-up. It can take a few seconds.
     */
    close: (id: string): Promise<CloseTakeover> =>
      request("POST", `/browser/takeovers/${id}/close`),
  },
  browser: {
    /**
     * The live view of the browser beside a conversation, minted fresh.
     *
     * The `liveUrl` comes back here and nowhere else. browser-use is explicit
     * about what it is — *"Treat the URL as a credential: anyone with it can
     * interact with the active browser"* — so the panel holds it in component
     * state for the life of the tab: never in a query key or cache, never in
     * storage, never in a log line or an error. A reload loses it, and asking
     * again is the recovery — the route is idempotent for the owner. 409 means
     * there is no browser running yet.
     */
    live: (browserSessionId: string): Promise<{ liveUrl: string; liveState: LiveState }> =>
      request("GET", `/browser/sessions/${browserSessionId}/live`),
    /**
     * The person's hands on the browser.
     *
     * `human` only once the provider has reported the agent's run ended — a
     * cancel is asynchronous and the agent may still be mid-keystroke. Past the
     * server's wait it answers 202 `cancelling`, and asking again is the whole
     * of the follow-up: the route is idempotent.
     */
    takeOver: (browserSessionId: string): Promise<TakeOverResult> =>
      request("POST", `/browser/sessions/${browserSessionId}/take-over`),
    /**
     * Done: the agent continues from where the person left the browser. This
     * is the one free retry, so a 409 says it was already spent, or that there
     * is nothing for the agent to continue.
     *
     * `{ site }` after a save on the sign-in card (R24): the server finds the
     * login saved for that site and sends it with the run. A site, never a
     * password — the binding is resolved on the server. `credentialId` is the
     * id the save returned (R35), so the run binds that login; the server
     * honours it only for a login the caller may use.
     */
    handBack: (
      browserSessionId: string,
      options?: { site?: string; credentialId?: string },
    ): Promise<{ browserTaskId: string }> =>
      request(
        "POST",
        `/browser/sessions/${browserSessionId}/hand-back`,
        options?.site
          ? {
              site: options.site,
              ...(options.credentialId ? { credentialId: options.credentialId } : {}),
            }
          : undefined,
      ),
    /**
     * Close the browser and keep what was done in it. Stopping is what saves
     * the sign-ins — *"always stop the session to persist profile state"* —
     * and it does not cancel a run, which is why the panel only offers it when
     * the agent is not driving.
     */
    stop: (browserSessionId: string): Promise<void> =>
      request("POST", `/browser/sessions/${browserSessionId}/stop`),
    /**
     * Take a task out of the browser's line before its turn (0080). A task
     * that has already started answers 409 — stopping that is the take-over.
     */
    removeWaiting: (browserTaskId: string): Promise<void> =>
      request("POST", `/browser/tasks/${browserTaskId}/cancel`),
    /**
     * The person's browsers that may still be open, for Settings (Task 3.2):
     * where each one is, who has it, and whether its browser is still open —
     * a boolean, never an id. No live URL: this list mints none.
     */
    open: (): Promise<OpenBrowsers> => request("GET", "/browser/sessions"),
    /**
     * Which sites the jar is signed into, which is the whole of what Covan can
     * say about somebody's logins: the cookies themselves are held by the
     * provider and the address of them is readable by no client role at all.
     */
    profile: (): Promise<{ profile: BrowserProfile | null }> => request("GET", "/browser/profile"),
    /**
     * Forget every sign-in, without closing the account.
     *
     * Destructive and not undoable — the jar is deleted at the provider, so the
     * next task behind a login starts from nothing again. Refused while a
     * browser is open, because stopping that browser is what saves the jar.
     */
    forget: (): Promise<{ forgotten: string[] }> => request("DELETE", "/browser/profile"),
    /**
     * Saved logins (0079): a site's username and password, kept for one agent
     * so its browser signs in without asking.
     */
    credentials: {
      /** The caller's own and the shared ones they can see; `agentId` narrows to one agent. */
      list: (agentId?: string): Promise<{ logins: SavedLogin[] }> =>
        request(
          "GET",
          agentId
            ? `/browser/credentials?agentId=${encodeURIComponent(agentId)}`
            : "/browser/credentials",
        ),
      /**
       * Save, or replace one's own. The one request in this client that carries
       * a password: the caller holds it in component state and nowhere else,
       * and nothing here logs a body. Refusals are sentences meant to be shown.
       */
      save: (input: SaveLoginInput): Promise<{ credential: SavedLoginReceipt }> =>
        request("POST", "/browser/credentials", input),
      /** The saver always; a workspace admin for a shared one. 403 otherwise. */
      forget: (id: string): Promise<void> =>
        request("DELETE", `/browser/credentials/${encodeURIComponent(id)}`),
    },
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
  support: {
    /**
     * Asking for more credits. Only the message travels — who is asking,
     * which workspace, and what it has left are read by the API from the
     * caller's own session and tables, never from this body.
     */
    quota: (message: string): Promise<{ ok: true }> =>
      request("POST", "/support/quota", { message }),
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
    /** Gone for good, now. Bundles and documents only — they own the files. */
    forget: (kind: "bundle" | "document", id: string): Promise<{ ok: true }> =>
      request("DELETE", `/trash/${kind}/${id}`),
  },
  knowledge: {
    /** What the caller can see of the workspace's knowledge, counted. */
    usage: (): Promise<{ bundles: number; documents: number; bytes: number; passages: number }> =>
      request("GET", "/knowledge/usage"),
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
   * How many of `promptTokens` Anthropic charged its 1.25x storage premium for
   * — a subset on the same terms and disjoint from `cachedTokens`, so it too is
   * in `estCostUsd` and not in `totalTokens`. Zero on every OpenAI reply, whose
   * cache is free to fill, and on replies stored before migration 0063.
   */
  cacheWriteTokens: number;
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
 * What the active workspace has left. `metered: false` means there is nothing
 * to show — a self-hosted Covan charges nobody, and the interface renders
 * nothing at all for it. `unlimited` is a house workspace on the hosted build:
 * still hosted, with no balance to show.
 */
export type CreditSnapshot =
  | { metered: false }
  | {
      metered: true;
      /** Credits left. May be just below zero after the last operation. */
      balance: number;
      /** Credits ever added. */
      granted: number;
      /** Credits ever spent. */
      spent: number;
      unlimited: boolean;
      /** Replies ever charged, for the "about N replies left" estimate. */
      replies: number;
    };

/** One row of the workspace's credit ledger. Never names who caused it. */
export type CreditLedgerEntry = {
  id: number;
  /** ISO timestamp. */
  at: string;
  kind:
    | "signup_grant"
    | "grant"
    | "completion"
    | "embedding"
    | "transcription"
    | "composio_call"
    | "composio_search"
    | "browser_task";
  model: string | null;
  purpose: string | null;
  /** Positive for a grant, negative for a charge. */
  credits: number;
  balanceAfter: number;
};

export type UsageTotals = {
  messageCount: number;
  promptTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  measuredPromptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estCostUsd: number;
};

export type UsageResponse = {
  agents: AgentUsage[];
  credits: CreditSnapshot;
  totals: UsageTotals;
};

/**
 * One month of the workspace's traffic.
 *
 * `estCostUsd` is optional and that is not a style choice: until `0071` a month
 * could not be priced at all, because `messages` recorded no model and the only
 * available guess was "assume every reply came from whatever its agent is set
 * to today" — across six months, the assumption most likely to be wrong. The
 * column exists now, and the field is absent only against an API or a database
 * that has not caught up. Absent means "not known"; zero would mean "free".
 */
export type UsageMonth = {
  /** First day of the month, ISO. Oldest first, so it draws left to right. */
  month: string;
  messageCount: number;
  totalTokens: number;
  estCostUsd?: number;
  cachedTokens: number;
  cacheWriteTokens: number;
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

/**
 * How answers were grounded, in four buckets.
 *
 * `covered` is the one that means the team had written something *for that
 * question* — a passage cleared the similarity floor. `fallback` means nothing
 * did and whole documents went instead: usually still a good answer, and the
 * signal that nobody has written the thing being asked about. `ungrounded`
 * means nothing grounded it at all, which is a setup problem rather than a
 * coverage one. See `0039` for the column and `0053` for the read.
 *
 * `unrecorded` is the honest footnote on the other three: replies from before
 * the column existed. `answers` excludes them, so it is the denominator.
 */
export type CoverageTotals = {
  answers: number;
  covered: number;
  fallback: number;
  ungrounded: number;
  unrecorded: number;
};

export type CoverageAgent = {
  agentId: string;
  name: string;
  emoji: string | null;
  answers: number;
  covered: number;
  fallback: number;
  ungrounded: number;
};

/**
 * What the team asked that nothing written was close to, for an admin.
 *
 * By agent and by window, never by person and never the question itself — the
 * functions in `0053` do not select a `user_id` and return no content. Listing
 * the questions is a separate feature with a consent step in front of it.
 *
 * `available` is false in exactly one situation: the API is deployed and
 * `0053` has not been applied yet, the same window `WorkspaceUsageResponse`
 * describes.
 */
export type CoverageResponse = {
  available: boolean;
  /** The window these figures cover, in days, after clamping. */
  days: number;
  totals: CoverageTotals;
  agents: CoverageAgent[];
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

/** One section of a document being written. */
export type DocumentSection = { index: number; heading: string; body: string; done: boolean };

/**
 * A document the engine is writing or has written. Mirrors the worker's
 * `DocumentJobDto` (`worker/src/lib/docs/dto.ts`).
 */
export type DocumentJob = {
  id: string;
  agentId: string;
  sessionId: string | null;
  bundleId: string;
  origin: "tool" | "button";
  instruction: string;
  title: string;
  status: "queued" | "writing" | "filing" | "ready" | "failed" | "stopped";
  /** Sections done, of how many. Zero of zero until the outline is in. */
  written: number;
  total: number;
  /** The filed document, once `ready`. */
  documentId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  sections: DocumentSection[];
};

/** One browser task, as the browser panel reads it. Mirrors the worker's `BrowserTaskDTO`. */
export type BrowserTask = {
  id: string;
  task: string;
  /** `waiting`: in the browser's line, not started yet. `queued`: a run the provider took. */
  status: "waiting" | "queued" | "running" | "finished" | "failed" | "stopped";
  output: string | null;
  error: string | null;
  /** Set when a hand-back already produced a second attempt. One retry per original, ever. */
  retryOf: string | null;
  createdAt: number;
  finishedAt: number | null;
  /** `v2` for a task drained from before 0078; `v4` for a run in the browser beside the chat. */
  apiVersion: "v2" | "v4";
  /**
   * Why a run ended before its answer, or null: 'handed_to_person' | 'cost_cap' |
   * 'cancelled', or the run's own 'login_required' | 'blocked'. The panel's
   * sign-in prompt keys on 'login_required' and nothing else.
   */
  stopReason: string | null;
  /** Which browser beside the conversation ran it — Covan's id, never the provider's. */
  browserSessionId: string | null;
  /** The bare host a run said it needed a sign-in on, or null. Shape-checked by 0078. */
  signInHost: string | null;
  /**
   * Whether the run carried a saved login (R32) — so a wall after it is "the
   * saved login didn't work". Answered by the server for walled tasks only.
   */
  carriedSavedLogin: boolean;
  /**
   * A saved login this person may use for `signInHost`, when the run did not
   * carry one: the sign-in card's "Try again with the saved login". Its label
   * and host, never its username. Only on the wall the card shows.
   */
  savedLogin: { id: string; label: string; siteHost: string } | null;
};

/**
 * Who has the controls of the browser beside a conversation.
 *
 * `cancelling` is never stored: it is take-over's 202, the agent's run asked
 * to stop and not yet reported stopped, and the panel stays inert through it.
 */
export type LiveState = "none" | "agent" | "human" | "cancelling";

/** The browser beside a conversation, as the panel draws it. Mirrors `BrowserPanelSession`. */
export type BrowserPanelSession = {
  id: string;
  liveState: LiveState;
  humanSince: number | null;
  /** Whether the provider has reported a browser yet. A boolean, never the provider's id. */
  browserReady: boolean;
};

/** One line of what the agent did, as `lib/browser/live.ts` cuts it. */
export type BrowserEventLine = { ts: string; type: string; text: string };

export type ConversationBrowser = {
  tasks: BrowserTask[];
  session: BrowserPanelSession | null;
  /** The events since the last poll — a delta, not a history. */
  events: BrowserEventLine[];
  /** True when this poll settled a run and put its answer in the conversation. */
  delivered: boolean;
};

/** A takeover (`api.takeovers`): a v2 task's, or the person's own with no task (Task 3.1). */
export type Takeover = {
  id: string;
  /** The task it was opened for; null for a browser the person opened themselves. */
  browserTaskId?: string | null;
  /** A credential. Held in component state for the life of the tab and nowhere else. */
  liveUrl: string | null;
  expiresAt: string;
};

export type CloseTakeover = {
  retriedTaskId: string | null;
  /** The domains the jar now holds cookies for. Not sign-ins: see `BrowserProfile`. */
  cookieDomains: string[];
  message: string;
};

export type TakeOverResult =
  { liveState: "human"; humanSince: number } | { liveState: "cancelling" };

/**
 * Where a browser is, as the caller may see it. A conversation they can no
 * longer open is null, and the screen says something neutral instead.
 */
export type BrowserPlace = {
  conversation: { id: string; title: string | null } | null;
  agent: { id: string; name: string } | null;
};

/** A browser beside a conversation that may still be open. Mirrors `GET /browser/sessions`. */
export type OpenConversationBrowser = BrowserPlace & {
  id: string;
  liveState: "none" | "agent" | "human";
  /** A run of the agent's is queued or going in it. Stop is not offered then (R17). */
  running: boolean;
  /**
   * Whether the stop route would accept a Stop now: no run in flight, and a
   * row the agent had last only ten minutes after its last run (R50, R51).
   */
  stoppable: boolean;
  /** Whether its browser has not been seen stopped. A boolean, never the provider's id. */
  browserOpen: boolean;
  lastUsedAt: string | null;
};

/** The person's open takeover: their own browser (Task 3.1) or a v2 task's. */
export type OpenTakeover = BrowserPlace & {
  id: string;
  /** Opened for a task, whose close runs it again. */
  forTask: boolean;
  openedAt: string;
  expiresAt: string;
};

export type OpenBrowsers = {
  browsers: OpenConversationBrowser[];
  takeover: OpenTakeover | null;
};

export type BrowserProfile = {
  /**
   * The domains the provider holds cookies for — NOT a list of sign-ins. One
   * hand-performed LinkedIn login left seven, five of them ad-tech domains a
   * page dropped while loading. See `browse.ts`'s `jarNote`.
   */
  cookieDomains: string[];
  createdAt: string | null;
  lastUsedAt: string | null;
};

/**
 * A saved login as a screen may show it (`GET /browser/credentials`): its
 * name, its site, who it is for. Never the username or the password — the
 * server has no plaintext to send and grants neither ciphertext to anybody.
 */
export type SavedLogin = {
  id: string;
  agentId: string;
  label: string;
  siteHost: string;
  /** `owner`: only its saver's runs use it. `agent`: everyone using the agent. */
  scope: "owner" | "agent";
  lastUsedAt: string | null;
  createdAt: string;
  /** Whether the caller saved it. */
  own: boolean;
  /** Whether the server would let the caller forget it: their own, or a shared one as admin. */
  canForget: boolean;
};

/** What a save sends. Held only for the length of the request; see `SaveLoginDialog`. */
export type SaveLoginInput = {
  agentId: string;
  scope: "owner" | "agent";
  site: string;
  label: string;
  username: string;
  password: string;
};

/** What a save answers: the saved row's public fields, nothing typed into the dialog. */
export type SavedLoginReceipt = {
  id: string;
  scope: "owner" | "agent";
  siteHost: string;
  label: string;
  /** True when the caller's own login for the site was overwritten in place. */
  replaced: boolean;
};
