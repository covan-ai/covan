import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import type { KnowledgeScope, RetrievalConfig, RetrievedSource } from "../retrieval";
import type { ToolSpec } from "../completion";
import type { RuntimeLimitFlag } from "../runtime-limit";
import type { ComposioTool } from "../composio/client";
import type { ToolTransport } from "./connections";
import { searchDocumentsTool } from "./tools/search-documents";
import { describeConnectionTool } from "./tools/describe-connection";
import { queryDatabaseTool } from "./tools/query-database";
import { httpRequestTool } from "./tools/http-request";
import { browseTool } from "./tools/browse";
import { sendEmailTool } from "./tools/send-email";
import { scheduleJobTool } from "./tools/schedule-job";
import { watchEventTool } from "./tools/watch-event";
import { runRoutineTool } from "./tools/run-routine";
import { findToolTool } from "./tools/find-tool";
import { runToolTool } from "./tools/run-tool";
import { writeDocumentTool } from "./tools/write-document";
import { editDocumentTool, listDocumentsTool, readDocumentTool } from "./tools/documents";
import { askPersonTool } from "./tools/ask-person";
import { covanGuideTool } from "./tools/covan-guide";

/**
 * Every tool an agent can be given, in one list.
 *
 * Copied in shape from `lib/connections/registry.ts`, down to the reason: one
 * list means adding a tool is one entry rather than a search for the four
 * places that enumerate them, and an unconfigured tool is reported as
 * unconfigured rather than hidden — a self-hoster reading the docs for a
 * feature their own build appears not to have is the failure that pattern
 * exists to avoid.
 *
 * What is deliberately NOT here is anything named after a service. There is no
 * `hubspot_contacts` and there will not be one: a service is a row in
 * `tool_connections` (0059), and `http_request` below is how every one of them
 * is reached. A tool of its own gets written the day the general road is
 * genuinely not enough, and then it is one entry in this list.
 *
 * `find_tool` and `run_tool` are that rule holding under pressure rather than
 * an exception to it. Composio describes roughly fifteen hundred applications;
 * putting their operations in this list, or in the model's tool array, is the
 * design this file exists to refuse. So the catalogue is something the agent
 * SEARCHES — two entries here, and never a third — and the list grows by a row
 * in `tool_connections` exactly as it did before.
 */

/**
 * What a tool needs from the environment.
 *
 * `RoutineEnv` rather than `Bindings`, for the reason that type exists: the
 * harness has to run under the cron Worker as well as the API one, and a cron
 * Worker has no anon key and frequently no document store. `RetrievalConfig`
 * is the embedding half, which `search_documents` needs and every other tool
 * ignores.
 */
export type ToolEnv = RoutineEnv & RetrievalConfig;

/**
 * What a tool is told about who is asking.
 *
 * **Every id here is resolved, never passed in by the model.** That is the
 * same rule `lib/routines/executor.ts` holds itself to, and it is the whole
 * security posture of this file: the model chooses which tool to call and what
 * to put in its arguments, and it cannot choose whose workspace it runs in.
 * A tool that took a workspace id as an argument would be one hallucinated
 * uuid away from a cross-tenant read.
 */
/** What a routine run lets `browse` do, and where its answers go. See `ToolContext.routineBrowser`. */
export type RoutineBrowser = {
  /**
   * `'all'` carries what a conversation's browser would — the owner's jar and
   * the saved login for a site the task names. `'site'` carries no jar and
   * only `site`'s saved login.
   */
  access: "all" | "site";
  /** With `'site'`, the one host whose saved login a run may carry. */
  site: string | null;
  /**
   * The routine's conversation, opened the first time it is asked for. Null
   * when it could not be opened, and then nothing is started.
   */
  conversation: () => Promise<string | null>;
  /**
   * The browser tasks this run started or put in line, appended by `browse`.
   * The engine holds the report while any of them is unanswered.
   */
  started: string[];
};

export type ToolContext = {
  /**
   * The caller's own client, carrying their JWT — so every read and write a
   * tool makes is decided by the same RLS policies that decide for the screen
   * they are looking at.
   *
   * Not the service-role client, and the exception is worth naming: a secret
   * a tool has to decrypt is read by `lib/harness/connections.ts`, which asks
   * this client for permission first and only then reaches past it for the
   * ciphertext. That is the `withSecret` pattern from `routes/connections.ts`,
   * not a second one.
   */
  db: SupabaseClient;
  env: ToolEnv;
  workspaceId: string;
  agentId: string;
  userId: string;
  /** The chat session this turn belongs to, when a person is driving it. */
  sessionId?: string;
  /** The routine run this turn belongs to, when nobody is. */
  routineRunId?: string;
  /**
   * A routine run whose owner allowed it the browser (0100), or absent —
   * which is every chat turn and every routine that did not.
   *
   * Its presence is the approval: the owner turned it on once, on the routine,
   * for every run, because a tick has nobody to show a card to. So `browse`
   * reads it in place of `confirmed`, and only `lib/routines/agent-run.ts`
   * sets it, from the routine row — never from anything the model wrote.
   */
  routineBrowser?: RoutineBrowser;
  /**
   * The country the person's request came from (`CF-IPCountry`, normalised by
   * `lib/browser/egress.ts`), or null when it could not say. Read for one
   * thing: the proxy a browser jar made by `browse` is pinned to, so a site
   * they sign in to sees them arrive from where they are. Set by the route
   * from the request, never from anything the model wrote; a scheduled run
   * has none, so a routine's browser jar is pinned nowhere in particular.
   */
  egressCountry?: string | null;
  /**
   * The reply's citations, which `search_documents` adds to.
   *
   * The same array the route persists as `messages.sources`, handed in rather
   * than copied, so a passage the agent found by searching mid-turn is cited
   * beside the ones the turn's own retrieval found. Before this, an answer
   * grounded entirely on a search showed no source chips at all. Absent where
   * nothing persists citations — a routine run.
   */
  foundSources?: RetrievedSource[];
  /**
   * Whose knowledge `search_documents` may read (0106): shared bundles only
   * in a conversation others can read, the owner's own too in a private
   * routine. Set by the route or the routine from the session or routine row,
   * never from anything the model wrote. See `KnowledgeScope`.
   */
  knowledgeScope?: KnowledgeScope;
  /**
   * Whether a person has already said yes to this exact call.
   *
   * False on the first attempt, so a tool that wants confirmation asks for it.
   * True when the turn is resuming from `POST /chat/confirm/:id`, which is the
   * only thing that sets it — and it is set by the route from the stored
   * paused turn, never from anything the model wrote.
   */
  confirmed?: boolean;
  /**
   * Set beside `confirmed` when the yes was given on ANOTHER call's card, as a
   * line in the list it carried (`AgentTool.approvedTogether`), rather than on
   * a card of this call's own. Such a card showed only the line, so a tool
   * must not add to this call anything the line did not say — a saved login,
   * most of all. Set by `routes/chat.ts` only.
   */
  confirmedAsListed?: boolean;
  /**
   * Connections a person has already approved an action on, in this turn.
   *
   * Computed by `lib/harness/loop.ts` from the steps it can already see, not
   * stored and not sent by anything the model wrote. It exists because
   * `confirmed` alone is a dialog box rather than a gate: `routes/chat.ts`
   * resets it after each approval — correctly, for `send_email`, where the
   * model names a fresh subject and body every time — and a connected app is
   * called several times for one instruction. Three clicks to answer "check my
   * last three threads and reply to Ana", each one re-streaming the transcript,
   * trains people to approve without reading.
   *
   * So the unit is the connection and the scope is the turn. One yes covers
   * that service until the turn ends; a different service asks again.
   *
   * Two things it does not cover, both in `run_tool`'s guard 3: an operation
   * this turn described as `destructive` (see `approvedSlugs`), and an
   * operation this turn knows nothing about at all — where "nothing about it"
   * is the honest state of every resumed turn and every scheduled run, and
   * reading it as harmless is what the 2026-10-08 audit found.
   */
  approvedConnections?: string[];
  /**
   * The operations already approved on those connections, this turn.
   *
   * The connection-wide approval above is right for the case it was written for
   * — three clicks to answer one instruction trains people to approve without
   * reading — and wrong for the call that empties the account. On 2026-09-26 a
   * calendar was cleared by an operation the person had never approved; it asked
   * only because it happened to be the turn's first call. One create beforehand
   * and it would not have asked at all.
   *
   * So a `destructive` operation is covered by the connection's approval only if
   * it is the operation that was approved. Repeating an approved destructive call
   * stays free, which is what the original reasoning protects. #201.
   */
  approvedSlugs?: string[];
  /**
   * Raised by whatever first notices this invocation is out of platform
   * budget, so the route can say so instead of "an error".
   *
   * Optional because only the chat route sets it: a scheduled run reports
   * through its own run record and has no stream to explain itself on. See
   * `lib/runtime-limit.ts` for why one shared flag beats an error that
   * propagates — by the time anything propagates, the real message is gone.
   */
  runtimeLimit?: RuntimeLimitFlag;
  /**
   * Catalogue searches already answered this turn, keyed by what was asked.
   *
   * Only `find_tool` writes to it, and only `find_tool` should: searching a
   * catalogue is the one thing here that is genuinely idempotent within a
   * turn. `run_tool` must never be memoised — it changes things at a third
   * party, and asking twice is two different events.
   *
   * It exists because a model that has just had a tool call fail goes back to
   * the search rather than to the list it already has. Measured: one
   * production turn repeated `find_tool {query: "list events", toolkit:
   * "googlecalendar"}` byte for byte, three steps after the first one, and got
   * the same 3,631 characters back. The repeat still costs a step — the model
   * chose to spend it and the budget has to mean something — but it need not
   * also cost a network call, and the answer can say "you already have this"
   * instead of quietly looking identical.
   */
  searchMemo?: Map<string, string>;
  /**
   * Schemas already described this turn, keyed by connection.
   *
   * Its own map rather than a prefix inside `searchMemo`, whose documentation
   * above says only `find_tool` writes there — and that sentence is worth more
   * than the one field it costs to keep true.
   */
  describeMemo?: Map<string, string>;
  /**
   * Every slug `find_tool` has put in front of the model this turn.
   *
   * `run_tool`'s own description already promises this — "a slug you have not
   * seen in a find_tool result will be refused" — and until now nothing
   * enforced it, which made the sentence a claim the code did not keep.
   *
   * It is enforced because the model does invent slugs, and the invented ones
   * look right. Production, 19:04:38 and again identically at 19:05:39:
   * `find_tool` returned `GOOGLECALENDAR_EVENTS_LIST` and the next step ran
   * `GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS`, which does not exist. Composio
   * answered `404 Tool_ToolNotFound` — a round trip and a step to learn
   * something the turn already knew.
   *
   * Written only by `find_tool`, and only with slugs it actually rendered: a
   * candidate dropped from the shortlist was not offered, so refusing it later
   * is right. Empty means `find_tool` has not answered this turn, and then
   * nothing is refused — a slug can legitimately come from an earlier turn's
   * transcript or a standing grant, and refusing those would break working
   * behaviour to prevent a mistake that has not happened.
   */
  offeredSlugs?: Set<string>;
  /**
   * Every operation `find_tool` has put in front of the model this turn, whole.
   *
   * The same provenance rule as `offeredSlugs`, and for the same reason: written
   * only by `find_tool`, only for operations it actually rendered, and read by
   * `run_tool` so a malformed call can be refused here instead of at Composio.
   *
   * It exists because `wasBilled` returns true for everything but 501 and 502, so
   * a `400 Invalid request data provided` costs exactly what a call that worked
   * costs. Ten of them on one task on 2026-09-26, each one naming a field and the
   * type it wanted — all of it checkable against a schema this turn already had
   * in hand and then dropped on the floor.
   *
   * Absent means no ARGUMENT check, which is the same shape as an empty
   * `offeredSlugs`: a slug can legitimately arrive from an earlier turn or a
   * standing grant, and refusing arguments that cannot be verified would break
   * working behaviour to prevent a mistake that has not happened.
   *
   * ABSENT DOES NOT MEAN NO PERMISSION CHECK, and reading it that way was
   * finding 2 of the 2026-10-08 audit. The map is built empty and only
   * `find_tool` fills it, so it is empty on every resumed turn, every scheduled
   * run and every turn that reaches for a slug out of its own transcript — and
   * on those `run_tool` used to read a missing `destructive` as "not
   * destructive" and let the connection's turn-long approval cover anything.
   * Now the gate asks whether this map describes the slug at all: described
   * narrows on `destructive`, undescribed falls back to `approvedSlugs`, the
   * record of what a person actually approved. The one exception is the resume
   * path, where `routes/chat-turn.ts` seeds it from the stored proposal so the
   * approved call is checked against the operation the half that asked had in
   * hand.
   *
   * It carries the whole `ComposioTool` rather than the schema alone because the
   * approval card needs the other two fields. On 2026-09-26 somebody asked for a
   * few events to be deleted and was shown "Run GOOGLECALENDAR_CLEAR_CALENDAR on
   * Google Calendar?" — a slug and a label. They approved in 2.7 seconds and the
   * calendar was emptied. `description` said "deleting all events from it" and
   * `destructive` was true, and neither reached the person being asked. #201.
   */
  offeredOperations?: Map<string, ComposioTool>;
  /**
   * The searches an EARLIER turn of this conversation already paid for, keyed
   * the way `searchMemoKey` keys a live one, each holding the slugs that search
   * offered.
   *
   * The other three maps above are a turn's own scratch space. This one is
   * read-only and comes from `message_steps` — `request` for the question,
   * `offered` for the answer — so a repeat can be recognised rather than
   * bought again. 94 discovery steps in production held 24 byte-identical
   * repeats, 20 of them in a later turn, 80,368 characters (covan#216).
   *
   * THE SAME PROVENANCE RULE AS `offeredSlugs`, and here it is the whole
   * safety argument rather than a convention: the key carries no workspace at
   * all. A store that outlived a turn on these keys would answer one tenant's
   * search with another's. Nothing does — `priorSearches` in
   * `lib/harness/offerings.ts` reads it back through the caller's own
   * RLS-scoped client every turn, from this session's own rows, and that read
   * IS the tenant check.
   *
   * Values are slugs and never rendered text: see `priorSearches` for why the
   * answer has to be rebuilt rather than recovered.
   */
  priorSearches?: Map<string, string[]>;
  /**
   * How many routines started one another to reach the routine run this turn
   * belongs to (`IngestTrigger.depth`). Read by `run_routine`, which starts
   * the next one a step deeper and refuses past its limit. Absent in chat.
   */
  chainDepth?: number;
  /** Bounds a tool's own outbound work. See `lib/harness/budget.ts`. */
  signal?: AbortSignal;
};

/**
 * Who said yes to a call that acts at a connected service: the person, on a
 * card (`person`); a standing always-allow (`grant`); or an earlier yes on the
 * same connection that this call rode on (`connection`). Only the first is
 * somebody looking at what is about to happen — see `approvedConnectionsFrom`.
 */
export type RunApproval = "person" | "grant" | "connection";

export type ToolResult =
  | { kind: "ok"; content: string; approval?: RunApproval }
  | { kind: "error"; message: string }
  /**
   * The tool has worked out what it would do and wants a person to say yes
   * first.
   *
   * Generic on purpose, and not because a second tool might want it one day —
   * because the mechanism `0058` needs for `ask → pending → approved` is
   * exactly this one, and bolting it on afterwards would mean going through
   * every tool a second time. `summary` is one sentence a person reads;
   * `proposal` is the machine-readable thing they are agreeing to, rendered by
   * the confirmation card and stored verbatim in `paused_turns`.
   */
  | { kind: "needs_confirmation"; summary: string; proposal: unknown };

export type AgentTool = {
  name: string;
  description: string;
  /** JSON Schema for the arguments. Sent to the provider as-is. */
  input: Record<string, unknown>;
  /**
   * Whether this tool changes something outside Covan.
   *
   * 0058 spells the same idea `connection_capabilities.is_destructive`, and
   * this is deliberately the same word: the day a capability catalogue row
   * exists for one of these, this field is what it is populated from.
   *
   * Until then it does one thing, which is small and worth keeping: the
   * Integrations page says which tools can change something, so "what can
   * this agent actually do" is answerable without reading this file.
   */
  destructive: boolean;
  /**
   * Whether this deployment can offer the tool at all.
   *
   * A tool that says no is not hidden from the operator; it is left out of the
   * list the model is given, because a tool the model can call and this build
   * cannot run is worse than one that does not exist. `toolAvailability`
   * reports both states for the interface.
   */
  isConfigured(env: ToolEnv): boolean;
  /**
   * What this workspace must already have for the tool to be worth offering.
   *
   * Not a permission — `isConfigured` is about the deployment and RLS is
   * about the caller; this is about whether the tool has anything to point
   * at. A workspace with no connected services gets no `query_database` in
   * its prompt, which saves the tokens and, more usefully, removes the
   * invitation to invent a connection id. See `lib/harness/available.ts`.
   *
   * A connection tool names the transports it can actually use, because "is
   * there a connection" stopped being the question once a workspace could
   * hold more than one kind. Until 2026-10 it was `"connection"`, satisfied by
   * any row, so a workspace whose only connections were Composio apps was
   * offered `query_database`, saw an app called "Supabase", and spent six of
   * six calls being told by the tool's own transport check that an app is not
   * a database (covan#251). The run-time refusal in each tool stays; this only
   * stops the offer.
   */
  needs?: "channel" | { connection: readonly ToolTransport[] };
  /**
   * Several calls of this tool in one batch go on ONE card, and one yes covers
   * them all.
   *
   * For `browse`. A model asked for three sites asks for three browsers in one
   * pass; the first asks the person, and until 2026-10-12 the other two were
   * answered "not run, call it again" — and on 2026-10-11 21:32 the model
   * never did, so one site was looked at and three were reported. Now the loop
   * lists the later calls on the first one's card (`line` of each, at most
   * `max`), and the confirm route runs exactly those, confirmed, once the
   * person approves.
   *
   * `line` is the call as the card shows it, and what the confirm route matches
   * verbatim before running a call as approved; null leaves the call off the
   * card, to ask for itself. `card` widens the first call's card with the
   * lines; `listed` reads them back out of a stored proposal.
   */
  approvedTogether?: {
    max: number;
    line(args: Record<string, unknown>): string | null;
    card(
      asked: { summary: string; proposal: unknown },
      lines: string[],
    ): { summary: string; proposal: unknown };
    listed(proposal: unknown): string[];
  };
  /**
   * How long this call may take, when that is longer than the turn gives any
   * call (`TOOL_TIMEOUT_MS`). Read off the arguments, because it is a kind of
   * call that needs the time and not the tool: `run_tool` with a `question`
   * reads page after page, and the same tool fetching one page has no reason
   * to be allowed more than twenty seconds. Undefined is the turn's own.
   */
  timeoutFor?(args: unknown): number | undefined;
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>;
};

/** Every tool, configured or not, in the order the interface lists them. */
export const TOOLS: AgentTool[] = [
  searchDocumentsTool,
  listDocumentsTool,
  readDocumentTool,
  describeConnectionTool,
  queryDatabaseTool,
  httpRequestTool,
  browseTool,
  findToolTool,
  runToolTool,
  sendEmailTool,
  scheduleJobTool,
  watchEventTool,
  runRoutineTool,
  writeDocumentTool,
  editDocumentTool,
  askPersonTool,
  covanGuideTool,
];

export function toolByName(name: string): AgentTool | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

/** The tools this deployment can actually run. */
export function configuredTools(env: ToolEnv): AgentTool[] {
  return TOOLS.filter((t) => t.isConfigured(env));
}

/** What the interface shows: every tool, and whether this build can run it. */
export function toolAvailability(
  env: ToolEnv,
): Array<{ name: string; description: string; destructive: boolean; configured: boolean }> {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    destructive: t.destructive,
    configured: t.isConfigured(env),
  }));
}

/** The provider-independent description the completion seam wants. */
export function toolSpecs(tools: AgentTool[]): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input: t.input }));
}
