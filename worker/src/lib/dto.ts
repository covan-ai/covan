/**
 * Row → frontend DTO mappers.
 * Frontend TS types are fixed: camelCase fields, timestamps as epoch-ms.
 */

export type DocumentDTO = {
  id: string;
  name: string;
  size: number;
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

export type MessageDTO = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  sources?: string[];
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

export type PendingInvitationDTO = { id: string; email: string; role: string; createdAt: number };

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
  document_chunks?: Array<{ count: number }> | null;
}): DocumentDTO {
  const chunkCount = row.document_chunks?.[0]?.count ?? 0;
  return {
    id: row.id,
    name: row.name,
    size: row.size ?? 0,
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
    sources: Array.isArray(row.sources)
      ? row.sources.filter((s): s is string => typeof s === "string")
      : undefined,
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
