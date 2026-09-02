/**
 * Row → frontend DTO mappers.
 * Frontend TS types are fixed: camelCase fields, timestamps as epoch-ms.
 */

export type DocumentDTO = {
  id: string;
  name: string;
  size: number;
  /**
   * When it was uploaded — and, for a document, the whole of what "how fresh is
   * this" can mean. Nothing updates a document in place: a re-upload creates a
   * new row, and `POST /documents/:id/reindex` re-embeds the same stored text.
   * So there is no `updated_at` to want, and this date is not a proxy for
   * freshness, it is freshness. An onboarding file uploaded in January is
   * exactly the January file in September, which is why the chat screen puts
   * this under an answer.
   */
  createdAt: number;
  // How many embedded chunks back this document. `indexed` is false when the
  // count is 0 — the document exists but isn't retrievable yet (embedding
  // pending or failed), which the UI surfaces with a reindex action.
  chunkCount: number;
  indexed: boolean;
};

export type AgentDTO = {
  id: string;
  name: string;
  emoji: string | null;
  model: string | null;
  persona: string | null;
  mode: "normal" | "brainstorm";
  documents: DocumentDTO[];
  bundleIds: string[];
  createdAt: number;
};

/**
 * One document that grounded an answer.
 *
 * `id` is null for every reply written before the id was stored. The column
 * held bare display names until then — which is not a link: two documents can
 * share a name, a rename detaches the history, and a delete leaves a string
 * pointing at nothing. `match_chunks` has returned `document_id` since 0005 and
 * `routes/chat.ts` was throwing it away.
 *
 * Old rows keep working and simply cannot say how old their sources are, which
 * is the honest answer rather than a guess made by matching on a name.
 */
export type SourceDTO = { id: string | null; name: string };

export type MessageDTO = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  sources?: SourceDTO[];
  sender?: { id: string; name: string | null; avatarUrl: string | null };
};

export type ChatSessionDTO = {
  id: string;
  agentId: string;
  title: string | null;
  visibility: "private" | "shared";
  kind: "chat" | "brainstorm";
  ownerId: string;
  messages: MessageDTO[];
  messageCount: number;
  updatedAt: number;
};

export type WorkspaceSummaryDTO = { id: string; name: string; slug: string; role: string };

export type PendingInvitationDTO = {
  id: string;
  email: string;
  role: string;
  createdAt: number;
  /**
   * Whether an email actually reached the invitee. Present on the row returned
   * when an invitation is created, and absent from the pending list — nothing
   * stores it, and an old invitation cannot be asked after the fact. The
   * invite dialog uses it to describe what happened instead of assuming.
   */
  emailed?: boolean;
};

export type ApiKeyDTO = {
  id: string;
  name: string;
  /** The visible head of the key, so a row can be told from its neighbours. */
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  /**
   * The key itself, present exactly once: on the row returned when it is
   * created. Nothing stores it, so no later request can put it back.
   */
  token?: string;
};

export type IncomingInvitationDTO = {
  id: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
  createdAt: number;
};

export type MeDTO = {
  user: { id: string; name: string | null; email: string | null; avatarUrl: string | null };
  workspace: {
    id: string;
    name: string;
    slug: string;
    /** Model new agents start on. `null` means the interface picks. */
    defaultModel: string | null;
  };
  members: Array<{
    id: string;
    name: string | null;
    email: string | null;
    role: string;
    avatarUrl: string | null;
  }>;
  /**
   * Where this account stands with its first run. The `_authed` layout gates on
   * `completed`, which is why this rides along with /me rather than having an
   * endpoint of its own — every page load needs the answer, and this response
   * was already being fetched. The answers come too, so someone who closed the
   * browser mid-survey resumes on the question they stopped at instead of
   * starting over.
   */
  onboarding: {
    completed: boolean;
    answers: {
      role: string | null;
      useCase: string | null;
      teamSize: string | null;
      referralSource: string | null;
    };
  };
};

export function toEpochMs(value: string): number {
  return new Date(value).getTime();
}

export function mapDocument(row: {
  id: string;
  name: string;
  size: number | null;
  // Required, not optional: every caller has to fetch it, and a `?? 0` fallback
  // would render a missing date as 1970 — "55 years ago" under an answer, which
  // is worse than the bare filename this replaces.
  created_at: string;
  document_chunks?: Array<{ count: number }> | null;
}): DocumentDTO {
  const chunkCount = row.document_chunks?.[0]?.count ?? 0;
  return {
    id: row.id,
    name: row.name,
    size: row.size ?? 0,
    createdAt: toEpochMs(row.created_at),
    chunkCount,
    indexed: chunkCount > 0,
  };
}

export function mapAgent(row: {
  id: string;
  name: string;
  emoji: string | null;
  model: string | null;
  persona: string | null;
  mode?: string | null;
  created_at: string;
  agent_bundles?: Array<{
    bundle_id: string;
    knowledge_bundles?: {
      documents?: Array<{
        id: string;
        name: string;
        size: number | null;
        created_at: string;
        document_chunks?: Array<{ count: number }> | null;
      }> | null;
    } | null;
  }> | null;
}): AgentDTO {
  const agentBundles = row.agent_bundles ?? [];
  return {
    id: row.id,
    name: row.name,
    emoji: row.emoji,
    model: row.model,
    persona: row.persona,
    mode: row.mode === "brainstorm" ? "brainstorm" : "normal",
    documents: agentBundles.flatMap((ab) => ab.knowledge_bundles?.documents ?? []).map(mapDocument),
    bundleIds: agentBundles.map((ab) => ab.bundle_id),
    createdAt: toEpochMs(row.created_at),
  };
}

// PostgREST embeds a to-one relation as an object, but returns [] when nothing
// matched and null when the FK is null. Normalize all three to a single row.
function firstEmbedded<T>(value: unknown): T | null {
  if (Array.isArray(value)) return (value[0] as T) ?? null;
  if (value && typeof value === "object") return value as T;
  return null;
}

/**
 * Reads either shape out of `messages.sources`, which is jsonb and therefore
 * holds both: bare strings from before ids were stored, `{id, name}` since.
 */
function mapSource(value: unknown): SourceDTO | null {
  if (typeof value === "string") return value ? { id: null, name: value } : null;
  if (value && typeof value === "object") {
    const row = value as { id?: unknown; name?: unknown };
    if (typeof row.name === "string" && row.name) {
      return { id: typeof row.id === "string" ? row.id : null, name: row.name };
    }
  }
  return null;
}

const isSource = (s: SourceDTO | null): s is SourceDTO => s !== null;

export function mapMessage(row: {
  id: string;
  role: string;
  content: string;
  created_at: string;
  sources?: unknown;
  sender_id?: string | null;
  sender?: unknown;
}): MessageDTO {
  const sender = firstEmbedded<{ id: string; name: string | null; avatar_url: string | null }>(
    row.sender,
  );
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    createdAt: toEpochMs(row.created_at),
    sources: Array.isArray(row.sources) ? row.sources.map(mapSource).filter(isSource) : undefined,
    sender: sender ? { id: sender.id, name: sender.name, avatarUrl: sender.avatar_url } : undefined,
  };
}

export function mapChatSession(
  row: {
    id: string;
    agent_id: string;
    user_id: string;
    title: string | null;
    visibility?: string | null;
    kind?: string | null;
    updated_at: string;
    messages?: Array<{ count: number }> | null;
  },
  messages: MessageDTO[] = [],
): ChatSessionDTO {
  return {
    id: row.id,
    agentId: row.agent_id,
    title: row.title,
    visibility: row.visibility === "shared" ? "shared" : "private",
    kind: row.kind === "brainstorm" ? "brainstorm" : "chat",
    ownerId: row.user_id,
    messages,
    messageCount: Array.isArray(row.messages) ? (row.messages[0]?.count ?? 0) : 0,
    updatedAt: toEpochMs(row.updated_at),
  };
}

export type BundleDTO = {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  createdAt: number;
};

export function mapBundle(row: {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  documents?: Array<{ count: number }> | null;
}): BundleDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    documentCount: Array.isArray(row.documents) ? (row.documents[0]?.count ?? 0) : 0,
    createdAt: toEpochMs(row.created_at),
  };
}

export type IdeaStage = "review" | "promising" | "in_progress" | "parked";

const IDEA_STAGES: IdeaStage[] = ["review", "promising", "in_progress", "parked"];

export type IdeaDTO = {
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

export function mapIdea(row: {
  id: string;
  session_id: string;
  title: string;
  detail: string | null;
  stage: string;
  position: number | null;
  created_by: string | null;
  source_message_id: string | null;
  created_at: string;
}): IdeaDTO {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    detail: row.detail,
    stage: IDEA_STAGES.includes(row.stage as IdeaStage) ? (row.stage as IdeaStage) : "review",
    position: row.position ?? 0,
    createdBy: row.created_by,
    sourceMessageId: row.source_message_id,
    createdAt: toEpochMs(row.created_at),
  };
}

export type RoutineDTO = {
  id: string;
  agentId: string;
  /** The owner. The client needs this to separate team routines from its own. */
  userId: string;
  name: string;
  visibility: "private" | "shared";
  sourceKind: "rss" | "web" | "none";
  sourceUrl: string | null;
  instruction: string;
  deliveryChannelId: string;
  scheduleCron: string;
  timezone: string;
  status: "active" | "paused";
  pausedReason: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
};

export function mapRoutine(row: {
  id: string;
  agent_id: string;
  user_id: string;
  name: string;
  visibility: string;
  source_kind: string;
  source_config: { url?: string } | null;
  instruction: string;
  delivery_channel_id: string;
  schedule_cron: string;
  timezone: string;
  status: string;
  paused_reason: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
}): RoutineDTO {
  return {
    id: row.id,
    agentId: row.agent_id,
    userId: row.user_id,
    name: row.name,
    visibility: row.visibility === "shared" ? "shared" : "private",
    sourceKind: row.source_kind as RoutineDTO["sourceKind"],
    sourceUrl: row.source_config?.url ?? null,
    instruction: row.instruction,
    deliveryChannelId: row.delivery_channel_id,
    scheduleCron: row.schedule_cron,
    timezone: row.timezone,
    status: row.status === "paused" ? "paused" : "active",
    pausedReason: row.paused_reason ?? null,
    nextRunAt: row.next_run_at ? toEpochMs(row.next_run_at) : null,
    lastRunAt: row.last_run_at ? toEpochMs(row.last_run_at) : null,
    createdAt: toEpochMs(row.created_at),
  };
}

export type RoutineRunDTO = {
  id: string;
  status: "ok" | "skipped" | "failed";
  itemsNew: number;
  durationMs: number | null;
  error: string | null;
  /** What was delivered. Null for skipped and failed runs, and for any run
   *  recorded before routine_runs.summary existed. */
  summary: string | null;
  startedAt: number;
};

export function mapRoutineRun(row: {
  id: string;
  status: string;
  items_new: number | null;
  duration_ms: number | null;
  error: string | null;
  summary?: string | null;
  started_at: string;
}): RoutineRunDTO {
  return {
    id: row.id,
    status: row.status === "ok" || row.status === "failed" ? row.status : "skipped",
    itemsNew: row.items_new ?? 0,
    durationMs: row.duration_ms ?? null,
    error: row.error ?? null,
    summary: row.summary ?? null,
    startedAt: toEpochMs(row.started_at),
  };
}

/** Never carries the secret — `label` is the mask computed at creation time. */
export type DeliveryChannelDTO = {
  id: string;
  kind: "slack_webhook" | "email";
  label: string;
  createdAt: number;
};

export function mapDeliveryChannel(row: {
  id: string;
  kind: string;
  label: string;
  created_at: string;
}): DeliveryChannelDTO {
  return {
    id: row.id,
    kind: row.kind === "email" ? "email" : "slack_webhook",
    label: row.label,
    createdAt: toEpochMs(row.created_at),
  };
}

/**
 * A connected source, as the Integrations page sees it.
 *
 * Never carries the token — `connections.secret_ciphertext` is not selectable
 * by a client at all (0039), so this DTO cannot leak it even by being careless.
 * What it does carry is everything needed to answer "is this working?": when it
 * last ran, when it will next, and the reason if it stopped.
 */
export type ConnectionDTO = {
  id: string;
  provider: "notion" | "google_drive";
  /** The external account: a Notion workspace name, a Google address. */
  accountLabel: string;
  bundleId: string;
  /** Denormalised for display, so the page does not need a second request. */
  bundleName: string | null;
  userId: string;
  status: "active" | "paused";
  pausedReason: string | null;
  /**
   * Whether this connection still needs setting up before it can sync. True
   * only for a Drive connection with no folder chosen — the state between the
   * OAuth grant and the folder picker, which is a step rather than a fault and
   * so is not `pausedReason`.
   */
  needsFolder: boolean;
  /** The chosen Drive folder, when there is one. */
  folderName: string | null;
  syncIntervalMinutes: number;
  nextSyncAt: number | null;
  lastSyncAt: number | null;
  documentCount: number;
  createdAt: number;
};

export function mapConnection(row: {
  id: string;
  provider: string;
  account_label: string;
  bundle_id: string;
  knowledge_bundles?: { name?: string } | null;
  user_id: string;
  status: string;
  paused_reason: string | null;
  config: Record<string, unknown> | null;
  sync_interval_minutes: number;
  next_sync_at: string | null;
  last_sync_at: string | null;
  documents?: Array<{ count: number }> | null;
  created_at: string;
}): ConnectionDTO {
  const provider = row.provider === "notion" ? "notion" : "google_drive";
  const folderId = typeof row.config?.folderId === "string" ? row.config.folderId : null;
  const folderName = typeof row.config?.folderName === "string" ? row.config.folderName : null;
  return {
    id: row.id,
    provider,
    accountLabel: row.account_label,
    bundleId: row.bundle_id,
    bundleName: row.knowledge_bundles?.name ?? null,
    userId: row.user_id,
    status: row.status === "paused" ? "paused" : "active",
    pausedReason: row.paused_reason,
    needsFolder: provider === "google_drive" && !folderId,
    folderName,
    syncIntervalMinutes: row.sync_interval_minutes,
    nextSyncAt: row.next_sync_at ? toEpochMs(row.next_sync_at) : null,
    lastSyncAt: row.last_sync_at ? toEpochMs(row.last_sync_at) : null,
    documentCount: row.documents?.[0]?.count ?? 0,
    createdAt: toEpochMs(row.created_at),
  };
}

/** One sync, in the terms the person who set it up would use. */
export type ConnectionRunDTO = {
  id: string;
  /** `skipped` means "looked, nothing had changed" — it is not a failure. */
  status: "ok" | "skipped" | "failed";
  added: number;
  updated: number;
  removed: number;
  error: string | null;
  durationMs: number | null;
  startedAt: number;
};

export function mapConnectionRun(row: {
  id: string;
  status: string;
  documents_added: number;
  documents_updated: number;
  documents_removed: number;
  error: string | null;
  duration_ms: number | null;
  started_at: string;
}): ConnectionRunDTO {
  return {
    id: row.id,
    status: row.status as ConnectionRunDTO["status"],
    added: row.documents_added,
    updated: row.documents_updated,
    removed: row.documents_removed,
    error: row.error,
    durationMs: row.duration_ms,
    startedAt: toEpochMs(row.started_at),
  };
}
