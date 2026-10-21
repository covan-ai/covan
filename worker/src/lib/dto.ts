/**
 * Row → frontend DTO mappers.
 * Frontend TS types are fixed: camelCase fields, timestamps as epoch-ms.
 */
import { NOTHING_RELEVANT_REASON } from "./routines/executor";
import { allowedLogoUrl } from "./composio/client";
import { REASONING_EFFORTS, type ReasoningEffort } from "./models";
import { hiddenOperations } from "./harness/connections";
import { MESSAGE_OUTCOMES, type MessageOutcome } from "./harness/usage";
import { CATALOGUE } from "./routines/events/catalog";

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
  /**
   * Where its indexing has got (0105): `queued` and `indexing` while the job
   * runs, `ready`, `partial` when the text was cut at the indexing limit, or
   * `failed` with `indexError` saying why. Null for a document indexed before
   * jobs existed, which `indexed` describes as it always did. Undefined when
   * not fetched.
   */
  indexStatus?: IndexStatus | null;
  /** Passages embedded so far, and how many there will be, while it runs. */
  indexProgress?: { done: number; total: number } | null;
  indexError?: string | null;
};

export type IndexStatus = "queued" | "indexing" | "ready" | "partial" | "failed";

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
  /**
   * Who reaches this agent, and how far (0104). `workspaceAccess` is what
   * every member gets, null when it is not shared with the workspace; `shares`
   * are the people named on top of that. `myAccess` is the caller's own
   * level, read from the same function the policies ask, so the screen never
   * offers a control the database would refuse.
   */
  createdBy: string | null;
  workspaceAccess: AgentAccess | null;
  myAccess: AgentAccess;
  shares: AgentShareDTO[];
};

export const AGENT_ACCESS = ["use", "edit", "manage"] as const;
export type AgentAccess = (typeof AGENT_ACCESS)[number];
export type AgentShareDTO = { userId: string; access: AgentAccess };

function asAccess(value: unknown): AgentAccess | null {
  return typeof value === "string" && (AGENT_ACCESS as readonly string[]).includes(value)
    ? (value as AgentAccess)
    : null;
}

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
  transport: "http" | "sql" | "composio";
  baseUrl: string;
  allowedMethods: string[];
  /** What the agent is told this service holds, when anybody has recorded it. */
  summary: string | null;
  /** The read-only function a `sql` connection speaks through. */
  rpc: string | null;
  /**
   * The Composio application this row connects — `gmail`, `linear` — or null.
   *
   * Readable on the wire on purpose (0063): it is how the integrations page
   * labels a card, and how a tool slug is matched to a connection id. The
   * account reference beside it in the table is not here and cannot be — no
   * client role may select it.
   */
  toolkitSlug: string | null;
  /**
   * The application's mark, as a path on this API — never a third-party URL.
   * Empty for every transport but `composio`, and for a connection made
   * before the catalogue started recording one.
   */
  logoPath: string;
  /**
   * Whether the connection has finished being made. `pending` while somebody
   * is at a consent screen; every transport but `composio` is born `active`.
   */
  status: "pending" | "active" | "failed";
  /**
   * `owner`: only the person who connected it, and only their turns, can use
   * it. `workspace`: shared with every member (0098).
   */
  scope: "owner" | "workspace";
  /** Whether the caller connected it — the one person who may share it or take it back. */
  mine: boolean;
  /**
   * When the credential was last checked against the provider and worked
   * (epoch ms), or null — never checked, or the check could not be made.
   */
  verifiedAt: number | null;
  /**
   * The provider's refusal of this connection's credential, when it refused
   * (0072, covan#258). A warning: the connection stays `active`.
   */
  verifyError: string | null;
  /**
   * Operations this connection has already been refused and that the agent is
   * therefore not shown, and when the oldest of them is tried again (epoch
   * ms). Null when nothing is hidden.
   *
   * The card's rule is "say connected, never working" (0072), and this is the
   * case where the database already knows better: an app whose one useful
   * operation answered 404 stays hidden for thirty days, and until covan#276
   * no screen said so. A count rather than a verdict, because seven dead slugs
   * on GitHub is a usable connection and one on `browser_tool` is not, and
   * telling those apart needs the catalogue.
   */
  unavailable: { count: number; hiddenUntil: number | null } | null;
  createdAt: number;
};

/** The transports this build knows. An unlisted one is not silently an API. */
const TRANSPORTS = ["http", "sql", "composio"] as const;

/** A connected application's mark, as a path on this API. "" when it has none. */
function logoPathOf(stored: unknown): string {
  if (typeof stored !== "string") return "";
  const url = allowedLogoUrl(stored);
  return url ? `/composio/logo?u=${encodeURIComponent(url.toString())}` : "";
}

export function mapToolConnection(
  row: {
    id: string;
    label: string;
    transport: string;
    base_url: string;
    allowed_methods?: unknown;
    config?: unknown;
    toolkit_slug?: unknown;
    status?: unknown;
    scope?: unknown;
    created_by?: unknown;
    created_at: string;
    verified_at?: unknown;
    verify_error?: unknown;
  },
  callerId: string,
): ToolConnectionDTO {
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
    toolkitSlug: typeof row.toolkit_slug === "string" ? row.toolkit_slug : null,
    // Validated again on the way out, not only on the way in. The column is a
    // jsonb a service-role write put there, and a path this API hands a
    // browser to load an image from is worth checking twice — the cost is a
    // `new URL` and the alternative is trusting a row to be well-formed
    // because it was well-formed when it was written.
    logoPath: logoPathOf(config.logo),
    status: row.status === "pending" || row.status === "failed" ? row.status : "active",
    scope: row.scope === "workspace" ? "workspace" : "owner",
    mine: typeof row.created_by === "string" && row.created_by === callerId,
    unavailable: hiddenOperations(config),
    createdAt: toEpochMs(row.created_at),
    verifiedAt: typeof row.verified_at === "string" ? toEpochMs(row.verified_at) : null,
    verifyError:
      typeof row.verify_error === "string" && row.verify_error.trim() ? row.verify_error : null,
  };
}

/**
 * What one agent may do at one connected service, as the screen sees it.
 *
 * There is no `never` on this type because there is no `never` in the table:
 * the absence of a row is the default, and 0063 makes that default `ask`. So a
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

export type MessageStepDTO = {
  index: number;
  tool: string;
  status: "ok" | "failed" | "refused" | "pending";
  request: unknown;
  durationMs: number | null;
  /**
   * The first part of what the tool returned, or null for a step recorded
   * before 0060 and for one that has not returned yet.
   *
   * The worker trims this on the way in (`MAX_STEP_EXCERPT_CHARS`, 2,000) and
   * 0060's own header says why: so that it can be read on every transcript
   * load without the whole of a tool's output travelling with it. It was
   * trimmed for that purpose and then never sent, which is the narrowest
   * possible version of a screen saying less than it knows.
   *
   * Null rather than "" when there is none. The two are different answers to
   * the screen: one draws no Returned block at all, the other draws an empty
   * one.
   */
  resultExcerpt: string | null;
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
   * cacheWriteTokens on replies written before 0063 — and on every reply from
   * an OpenAI model, whose cache costs nothing to fill.
   */
  promptTokens?: number | null;
  completionTokens?: number | null;
  cachedTokens?: number | null;
  cacheWriteTokens?: number | null;
  /**
   * How much of `completionTokens` the model spent thinking rather than
   * answering.
   *
   * Null on every Anthropic reply for good rather than pending: thinking is
   * billed inside `output_tokens` and reported with no separate count, so a
   * zero here would be a claim the API never made. See `lib/completion.ts`.
   */
  reasoningTokens?: number | null;
  /**
   * Which model answered, as recorded on the reply by `0065`.
   *
   * Absent on the 361 rows written before the column existed, and on every
   * user message. Not the same question as the agent's `model`, which is what
   * will answer NEXT — that difference is what covan#208 is about.
   */
  model?: string;
  /**
   * How the turn ended, when it ended in any way worth naming.
   *
   * `answered` is the ordinary case. The others say a turn stopped: `tokens`
   * and `budget` are our own ceilings, `runtime` is the platform's, `paused`
   * is waiting on a person, and `cut_short` is a turn that did work and never
   * spoke. Absent before `0065`.
   */
  outcome?: string;
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
  /**
   * The dial this conversation turned for itself (0099). Each is null when
   * nobody did, and null means the agent's own setting answers — not "off".
   * `lib/session-mode.ts` is where a value and the agent's combine.
   */
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  webSearch: boolean | null;
  mode: "normal" | "brainstorm" | null;
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
  /**
   * The link with the token in it (0090). Only on the response that minted
   * it — creating or resending — because the database keeps a hash and
   * nothing can show it again. With no mail configured, passing this on is
   * the only way the invitee receives it.
   */
  inviteUrl?: string;
  /**
   * The link has run out, or the invitation predates links altogether.
   * Accepting needs a new one: `POST /invitations/:id/resend`.
   */
  needsResend: boolean;
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
  /** The inviter's display name, or null when their profile has none. */
  inviterName: string | null;
  role: string;
  createdAt: number;
};

/**
 * The caller's own profile, as `PATCH /me` and the avatar routes return it.
 *
 * `avatarUrl` is either an absolute URL a sign-in provider handed over, or a
 * path on this API (`/avatars/<user>/<file>`) for a photo uploaded here; the
 * client resolves the second against the API's origin. `locale` and `timezone`
 * are null for "follow the browser", which is what everybody had before they
 * could be set.
 */
export type ProfileDTO = {
  id: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  bio: string | null;
  locale: string | null;
  timezone: string | null;
};

/** The columns `mapProfile` reads, for every route that returns a ProfileDTO. */
export const PROFILE_COLUMNS = "id, name, email, avatar_url, bio, locale, timezone";

export type ProfileRow = {
  id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  bio?: string | null;
  locale?: string | null;
  timezone?: string | null;
};

/**
 * One profile row as the client sees it.
 *
 * The email comes from the verified token first, as it always has: the row's
 * copy is a mirror the trigger in 0082 keeps, and the token is what GoTrue says
 * right now. The three newer fields default to null so a row read before 0082
 * is applied still has every key the client expects.
 */
export function mapProfile(row: ProfileRow, tokenEmail?: string | null): ProfileDTO {
  return {
    id: row.id,
    name: row.name ?? null,
    email: tokenEmail ?? row.email ?? null,
    avatarUrl: row.avatar_url ?? null,
    bio: row.bio ?? null,
    locale: row.locale ?? null,
    timezone: row.timezone ?? null,
  };
}

export type MeDTO = {
  user: ProfileDTO;
  workspace: {
    id: string;
    name: string;
    slug: string;
    /** Model new agents start on. `null` means the interface picks. */
    defaultModel: string | null;
    /** Whether this workspace has turned the coverage gap report on. */
    gapReportEnabled: boolean;
  };
  members: Array<{
    id: string;
    name: string | null;
    email: string | null;
    role: string;
    avatarUrl: string | null;
    bio: string | null;
    /**
     * A co-member's zone, so the list can say what time it is for them. Their
     * `locale` is deliberately absent: it is a display preference for the
     * person themselves, not something about them the team needs.
     */
    timezone: string | null;
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
   * to know which of its controls mean anything: the GPT-5 family rejects any
   * temperature but its own with a 400, only some models have a reasoning
   * effort at all, and only the Claude models have a web search tool — the
   * flag is accepted on the others and changes nothing. A frontend holding its own copy of that
   * table would be a second source of truth for something the server already
   * decides — and would be wrong for exactly the ids it had not heard of.
   */
  modelSpecs: Record<string, { temperature: boolean; reasoning: boolean; webSearch: boolean }>;
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
  onboarding: OnboardingDTO;
};

/**
 * The columns `/me` and `/onboarding` both read. One string, so the two
 * cannot drift: before 0119 `/me` mapped the row by hand and `/onboarding`
 * had its own copy, and a column added to one was a column the other never
 * served.
 */
export const ONBOARDING_COLUMNS =
  "completed_at, role, use_case, team_size, referral_source, assistant_name, assistant_emoji, assistant_role, tools, purpose, mode, last_step, agent_id, session_id";

export type OnboardingRow = {
  completed_at: string | null;
  role: string | null;
  use_case: string | null;
  team_size: string | null;
  referral_source: string | null;
  assistant_name: string | null;
  assistant_emoji: string | null;
  assistant_role: string | null;
  tools: string[] | null;
  purpose: string | null;
  mode: string | null;
  last_step: string | null;
  agent_id: string | null;
  session_id: string | null;
};

/**
 * Where an account stands with its first run.
 *
 * `lastStep` is the screen that was open, so a reload resumes there rather
 * than at the first unanswered question. `agentId` and `sessionId` are what
 * the finish made (0119), and are null until it has. The four survey answers
 * at the top of `answers` are the old run's; they stay readable because the
 * rows that carry them are still here.
 *
 * `tools` is `null` when the question has not been reached and `[]` when it
 * was skipped. The difference is what lets a resume tell "not yet" from "no".
 */
export type OnboardingDTO = {
  completed: boolean;
  lastStep: string | null;
  agentId: string | null;
  sessionId: string | null;
  answers: {
    role: string | null;
    useCase: string | null;
    teamSize: string | null;
    referralSource: string | null;
    assistantName: string | null;
    assistantEmoji: string | null;
    assistantRole: string | null;
    tools: string[] | null;
    purpose: string | null;
    mode: string | null;
  };
};

/** No row is the normal state of a new account, not an error: nothing answered, nothing finished. */
export function mapOnboarding(row: OnboardingRow | null | undefined): OnboardingDTO {
  return {
    completed: Boolean(row?.completed_at),
    lastStep: row?.last_step ?? null,
    agentId: row?.agent_id ?? null,
    sessionId: row?.session_id ?? null,
    answers: {
      role: row?.role ?? null,
      useCase: row?.use_case ?? null,
      teamSize: row?.team_size ?? null,
      referralSource: row?.referral_source ?? null,
      assistantName: row?.assistant_name ?? null,
      assistantEmoji: row?.assistant_emoji ?? null,
      assistantRole: row?.assistant_role ?? null,
      tools: row?.tools ?? null,
      purpose: row?.purpose ?? null,
      mode: row?.mode ?? null,
    },
  };
}

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
  index_status?: string | null;
  index_cursor?: number | null;
  index_total?: number | null;
  index_error?: string | null;
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
    ...(row.index_status !== undefined
      ? {
          indexStatus: (row.index_status as IndexStatus | null) ?? null,
          indexProgress:
            row.index_status === "indexing" && row.index_total
              ? { done: row.index_cursor ?? 0, total: row.index_total }
              : null,
          indexError: row.index_status === "failed" ? (row.index_error ?? null) : null,
        }
      : {}),
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
  created_by?: string | null;
  workspace_access?: string | null;
  my_access?: string | null;
  agent_shares?: Array<{ user_id: string; access: string }> | null;
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
        index_status?: string | null;
        index_cursor?: number | null;
        index_total?: number | null;
        index_error?: string | null;
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
    createdBy: row.created_by ?? null,
    workspaceAccess: asAccess(row.workspace_access),
    // A row the caller could read is at least usable; "use" is the floor
    // rather than a guess, and never offers a control the policies would refuse.
    myAccess: asAccess(row.my_access) ?? "use",
    shares: (row.agent_shares ?? []).flatMap((s) => {
      const access = asAccess(s.access);
      return access ? [{ userId: s.user_id, access }] : [];
    }),
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
  reasoning_tokens?: number | null;
  model?: string | null;
  outcome?: string | null;
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
    reasoningTokens: row.reasoning_tokens ?? undefined,
    // Spread rather than assigned, because these two are strings: `undefined`
    // would travel as a key with no value in some serialisers, and "the reply
    // recorded no model" is better said by the field not being there. The token
    // counts above are numbers and already read that way.
    ...(row.model ? { model: row.model } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
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
      resultExcerpt: typeof row.result_excerpt === "string" ? row.result_excerpt : null,
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
    model?: string | null;
    reasoning_effort?: string | null;
    web_search?: boolean | null;
    mode?: string | null;
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
    // Narrowed rather than passed through: the columns are checked in the
    // database, but a row from before 0099 has none of them and a value the
    // client cannot name is better sent as "the agent's" than as itself.
    model: typeof row.model === "string" && row.model ? row.model : null,
    reasoningEffort: (REASONING_EFFORTS as readonly string[]).includes(row.reasoning_effort ?? "")
      ? (row.reasoning_effort as ReasoningEffort)
      : null,
    webSearch: typeof row.web_search === "boolean" ? row.web_search : null,
    mode: row.mode === "normal" || row.mode === "brainstorm" ? row.mode : null,
  };
}

export type BundleDTO = {
  id: string;
  name: string;
  description: string | null;
  documentCount: number;
  createdAt: number;
  /**
   * Whether the workspace can see it (0106). A private bundle is its maker's
   * alone — its documents, its passages, and what it grounds.
   */
  shared: boolean;
  /** Whether the caller made it, which is who may share or unshare it. */
  mine: boolean;
};

export function mapBundle(
  row: {
    id: string;
    name: string;
    description: string | null;
    created_at: string;
    documents?: Array<{ count: number }> | null;
    scope?: string | null;
    created_by?: string | null;
  },
  viewerId?: string,
): BundleDTO {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    documentCount: Array.isArray(row.documents) ? (row.documents[0]?.count ?? 0) : 0,
    createdAt: toEpochMs(row.created_at),
    // A row from before 0106 has no scope and was shared with everybody.
    shared: row.scope !== "owner",
    mine: viewerId !== undefined && row.created_by === viewerId,
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

/**
 * What an event routine is waiting for (0109), as its owner sees it.
 *
 * Never the provider's id for the arrangement and never its secret — 0109
 * grants neither column to any client role, and this is built from the
 * columns it does grant.
 */
export type RoutineEventDTO = {
  /** The catalogue id: `gmail.new_message`. */
  type: string;
  provider: string;
  /** "Gmail", and "New mail" — the event's id when this build no longer knows it. */
  app: string;
  label: string;
  /** The person's choices: filters, a channel. Never a secret. */
  config: Record<string, unknown>;
  /**
   * `pending` until the provider agreed; `active` while events are expected;
   * `failed` (retried) or `expired` (reconnect) with `statusDetail` saying
   * why; `disabled` while the routine is paused.
   */
  status: "pending" | "active" | "failed" | "expired" | "disabled";
  statusDetail: string | null;
  lastEventAt: number | null;
  expiresAt: number | null;
};

/** The columns 0109 grants a client, as `ROUTINE_SELECT` embeds them. */
export type RoutineEventRow = {
  provider: string;
  event_type: string;
  config: Record<string, unknown> | null;
  status: string;
  status_detail: string | null;
  last_event_at: string | null;
  expires_at: string | null;
};

const EVENT_STATUSES = ["pending", "active", "failed", "expired", "disabled"] as const;

export function mapRoutineEvent(row: RoutineEventRow | null): RoutineEventDTO | null {
  if (!row) return null;
  const def = CATALOGUE.eventType(row.event_type);
  return {
    type: row.event_type,
    provider: row.provider,
    app: def?.app ?? row.provider,
    label: def?.label ?? row.event_type,
    config: row.config ?? {},
    // Narrowed, so a value a newer build wrote reads as the safe `pending`
    // — "not confirmed yet" — rather than as a claim it is running.
    status: (EVENT_STATUSES as readonly string[]).includes(row.status)
      ? (row.status as RoutineEventDTO["status"])
      : "pending",
    statusDetail: row.status_detail ?? null,
    lastEventAt: row.last_event_at ? toEpochMs(row.last_event_at) : null,
    expiresAt: row.expires_at ? toEpochMs(row.expires_at) : null,
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
  triggerKind: "schedule" | "webhook" | "both" | "event";
  /**
   * What an `event` routine is waiting for, and whether the provider agreed
   * to tell us (0109). Null for every other kind — and for an event routine
   * whose owner has not picked an event yet, and for anybody but the owner,
   * because `routine_event_subscriptions_select_own` returns the row to the
   * owner alone.
   */
  event: RoutineEventDTO | null;
  /**
   * The bundle each delivered summary is filed into, or null to file nothing —
   * which is every routine made before 0056 and the default since.
   */
  outputBundleId: string | null;
  /** How many filed documents this routine keeps. 52 unless somebody changed it. */
  outputRetention: number;
  /** After how many delivered runs this routine ends itself, or null for never. */
  endsAfterRuns: number | null;
  /** How many it has delivered. */
  runsDone: number;
  /**
   * Whether a scheduled run may use the browser, and what it carries (0100):
   * `off`; `all`, as in chat; or `site`, no cookie jar and only
   * `browserSite`'s saved login.
   */
  browserAccess: "off" | "all" | "site";
  browserSite: string | null;
  /** The conversation this routine's browser reports into, once a run has opened one. */
  browserConversationId: string | null;
  status: "active" | "paused" | "completed";
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
  /**
   * The embedded subscription, when the read asked for it
   * (`ROUTINE_SELECT` in `routes/routines.ts`). PostgREST answers a
   * one-to-one embed with an object, and with an array on a build that did not
   * detect the relationship as one-to-one — both are accepted.
   */
  event?: RoutineEventRow | RoutineEventRow[] | null;
  output_bundle_id?: string | null;
  output_retention?: number | null;
  ends_after_runs?: number | null;
  runs_done?: number | null;
  browser_access?: string | null;
  browser_site?: string | null;
  browser_conversation_id?: string | null;
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
      row.trigger_kind === "webhook" || row.trigger_kind === "both" || row.trigger_kind === "event"
        ? row.trigger_kind
        : "schedule",
    event: mapRoutineEvent(Array.isArray(row.event) ? (row.event[0] ?? null) : (row.event ?? null)),
    outputBundleId: row.output_bundle_id ?? null,
    // 52 rather than 0 when the column is absent, because the DTO has to name
    // the number the database would use: a row read by a query written before
    // 0056 still has the default behind it, and reporting 0 here would put "0
    // kept" in front of somebody whose routine keeps a year of them.
    outputRetention: row.output_retention ?? 52,
    // Null for every row before 0074, which is the same "no column yet" case
    // `outputRetention` above falls back on.
    endsAfterRuns: row.ends_after_runs ?? null,
    runsDone: row.runs_done ?? 0,
    // `off` for a row read before 0100, which is what every routine was.
    browserAccess:
      row.browser_access === "all" || row.browser_access === "site" ? row.browser_access : "off",
    browserSite: row.browser_site ?? null,
    browserConversationId: row.browser_conversation_id ?? null,
    status:
      row.status === "paused" ? "paused" : row.status === "completed" ? "completed" : "active",
    pausedReason: row.paused_reason ?? null,
    nextRunAt: row.next_run_at ? toEpochMs(row.next_run_at) : null,
    lastRunAt: row.last_run_at ? toEpochMs(row.last_run_at) : null,
    createdAt: toEpochMs(row.created_at),
  };
}

export type RoutineRunDTO = {
  id: string;
  /** `waiting`: the report is written and held for a browser task's answer (0100). */
  status: "ok" | "skipped" | "failed" | "waiting";
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
  /**
   * How the model stopped, in `messages.outcome`'s vocabulary (0070). Null for
   * a run that never reached a model — every `skipped` one — and for runs
   * recorded before the column.
   *
   * Forwarded because `status` cannot say it: `ok` means the RUN completed,
   * and a run whose turn was `cut_short` did complete, spent its tokens and
   * delivered what it had. On 2026-10-02 one did exactly that — 41k tokens,
   * a sixth of the usual summary — and read as a third successful run
   * (covan#243). The screen now says it stopped before it finished.
   */
  outcome: MessageOutcome | null;
  /** The model that answered, when one did. Null on the same runs as `outcome`. */
  model: string | null;
  /**
   * What started this run (0109): the cron, Run now, a webhook, an event, a
   * reply. Null for runs recorded before the column existed.
   */
  triggeredBy: "schedule" | "manual" | "webhook" | "event" | "reply" | null;
  /** "Gmail · New mail", for an event run. Null for the rest. */
  triggerLabel: string | null;
  startedAt: number;
};

const TRIGGER_SOURCES = ["schedule", "manual", "webhook", "event", "reply"] as const;

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
  outcome?: string | null;
  model?: string | null;
  triggered_by?: string | null;
  trigger_label?: string | null;
  started_at: string;
}): RoutineRunDTO {
  return {
    id: row.id,
    status:
      row.status === "ok" || row.status === "failed" || row.status === "waiting"
        ? row.status
        : "skipped",
    itemsNew: row.items_new ?? 0,
    itemsOverflow: row.items_overflow ?? 0,
    nothingRelevant: row.status === "skipped" && row.error === NOTHING_RELEVANT_REASON,
    durationMs: row.duration_ms ?? null,
    error: row.error ?? null,
    // A waiting run's `summary` is its draft, and the field means what was
    // delivered — which, until the browser answers, is nothing.
    summary: row.status === "waiting" ? null : (row.summary ?? null),
    documentId: row.document_id ?? null,
    filingNote: row.filing_note ?? null,
    // Narrowed rather than cast: a value a newer build wrote reads as "not
    // known", which renders as an ordinary run rather than a wrong claim.
    outcome: (MESSAGE_OUTCOMES as readonly string[]).includes(row.outcome ?? "")
      ? (row.outcome as MessageOutcome)
      : null,
    model: row.model || null,
    triggeredBy: (TRIGGER_SOURCES as readonly string[]).includes(row.triggered_by ?? "")
      ? (row.triggered_by as RoutineRunDTO["triggeredBy"])
      : null,
    triggerLabel: row.trigger_label || null,
    startedAt: toEpochMs(row.started_at),
  };
}

/** Never carries the secret — `label` is the mask computed at creation time. */
export type DeliveryChannelDTO = {
  id: string;
  kind: "slack_webhook" | "email" | "webhook";
  label: string;
  createdAt: number;
  /**
   * False only for an email channel whose address has not agreed to these
   * messages yet (0096). Nothing is sent to it until it does.
   */
  confirmed: boolean;
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
  confirmed_at?: string | null;
}): DeliveryChannelDTO {
  const kind = CHANNEL_KINDS.find((k) => k === row.kind) ?? "slack_webhook";
  return {
    id: row.id,
    kind,
    label: row.label,
    createdAt: toEpochMs(row.created_at),
    confirmed: kind !== "email" || Boolean(row.confirmed_at),
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

/**
 * A browser task, as the chat screen needs it.
 *
 * `retryOf` is here so the screen can say "tried again" and so the takeover
 * card knows not to offer a second free attempt — one retry per original task
 * is a bound on the operator's money, and 0077 makes it a unique index.
 *
 * **The select that feeds this must name its columns.** `select("*")` on
 * `browser_tasks` answers 42501 for the whole row, because
 * `provider_task_id` is granted to no client role (0073): one deployment-wide
 * BROWSER_USE_API_KEY makes that id the boundary between two tenants at the
 * provider.
 */
export type BrowserTaskDTO = {
  id: string;
  task: string;
  /** `waiting`: in the browser's line, not started (0080). `queued`: a run the provider took. */
  status: "waiting" | "queued" | "running" | "finished" | "failed" | "stopped";
  output: string | null;
  error: string | null;
  retryOf: string | null;
  createdAt: number;
  finishedAt: number | null;
  /** `v2` for a task drained from before 0078; `v4` for a run in the browser beside the chat. */
  apiVersion: "v2" | "v4";
  /**
   * Why a run ended before its answer, or null: 'handed_to_person' | 'cost_cap' |
   * 'cancelled', or the run's own 'login_required' | 'partial' | 'blocked' — the panel's
   * sign-in prompt keys on 'login_required' and nothing else.
   */
  stopReason: string | null;
  /** Our `browser_sessions.id` — which browser, never the provider's. */
  browserSessionId: string | null;
  /**
   * The bare host a run said it needed a sign-in on (`login_required`), or
   * null. The panel's "linkedin.com needs you to sign in" reads it; 0078
   * checks its shape, so it is safe to render as a hostname.
   */
  signInHost: string | null;
  /**
   * What the agent said it would do with the answer (0117), or null; when the
   * answer was written into the conversation; and when a tab carried on with
   * the step. The chat screen sends the conversation on once all three line
   * up — see `claim_browser_continuation`.
   */
  thenStep: string | null;
  deliveredAt: number | null;
  continuedAt: number | null;
  /**
   * Whether this run carried a saved login (R32) — `credential_id is not
   * null`, answered by the worker, because the column itself is granted to no
   * client role and a screen has no use for which login it was. The sign-in
   * card reads it: a wall after a saved login is "the saved login didn't
   * work", not "save one". Computed only for tasks at a login wall; false
   * otherwise.
   */
  carriedSavedLogin: boolean;
  /**
   * A saved login this person may use for `signInHost`, when the run did not
   * carry one — for the sign-in card's "Try again with the saved login"
   * (found in the 2026-10-11 e2e: the model left `site` out, the run carried
   * nothing, and "ask again" looped). Its id, which the hand-back names, its
   * label and its host — never the username. Computed only for the wall the
   * card shows; null otherwise.
   */
  savedLogin: { id: string; label: string; siteHost: string } | null;
};

/**
 * The columns `mapBrowserTask` needs, named because a wildcard is refused.
 * The last four are the ones 0078 grants; `provider_run_id` is not, and is
 * not here. One literal rather than a concatenation, so supabase-js can still
 * type the select from it.
 */
export const BROWSER_TASK_COLUMNS =
  "id, task, status, output, error, retry_of, created_at, finished_at, api_version, stop_reason, browser_session_id, signin_host, then_step, delivered_at, continued_at";

export function mapBrowserTask(
  row: Record<string, unknown>,
  carriedSavedLogin = false,
  savedLogin: BrowserTaskDTO["savedLogin"] = null,
): BrowserTaskDTO {
  return {
    id: String(row.id),
    task: String(row.task ?? ""),
    status: row.status as BrowserTaskDTO["status"],
    output: typeof row.output === "string" && row.output ? row.output : null,
    error: typeof row.error === "string" && row.error ? row.error : null,
    retryOf: row.retry_of ? String(row.retry_of) : null,
    createdAt: toEpochMs(String(row.created_at)),
    finishedAt: row.finished_at ? toEpochMs(String(row.finished_at)) : null,
    apiVersion: row.api_version === "v4" ? "v4" : "v2",
    stopReason: typeof row.stop_reason === "string" && row.stop_reason ? row.stop_reason : null,
    browserSessionId: row.browser_session_id ? String(row.browser_session_id) : null,
    signInHost: typeof row.signin_host === "string" && row.signin_host ? row.signin_host : null,
    thenStep: typeof row.then_step === "string" && row.then_step ? row.then_step : null,
    deliveredAt: row.delivered_at ? toEpochMs(String(row.delivered_at)) : null,
    continuedAt: row.continued_at ? toEpochMs(String(row.continued_at)) : null,
    carriedSavedLogin,
    savedLogin,
  };
}
