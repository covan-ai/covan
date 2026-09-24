/**
 * Row → frontend DTO mappers.
 * Frontend TS types are fixed: camelCase fields, timestamps as epoch-ms.
 */
import { NOTHING_RELEVANT_REASON } from "./routines/executor";

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
  /**
   * Which bundle holds it. Optional because it is absent rather than null when
   * the caller did not fetch it: the three routes that return one document to
   * somebody who just acted on it (upload, move, reindex) already know where it
   * went, while the two that return a list — the explorer's own listing and the
   * agent's document list — are the ones that have to say. A `null` here would
   * claim the document belongs to no bundle, which the schema does not allow.
   */
  bundleId?: string;
  /**
   * The connected source that owns it, or null for a file somebody uploaded.
   *
   * It decides whether the document may be moved: the sync reconciles by
   * `connection_id`, so a synced file can be moved, but its name, its text and
   * its removal stay the source's to decide. Undefined means "not fetched",
   * which is not the same answer as "uploaded by hand".
   */
  connectionId?: string | null;
  /** The page or file at the source, for a synced document. */
  externalUrl?: string | null;
  /**
   * The routine that wrote it, or null for an upload or a synced file.
   *
   * This and `connectionId` are the whole of a document's provenance, and the
   * Knowledge tab derives what it says from the two of them rather than from a
   * `kind` column, a chip or a colour: null and null is a file somebody
   * uploaded, which is the case that needs no explanation at all.
   *
   * Undefined means "not fetched", which is not the same answer as "written by
   * nobody" — the same distinction `connectionId` makes.
   */
  routineId?: string | null;
  /**
   * That routine's name, for the line under the filename.
   *
   * Null while `routineId` is set is a real and expected combination rather
   * than a bug: `routines_select_visible` shares a routine with the workspace
   * only when its owner marked it shared, so a colleague's private routine
   * filing into a shared bundle produces exactly this. The document is theirs
   * to read and the routine is not theirs to see, so the interface says "a
   * routine" and stops there.
   */
  routineName?: string | null;
};

export type AgentDTO = {
  id: string;
  name: string;
  emoji: string | null;
  model: string | null;
  persona: string | null;
  mode: "normal" | "brainstorm";
  /**
   * The two tuning settings (0048). Null is not a missing value — it is the
   * setting, and it means the mode decides, which is what every agent has until
   * somebody moves the dial.
   */
  temperature: number | null;
  reasoningEffort: string | null;
  webSearch: boolean;
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

/**
 * One tool a reply ran, as the transcript shows it.
 *
 * `request` is deliberately here and `resultExcerpt` deliberately is not. A
 * person checking an answer wants to know what the agent asked for — which
 * query, which path — and the result is already in the answer they are
 * reading. Sending both would put the whole of every tool's output into the
 * payload of every transcript load, for a line of interface that shows a
 * chip.
 */
/**
 * A connected service, as every screen sees it — which is to say without its
 * credential, because no client role may select one (0059).
 *
 * `config` is forwarded whole rather than picked apart. It holds the rpc name
 * and the cached description, both of which the settings screen edits, and
 * neither of which anything else has an opinion about.
 */
export type ToolConnectionDTO = {
  id: string;
  label: string;
  transport: "http" | "sql" | "supabase" | "composio";
  baseUrl: string;
  allowedMethods: string[];
  /** What the agent is told this service holds, when anybody has recorded it. */
  summary: string | null;
  /** The read-only function a `sql` connection speaks through. */
  rpc: string | null;
  /**
   * The Supabase account this project borrows its token from, for `supabase`
   * connections and null for the rest. The integrations page groups by it, so
   * a person sees which projects would go if they disconnected the account.
   */
  accountId: string | null;
  /** The Supabase project ref, for a `supabase` connection. */
  projectRef: string | null;
  /**
   * The Composio application this row connects — `gmail`, `linear` — or null.
   *
   * Readable on the wire on purpose (0062): it is how the integrations page
   * labels a card, and how a tool slug is matched to a connection id. The
   * account reference beside it in the table is not here and cannot be — no
   * client role may select it.
   */
  toolkitSlug: string | null;
  /**
   * Whether the connection has finished being made. `pending` while somebody
   * is at a consent screen; every transport but `composio` is born `active`.
   */
  status: "pending" | "active" | "failed";
  createdAt: number;
};

/** The transports this build knows. An unlisted one is not silently an API. */
const TRANSPORTS = ["http", "sql", "supabase", "composio"] as const;

export function mapToolConnection(row: {
  id: string;
  label: string;
  transport: string;
  base_url: string;
  allowed_methods?: unknown;
  config?: unknown;
  account_id?: unknown;
  toolkit_slug?: unknown;
  status?: unknown;
  created_at: string;
}): ToolConnectionDTO {
  const config =
    row.config && typeof row.config === "object" ? (row.config as Record<string, unknown>) : {};
  return {
    id: row.id,
    label: row.label,
    // The fallback stays `http` here, unlike `lib/harness/connections.ts` where
    // it became `unknown`. The two are answering different questions: a tool
    // that mistakes a transport sends a credential to the wrong place, and a
    // card that mistakes one draws the wrong icon.
    transport: (TRANSPORTS as readonly string[]).includes(row.transport)
      ? (row.transport as ToolConnectionDTO["transport"])
      : "http",
    baseUrl: row.base_url,
    allowedMethods: Array.isArray(row.allowed_methods) ? (row.allowed_methods as string[]) : [],
    summary: typeof config.summary === "string" ? config.summary : null,
    rpc: typeof config.rpc === "string" ? config.rpc : null,
    accountId: typeof row.account_id === "string" ? row.account_id : null,
    projectRef: typeof config.ref === "string" ? config.ref : null,
    toolkitSlug: typeof row.toolkit_slug === "string" ? row.toolkit_slug : null,
    status: row.status === "pending" || row.status === "failed" ? row.status : "active",
    createdAt: toEpochMs(row.created_at),
  };
}

/**
 * What one agent may do at one connected service, as the screen sees it.
 *
 * There is no `never` on this type because there is no `never` in the table:
 * the absence of a row is the default, and 0062 makes that default `ask`. So a
 * card renders the operations it has rows for and says "asks first" about
 * everything else — which is true without a row having to exist to say it.
 */
export type ToolConnectionGrantDTO = {
  agentId: string;
  connectionId: string;
  slug: string;
  mode: "ask" | "always";
  grantedBy: string | null;
  grantedAt: number;
};

export function mapToolConnectionGrant(row: Record<string, unknown>): ToolConnectionGrantDTO {
  return {
    agentId: String(row.agent_id ?? ""),
    connectionId: String(row.tool_connection_id ?? ""),
    slug: String(row.slug ?? ""),
    mode: row.mode === "always" ? "always" : "ask",
    grantedBy: typeof row.granted_by === "string" ? row.granted_by : null,
    grantedAt: toEpochMs(String(row.granted_at ?? "")),
  };
}

/**
 * A connected Supabase account, as every screen sees it.
 *
 * `tokenHint` is four characters of a live credential and is here on purpose:
 * it is how an admin tells two tokens apart, and it is the most that can be
 * shown without showing the token. There is no field for the token itself and
 * there is no code path that could add one — no client role may select the
 * column (0061).
 */
export type SupabaseAccountDTO = {
  id: string;
  tokenHint: string;
  connectedBy: string | null;
  createdAt: number;
};

export function mapSupabaseAccount(row: Record<string, unknown>): SupabaseAccountDTO {
  return {
    id: String(row.id),
    tokenHint: String(row.token_hint ?? ""),
    connectedBy: typeof row.connected_by === "string" ? row.connected_by : null,
    createdAt: toEpochMs(String(row.created_at ?? "")),
  };
}

export type MessageStepDTO = {
  index: number;
  tool: string;
  status: "ok" | "failed" | "refused" | "pending";
  request: unknown;
  durationMs: number | null;
};

export type MessageDTO = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  sources?: SourceDTO[];
  sender?: { id: string; name: string | null; avatarUrl: string | null };
  /**
   * Every version of this answer, oldest first, when there is more than one.
   *
   * Absent on a reply nobody has regenerated, which is almost all of them —
   * an empty array and an absent field would mean the same thing to the
   * screen, and the absent one does not travel. Ids only: the screen asks for
   * whichever it wants to show, and shipping five drafts of an answer to draw
   * a `2/3` would be four answers nobody asked to read.
   */
  versions?: string[];
  /**
   * Token usage for assistant replies. Null on user messages and on replies
   * written before 0006. cachedTokens is null on replies written before 0025,
   * cacheWriteTokens on replies written before 0062 — and on every reply from
   * an OpenAI model, whose cache costs nothing to fill.
   */
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedTokens?: number | null;
  cacheWriteTokens?: number | null;
  /**
   * What the reply did before it wrote, when it did anything.
   *
   * Absent on every reply that ran no tool, which is most of them and all of
   * them written before 0060 — an empty array and an absent field would mean
   * the same thing to the screen, and the absent one does not travel.
   */
  steps?: MessageStepDTO[];
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
   * The model ids this deployment can actually serve, in picker order.
   *
   * The frontend used to hold this list itself, which was true for as long as
   * every model came from one provider and one key. It does not survive a
   * second provider: whether the Claude models exist depends on whether
   * `ANTHROPIC_API_KEY` is set, which is a fact about the server. A picker that
   * offered them anyway would store a choice the API then quietly ignores.
   */
  models: string[];
  /**
   * What each of those ids will accept, keyed by id.
   *
   * The same reasoning as `models`, one level down. Whether a temperature can
   * be sent and whether the model thinks before it answers are facts about the
   * model, decided in `lib/models.ts`, and the agent settings screen needs them
   * to know which of its two tuning controls mean anything: the GPT-5 family
   * rejects any temperature but its own with a 400, and nothing but that family
   * has a reasoning effort at all. A frontend holding its own copy of that
   * table would be a second source of truth for something the server already
   * decides — and would be wrong for exactly the ids it had not heard of.
   */
  modelSpecs: Record<string, { temperature: boolean; reasoning: boolean }>;
  /**
   * Estimated USD for one reference reply on each model the picker may offer,
   * so a choice between two names is a choice between two numbers.
   *
   * Server-side for the same reason `modelSpecs` is: the price list lives in
   * `lib/pricing.ts` beside the one the usage screen bills against, and a
   * second copy in the browser bundle would drift from it silently — a stale
   * price is worse than no price, because it is believed.
   *
   * An id with no entry has no price, and that is a real state rather than a
   * gap to paper over: the whole map is empty on a deployment with
   * `OPENAI_MODEL` set, where the picked id is not what answers.
   */
  modelCosts: Record<string, number>;
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
  // The three below are spread rather than mapped when absent, so a caller that
  // did not select them gets a DTO that stays quiet about them. See DocumentDTO.
  bundle_id?: string | null;
  connection_id?: string | null;
  external_url?: string | null;
  routine_id?: string | null;
  /** The embedded `routines(name)`, in either shape PostgREST returns it. */
  routines?: unknown;
}): DocumentDTO {
  const chunkCount = row.document_chunks?.[0]?.count ?? 0;
  const routine = firstEmbedded<{ name?: string | null }>(row.routines);
  return {
    id: row.id,
    name: row.name,
    size: row.size ?? 0,
    createdAt: toEpochMs(row.created_at),
    chunkCount,
    indexed: chunkCount > 0,
    ...(row.bundle_id ? { bundleId: row.bundle_id } : {}),
    ...(row.connection_id !== undefined ? { connectionId: row.connection_id } : {}),
    ...(row.external_url !== undefined ? { externalUrl: row.external_url } : {}),
    ...(row.routine_id !== undefined ? { routineId: row.routine_id } : {}),
    // Only when the id was fetched. A name on its own would be a claim about
    // provenance made by a query that never asked about it.
    ...(row.routine_id !== undefined ? { routineName: routine?.name ?? null } : {}),
  };
}

export function mapAgent(row: {
  id: string;
  name: string;
  emoji: string | null;
  model: string | null;
  persona: string | null;
  mode?: string | null;
  temperature?: number | null;
  reasoning_effort?: string | null;
  web_search?: boolean | null;
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
        bundle_id?: string | null;
        connection_id?: string | null;
        external_url?: string | null;
        routine_id?: string | null;
        routines?: unknown;
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
    temperature: row.temperature ?? null,
    reasoningEffort: row.reasoning_effort ?? null,
    webSearch: row.web_search ?? false,
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
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cached_tokens?: number | null;
  cache_write_tokens?: number | null;
  /** The embedded `message_steps` rows, when the caller asked for them. */
  message_steps?: unknown;
}): MessageDTO {
  const sender = firstEmbedded<{ id: string; name: string | null; avatar_url: string | null }>(
    row.sender,
  );
  const steps = mapSteps(row.message_steps);
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    createdAt: toEpochMs(row.created_at),
    sources: Array.isArray(row.sources) ? row.sources.map(mapSource).filter(isSource) : undefined,
    sender: sender ? { id: sender.id, name: sender.name, avatarUrl: sender.avatar_url } : undefined,
    promptTokens: row.prompt_tokens ?? undefined,
    completionTokens: row.completion_tokens ?? undefined,
    cachedTokens: row.cached_tokens ?? undefined,
    cacheWriteTokens: row.cache_write_tokens ?? undefined,
    ...(steps.length > 0 ? { steps } : {}),
  };
}

/**
 * The steps of one message, sorted and narrowed.
 *
 * PostgREST returns an embedded relation in no promised order, and the order
 * is the whole of what `step_index` is for — a person reads "searched the
 * handbook, then queried the orders database", not the other way round.
 */
function mapSteps(value: unknown): MessageStepDTO[] {
  if (!Array.isArray(value)) return [];
  const out: MessageStepDTO[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const status = String(row.status ?? "");
    if (status !== "ok" && status !== "failed" && status !== "refused" && status !== "pending") {
      continue;
    }
    out.push({
      index: typeof row.step_index === "number" ? row.step_index : 0,
      tool: String(row.tool ?? ""),
      status,
      request: row.request ?? {},
      durationMs: typeof row.duration_ms === "number" ? row.duration_ms : null,
    });
  }
  return out.sort((a, b) => a.index - b.index);
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
  sourceKind: "rss" | "web" | "none" | "connection";
  sourceUrl: string | null;
  /** Set only for `connection`. The connection whose documents it watches. */
  connectionId: string | null;
  instruction: string;
  deliveryChannelId: string;
  scheduleCron: string;
  timezone: string;
  /**
   * What starts this routine. `schedule` for everything made before 0055, and
   * for everything that watches a source — a webhook trigger is only valid on
   * a routine with no source of its own, and 0027 means that can never change
   * after creation.
   */
  triggerKind: "schedule" | "webhook" | "both";
  /**
   * The bundle each delivered summary is filed into, or null to file nothing —
   * which is every routine made before 0056 and the default since.
   */
  outputBundleId: string | null;
  /** How many filed documents this routine keeps. 52 unless somebody changed it. */
  outputRetention: number;
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
  source_config: { url?: string; connectionId?: string } | null;
  instruction: string;
  delivery_channel_id: string;
  schedule_cron: string;
  timezone: string;
  trigger_kind?: string | null;
  output_bundle_id?: string | null;
  output_retention?: number | null;
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
    connectionId: row.source_config?.connectionId ?? null,
    instruction: row.instruction,
    deliveryChannelId: row.delivery_channel_id,
    scheduleCron: row.schedule_cron,
    timezone: row.timezone,
    // Through an explicit list, and defaulting to `schedule` when the column is
    // absent: a row read by a build older than 0055 — or by a query written
    // before this field existed — is a scheduled routine, which is what it was.
    triggerKind:
      row.trigger_kind === "webhook" || row.trigger_kind === "both" ? row.trigger_kind : "schedule",
    outputBundleId: row.output_bundle_id ?? null,
    // 52 rather than 0 when the column is absent, because the DTO has to name
    // the number the database would use: a row read by a query written before
    // 0056 still has the default behind it, and reporting 0 here would put "0
    // kept" in front of somebody whose routine keeps a year of them.
    outputRetention: row.output_retention ?? 52,
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
  /**
   * New entries this run saw and did not deliver, dropped by the per-run cap.
   * Not deferred — they were marked seen, so they are never delivered later.
   * Zero for every run recorded before 0047.
   */
  itemsOverflow: number;
  /**
   * A skipped run that looked at real entries and judged none of them to be
   * what the instruction asked for — as opposed to one that found nothing new.
   * `itemsNew` says how many it read before deciding.
   *
   * Computed here rather than left to the client to match `error` against a
   * string: the constant lives in the executor, and a copy of it in the
   * frontend would be a magic string in a second package, free to drift.
   */
  nothingRelevant: boolean;
  durationMs: number | null;
  error: string | null;
  /** What was delivered. Null for skipped and failed runs, and for any run
   *  recorded before routine_runs.summary existed. */
  summary: string | null;
  /** The document this run filed, if it filed one. */
  documentId: string | null;
  /**
   * Why this run filed nothing when it was supposed to.
   *
   * Null in the two ordinary cases — the routine files nothing, or filing
   * worked — so a note on screen always means something went wrong with the
   * optional half of a run that otherwise succeeded. That is a state worth
   * showing rather than hiding: a person who set up filing and sees no
   * documents has no other way to find out that their cron Worker has no
   * storage bound, or that they were demoted to viewer last month.
   */
  filingNote: string | null;
  startedAt: number;
};

export function mapRoutineRun(row: {
  id: string;
  status: string;
  items_new: number | null;
  items_overflow?: number | null;
  duration_ms: number | null;
  error: string | null;
  summary?: string | null;
  document_id?: string | null;
  filing_note?: string | null;
  started_at: string;
}): RoutineRunDTO {
  return {
    id: row.id,
    status: row.status === "ok" || row.status === "failed" ? row.status : "skipped",
    itemsNew: row.items_new ?? 0,
    itemsOverflow: row.items_overflow ?? 0,
    nothingRelevant: row.status === "skipped" && row.error === NOTHING_RELEVANT_REASON,
    durationMs: row.duration_ms ?? null,
    error: row.error ?? null,
    summary: row.summary ?? null,
    documentId: row.document_id ?? null,
    filingNote: row.filing_note ?? null,
    startedAt: toEpochMs(row.started_at),
  };
}

/** Never carries the secret — `label` is the mask computed at creation time. */
export type DeliveryChannelDTO = {
  id: string;
  kind: "slack_webhook" | "email" | "webhook";
  label: string;
  createdAt: number;
};

/**
 * `kind` is mapped through an explicit list rather than cast.
 *
 * An unknown value falls back to `slack_webhook`, which is what the previous
 * two-kind version of this did by construction. It stays a fallback rather than
 * an error because this is the read path for a list of channels: one row
 * written by a newer deploy must not turn the whole screen into a failure.
 */
const CHANNEL_KINDS: DeliveryChannelDTO["kind"][] = ["slack_webhook", "email", "webhook"];

export function mapDeliveryChannel(row: {
  id: string;
  kind: string;
  label: string;
  created_at: string;
}): DeliveryChannelDTO {
  const kind = CHANNEL_KINDS.find((k) => k === row.kind) ?? "slack_webhook";
  return {
    id: row.id,
    kind,
    label: row.label,
    createdAt: toEpochMs(row.created_at),
  };
}

/**
 * A connected source, as the Integrations page sees it.
 *
 * Never carries the token — `connections.secret_ciphertext` is not selectable
 * by a client at all (0043), so this DTO cannot leak it even by being careless.
 * What it does carry is everything needed to answer "is this working?": when it
 * last ran, when it will next, and the reason if it stopped.
 */
/** Mirrors 0057's CHECK and `PausedCode` in `lib/connections/sync.ts`. */
export type ConnectionPausedCode =
  | "needs_folder"
  | "owner_left"
  | "owner_gone"
  | "grant_revoked"
  | "repeated_failures"
  | "provider_unconfigured"
  | "unknown_provider"
  | "access_narrowed"
  | "restored";

export type ConnectionDTO = {
  id: string;
  provider: "notion" | "google_drive";
  /** The external account: a Notion workspace name, a Google address. */
  accountLabel: string;
  bundleId: string;
  /** Denormalised for display, so the page does not need a second request. */
  bundleName: string | null;
  /**
   * The grant holder: whose OAuth grant this carries, whose allowance its
   * embeddings are charged to, and whose view of the source decides what syncs.
   *
   * Null since 0057, when they closed their Covan account. Deliberately not
   * called the owner — the workspace owns the connection, which is what lets it
   * outlive this field.
   */
  userId: string | null;
  status: "active" | "paused";
  pausedReason: string | null;
  /**
   * Why the engine paused it, or null when a person did.
   *
   * The interface branches on this rather than on the sentence beside it: a
   * revoked grant needs Reconnect, a narrowed one needs somebody to look and
   * then Resume, and repeated failures need neither until the cause is fixed.
   * Matching prose to decide that was the alternative, and it is the kind of
   * thing that works until somebody improves a message.
   */
  pausedCode: ConnectionPausedCode | null;
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

const PAUSED_CODES = new Set<string>([
  "needs_folder",
  "owner_left",
  "owner_gone",
  "grant_revoked",
  "repeated_failures",
  "provider_unconfigured",
  "unknown_provider",
  "access_narrowed",
  "restored",
]);

export function mapConnection(row: {
  id: string;
  provider: string;
  account_label: string;
  bundle_id: string;
  knowledge_bundles?: { name?: string } | null;
  user_id: string | null;
  status: string;
  paused_reason: string | null;
  paused_code?: string | null;
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
    userId: row.user_id ?? null,
    status: row.status === "paused" ? "paused" : "active",
    pausedReason: row.paused_reason,
    // Through an explicit list rather than a cast, and defaulting to null: a
    // row read by a build older than 0057 — or by a query that did not select
    // the column — is a pause with no code, which is what a person pausing it
    // looks like and is the one reading that offers no wrong action.
    pausedCode: PAUSED_CODES.has(row.paused_code ?? "")
      ? (row.paused_code as ConnectionPausedCode)
      : null,
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
