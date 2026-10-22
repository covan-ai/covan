// worker/src/lib/routines/executor.ts
import type { KnowledgeScope } from "../retrieval";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MessageOutcome } from "../harness/usage";
import type { RoutineEnv } from "../../types";
import { nextRunAt, windowDays } from "./schedule";
import { fetchSource, type FetchDeps, type SourceResult } from "./source";
import { UpstreamError } from "./upstream-error";
import { classifyProviderError, isProviderError, reportProviderFailure } from "../provider-error";
import { fetchConnectionItems } from "./connection-source";
import { diffItems, type Cursor, type FeedItem } from "./feed";
import {
  claimItemKeys,
  deliver,
  releaseItemKeys,
  type DeliveryChannel,
  type DeliveryContext,
  type DeliveryDeps,
  type EmailThread,
} from "./delivery";
import { deliverToOtherChannels } from "./other-channels";
import { withModelEndpoint } from "../model-endpoints";
import { routineFailedEmail } from "../emails/away";
import { appUrlFrom, mailerFrom, type Mailer } from "../reports/mailer";
import { EVENT_DELIVERED, EVENT_PAUSED, EVENT_QUOTA_EXHAUSTED } from "./webhook";
import { NOTE_NO_DOCUMENT_STORE, NOTE_VIEWER, type FilingInput, type FilingResult } from "./filing";
import type { CoverageRunInput, CoverageRunResult } from "./coverage-source";
import { embeddingSpend, spends, type Entitlements, type Spend } from "../entitlements";
import { embeddingModel } from "../embeddings";
import {
  CONFIRMABLE_COLUMNS,
  readyForDelivery,
  type ConfirmableChannel,
} from "./address-confirmation";
import type { RoutineBrowser } from "../harness/registry";
import { openRoutineConversation } from "./held";
import { agentAccessFor } from "../agent-access";

export const MAX_FAILURES = 5;

/**
 * Written to `routine_runs.error` when a run is skipped for credits, and
 * matched exactly on the next tick to decide whether the owner has already been
 * told. Kept free of anything variable — a balance in here would make every run
 * look like a new one and the notice would repeat.
 *
 * The name is older than credits and is kept: it is compared by value, and a
 * rename would buy nothing.
 */
export const QUOTA_SKIP_REASON = "skipped: this workspace has no credits left";

/**
 * Written to `routine_runs.error` when the model read what arrived and judged
 * none of it to be what the instruction asked for.
 *
 * Invariable, like `QUOTA_SKIP_REASON` and for a related reason: the interface
 * matches it exactly to decide whether a skipped row reads "Nothing new" or
 * "Nothing relevant", and the count of what was reviewed lives in
 * `items_new` rather than in this string. It must also never equal
 * `QUOTA_SKIP_REASON`, which `lastRunWasQuotaSkip` compares against — a
 * collision there would suppress the quota notice.
 */
export const NOTHING_RELEVANT_REASON = "skipped: nothing in this run matched the instruction";

/**
 * The same limit for failures that are the remote's fault rather than the
 * routine's — a 429 or a 5xx. Set far higher because backoff is capped at six
 * hours past the natural next run, so reaching this many consecutive transient
 * failures means the source has been unreachable for days. That is worth
 * pausing for; three rate-limited ticks in an afternoon is not.
 */
export const MAX_TRANSIENT_FAILURES = 20;

/**
 * Whether a failed run counts against the transient allowance rather than the
 * five that pause a routine.
 *
 * A model provider's refusal is never a statement about the routine. A 429 or a
 * 5xx is the same bad minute a feed has; an empty provider account
 * (covan-ai/covan#350) is the operator's to fix, and pausing every routine in
 * every workspace for it would leave each owner a routine to resume by hand
 * for something they could not have caused. So all of them are transient —
 * `isProviderError` first, so a feed's own 403 is not mistaken for one.
 */
function transientFailure(err: unknown): boolean {
  if (err instanceof UpstreamError) return err.transient;
  return isProviderError(err);
}

/** Backoff never pushes a routine more than this far past its natural next run. */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** A field added here must also be added to `ingest.ts`'s `ROUTINE_COLUMNS`. */
export type RoutineRow = {
  id: string;
  agent_id: string;
  user_id: string;
  /**
   * Whether the workspace can read this routine and its runs (0012). Decides
   * whose knowledge it may stand on (0106): a shared routine's report is read
   * by everybody, so only shared bundles ground it. Optional for the
   * projections that predate it, which read as private.
   */
  visibility?: string | null;
  workspace_id: string;
  name: string;
  source_kind: "rss" | "web" | "none" | "connection" | "workspace";
  /**
   * `url` for rss and web, `connectionId` for connection, `report` for
   * workspace (0075 — the only value today is `coverage_gaps`), empty for
   * none.
   */
  source_config: { url?: string; connectionId?: string; report?: string };
  instruction: string;
  delivery_channel_id: string;
  schedule_cron: string;
  timezone: string;
  /** The slot this run was claimed for. Used as the `none` idempotency key. */
  next_run_at: string;
  cursor: Cursor | null;
  consecutive_failures: number;
  /**
   * The bundle a delivered summary is filed into, or null to file nothing —
   * which is every routine made before 0056 and the default for every one
   * made since. Optional on the type as well as nullable in the column, so a
   * caller reading a narrower projection is not forced to invent one.
   */
  output_bundle_id?: string | null;
  /** How many filed documents this routine keeps. 0056's default is 52. */
  output_retention?: number | null;
  /** After how many delivered runs this routine ends itself. Null means never. */
  ends_after_runs: number | null;
  /** Delivered runs so far — incremented only where `finish` records `"ok"`. */
  runs_done: number;
  /**
   * Whether a run may use the browser, and what it carries (0100). Optional
   * for `output_bundle_id`'s reason; absent reads as `'off'`.
   */
  browser_access?: "off" | "all" | "site" | null;
  /** With `'site'`, the one host whose saved login a run may carry. */
  browser_site?: string | null;
  /** The owner's conversation this routine's browser runs beside, once one is open. */
  browser_conversation_id?: string | null;
  /**
   * Whether each run also lands in the Inbox as a thread of its own (0123).
   * Optional for `output_bundle_id`'s reason; absent reads as on, the
   * column's default.
   */
  deliver_inbox?: boolean | null;
  /**
   * The model and thinking this routine runs on (0123), over its agent's.
   * Null — or absent, for a narrower projection — is the agent's own.
   */
  model?: string | null;
  reasoning_effort?: string | null;
};

export type SummariseInput = {
  persona: string | null;
  model: string | null;
  /**
   * The agent's own tuning (0048), carried so a routine writes the way the
   * agent answers. A routine is the same colleague reporting instead of
   * replying, and an agent told to stay close to its material should not
   * improvise on a schedule because the report took a different code path.
   *
   * Null — or absent, which is the same thing here — means what it means
   * everywhere else: the model's own defaults, which is what every routine ran
   * on before the settings existed.
   */
  temperature?: number | null;
  reasoningEffort?: string | null;
  instruction: string;
  items: FeedItem[];
  pageText?: string;
  /**
   * What the agent already knows, retrieved for this run. Empty when the agent
   * has no documents, when nothing matched — by meaning or by wording — or
   * when retrieval failed — all three mean the same thing to the model, which
   * is that it answers from its persona alone.
   */
  ragBlock: string;
  /**
   * The body of an incoming webhook, when a poke started this run.
   *
   * Treated as what it is: text somebody outside this workspace chose. It goes
   * into the user message with the instruction, never into a system one. See
   * `summarise.ts` for what that does and does not buy.
   */
  payloadText?: string;
  /**
   * What the payload is, when something better than "a webhook payload" is
   * known — "Gmail · New mail" for an event (0109). The heading above
   * `payloadText` in the prompt; see `routineMaterial`.
   */
  payloadLabel?: string;
  /**
   * Whether this run is allowed to decide there is nothing worth sending.
   *
   * False for a scheduled prompt, which has no source for its output to be
   * irrelevant *to* — the instruction is the whole job, and one `false` would
   * silence "remind the team to post standup" permanently. True for everything
   * that watches something, and for a poked run, whose payload is exactly such
   * a thing.
   */
  mayDecline: boolean;
  /**
   * The zone this routine's schedule is written in, and therefore the zone its
   * output means.
   *
   * `routines.timezone` (0012) — already the input to `nextRunAt`, so "9am" in
   * the schedule and "9am" in the answer are the same 9am. It reaches the model
   * because a run that writes a time somewhere has to write it in some zone,
   * and the alternative is UTC by silence: production wrote a recurring Monday
   * 22:00 meeting into a real calendar as Tuesday 01:00 that way (#192).
   *
   * The chat route takes the same thing from Cloudflare's `cf.timezone`, which
   * is a per-request guess. This one is a stored setting, so it is the better
   * of the two answers and is the one a routine should have had first.
   */
  timezone?: string | null;
  /**
   * Where this run sits in a routine that ends, or absent for one that does not.
   *
   * `done` is how many have been delivered *before* this one, so the run being
   * written is `done + 1`. Not material — `routineMaterial()` answers "what is
   * this run working from", and for a scheduled prompt the answer is still
   * nothing. This is context about the run itself.
   */
  runPosition?: { done: number; total: number };
};

/**
 * The same run, described for the path that has tools.
 *
 * `SummariseInput` plus the three ids a tool needs and cannot be given by the
 * model — see `ToolContext` in `lib/harness/registry.ts` for why every id a
 * tool sees is resolved rather than passed in. They are on a separate type
 * because `summariseWithModel` has no use for them and taking them would
 * imply it did.
 */
export type AgentRunInput = SummariseInput & {
  agentId: string;
  workspaceId: string;
  userId: string;
  routineRunId?: string;
  /**
   * What `browse` may do on this run, when the routine's owner allowed the
   * browser (0100); absent otherwise, and then the tool is not offered.
   */
  browser?: Omit<RoutineBrowser, "started">;
  /** Whose knowledge `search_documents` may read. See `knowledgeScopeOf`. */
  knowledgeScope?: KnowledgeScope;
  /** How many routines started one another to reach this run. See `IngestTrigger.depth`. */
  chainDepth?: number;
};

export type AgentRunResult = {
  text: string;
  /** How many tokens moved. The durable record, and what the run history shows. */
  tokens: number;
  /** What was consumed, for the ledger. */
  spend: Spend[];
  declined: boolean;
  /**
   * The browser tasks the turn started or put in line. When there are any the
   * report is a draft: it is written as a `waiting` run and sent by
   * `lib/routines/held.ts` once they have answered.
   */
  heldFor?: string[];
} & ModelCall;

/**
 * The two facts about the model call that `routine_runs` had nowhere to put.
 *
 * Both producers answer them — `lib/routines/agent-run.ts` for a run with tools
 * and `lib/routines/summarise.ts` for the single call beside it — so the row
 * carries them whichever branch ran, and neither has to be inferred from
 * `status`. See 0070.
 */
export type ModelCall = {
  /** Which model answered, as `resolveModel` settled it. */
  model: string;
  /**
   * How the model stopped, through the same `replyOutcome` the chat path uses.
   *
   * Named apart from `status` because they are different questions with
   * different readers: `status` is the delivery verdict a person reads in the
   * run history, and this is what happened to the request underneath it. A run
   * can be `ok` and `truncated`, or `skipped` and `answered`.
   */
  modelOutcome: MessageOutcome;
};

export type RetrievalInput = { agentId: string; query: string; scope?: KnowledgeScope };

/**
 * Whose knowledge a routine's run may stand on (0106). It runs for its owner,
 * with the service role, which no policy narrows — so this is said out loud:
 * the owner's own bundles and the shared ones for a private routine, shared
 * only for one the workspace can read.
 */
export function knowledgeScopeOf(
  routine: Pick<RoutineRow, "user_id" | "visibility">,
): KnowledgeScope {
  return routine.visibility === "shared" ? { sharedOnly: true } : { viewer: routine.user_id };
}

export type ExecutorDeps = {
  /** Service-role client — bypasses RLS. See the scoping note below. */
  db: SupabaseClient;
  /** The deployment's env. Every model call a run makes goes through it. */
  env: RoutineEnv;
  summarise: (
    input: SummariseInput,
    env: RoutineEnv,
  ) => Promise<
    ModelCall & {
      text: string;
      tokens: number;
      /** What was consumed, for the ledger. */
      spend: Spend[];
      /**
       * The model read the material and judged none of it to be what the
       * instruction asked for, so this run delivers nothing. Only ever true
       * when the input allowed it — see `SummariseInput.mayDecline`.
       */
      declined: boolean;
    }
  >;
  /**
   * The same run, with tools.
   *
   * Optional, and absent is the ordinary state rather than the degraded one:
   * a deployment can be running with no tool configured at all, and the
   * executor's own tests drive it without one. It returns `null` when this
   * workspace has nothing for a tool to point at, which sends the run down
   * `summarise` — the one-call path, which is strictly cheaper and is what
   * every routine did before this existed.
   *
   * **This is the dependency that ties the routine engine to the harness**,
   * and it is taken deliberately. Two execution paths would mean a job set up
   * in a conversation behaving differently when it runs unattended, which is
   * the difference nobody could debug.
   */
  runWithTools?: (input: AgentRunInput, env: RoutineEnv) => Promise<AgentRunResult | null>;
  /**
   * Send a `waiting` run's report if its browser has already answered —
   * `completeHeldRun`, bound by the dispatcher. Optional for `runWithTools`'s
   * reason: without it a held report is sent by the next settle or the sweep.
   */
  completeHeld?: (runId: string) => Promise<unknown>;
  /**
   * What the agent knows, for one run.
   *
   * Injected rather than called directly for the reason `summarise` is: this
   * module is meant to be drivable without an environment, and `retrieveForAgent`
   * needs embedding config. The dispatcher supplies the real one.
   *
   * Takes the resolved run env for the same reason `summarise` does. Embedding
   * is a paid call, so it has to go to whichever key is answering this run — an
   * owner who brought their own is not asking the operator to pay for the
   * retrieval half of it.
   */
  retrieve: (
    input: RetrievalInput,
    env: RoutineEnv,
  ) => Promise<{ ragBlock: string; embeddingTokens: number }>;
  fetchDeps: FetchDeps;
  deliveryDeps: DeliveryDeps;
  /**
   * Files a delivered summary into the routine's output bundle.
   *
   * Injected for the reason `summarise` and `retrieve` are — this module is
   * meant to be drivable without an environment — and **optional for a second
   * reason that is not about testing at all**: the dispatcher leaves it
   * undefined when this Worker has no document store bound.
   *
   * That is the ordinary state of the cron Worker on Cloudflare, where an R2
   * bucket cannot be shared across accounts and `wrangler.cron.toml.example`
   * says as much. Expressing it as an absent dependency rather than a runtime
   * check inside the filing code is what makes the failure impossible to get
   * wrong: there is nothing here that could throw, so there is nothing that
   * could be counted as a failure and eventually pause a routine that is
   * delivering perfectly well. See `canFileDocuments`.
   *
   * Takes the resolved run env for the same reason the other two do: embedding
   * is a paid call and goes to whichever key is answering this run.
   */
  file?: (input: FilingInput, env: RoutineEnv) => Promise<FilingResult>;
  /**
   * The gap report, end to end — Task 12's `runCoverageReport`, bound to its
   * real dependencies including the one model call. Optional for the same
   * reason `runWithTools` and `file` are: this module is meant to be drivable
   * without an environment, and a deployment can be running with no coverage
   * dep configured at all — the `workspace` branch below treats that as a
   * deployment mistake and fails loudly rather than skipping forever.
   *
   * Takes the resolved run env for the same reason `summarise` and `retrieve`
   * do: the clustering call is a paid call, and an owner who brought their own
   * key pays for it rather than the operator.
   */
  coverage?: (input: CoverageRunInput, env: RoutineEnv) => Promise<CoverageRunResult>;
  /**
   * What set this run going, reported to a webhook receiver as
   * `run.triggeredBy`.
   *
   * A string on the wire rather than a boolean, because the answer already has
   * more than two values in prospect: the cron tick, the button on the
   * routine's page, and — once a routine can be poked from outside — an
   * incoming request. Defaults to the schedule, which is what a caller that
   * has not thought about it almost always means.
   *
   * `test` is "Run a test" (0130); see `isTest`.
   */
  trigger?: string;
  /** What the routine's owner may spend. Unmetered on a self-hosted install. */
  entitlements: Entitlements;
  /**
   * How "A routine fails" reaches its owner's inbox (0133). Absent means the
   * deployment's own mail, if it has any; null means none.
   */
  mail?: Mailer | null;
  now: () => Date;
};

/**
 * How much of a watched page's text goes into the retrieval query.
 *
 * The page itself is already in the prompt; this only has to be enough to
 * describe what the page is about. Embedding twenty thousand characters to
 * find six passages would cost more than the completion it is grounding.
 */
const PAGE_QUERY_CHARS = 500;

/**
 * What to look up in the agent's documents for this run.
 *
 * A routine has no question, which is the thing that makes this different from
 * a chat turn. It has a standing instruction and whatever arrived this
 * particular time, and both halves matter: the instruction alone returns the
 * same passages on every run whatever came in, and the arrivals alone lose the
 * reason the routine exists.
 */
function retrievalQueryFor(instruction: string, items: FeedItem[], pageText?: string): string {
  if (pageText) return `${instruction}\n${pageText.slice(0, PAGE_QUERY_CHARS)}`;
  if (items.length === 0) return instruction;
  return `${instruction}\n${items.map((i) => i.title).join("\n")}`;
}

/**
 * Says what the message is missing, in the message.
 *
 * A run delivers at most ten new entries and marks everything it saw as seen,
 * so on a busy feed the reader gets ten of forty and the other thirty are not
 * late — they are never coming. Somebody reading a digest has no way to know
 * that, and the shape of the failure is the worst kind: the message looks
 * complete. The run history carries the same number, but the digest is where
 * the person is looking.
 *
 * Appended after the model's text rather than described to the model, because
 * this is a fact about the delivery and not something the summary should be
 * asked to reason about — and a model told "you are missing thirty entries"
 * tends to hedge the ten it does have.
 */
function withOverflowNote(text: string, overflow: number): string {
  if (overflow <= 0) return text;
  const entries = overflow === 1 ? "entry" : "entries";
  // Italic in Slack's mrkdwn and in the Markdown the email path renders, which
  // are the only two destinations there are.
  return `${text}\n\n_${overflow} further ${entries} were not included._`;
}

/**
 * Executes one routine, end to end. Knows nothing about what triggered it —
 * the cron dispatcher calls it today, a queue consumer could tomorrow.
 *
 * SECURITY: `deps.db` is the service-role client and bypasses row level
 * security. Every id used below is read off the routine row itself, never
 * from a caller. Nothing in this file should ever take an id as an argument.
 */
/**
 * What an incoming poke brought with it, when one started this run.
 *
 * Absent for every scheduled run, which is the shape of the feature: a routine
 * is started by its cron, or by somebody's POST, and only the second has a
 * payload or an event to be idempotent about.
 */
export type IngestTrigger = {
  /**
   * The sender's own id for this event, already extracted by the route. It
   * becomes the delivery claim, so a webhook delivered twice — which every
   * sender worth using will do — produces one message and one visible
   * `skipped` run rather than two reports.
   */
  eventId: string;
  /** The raw body, as text. Given to the model and stored nowhere. */
  payload: string;
  /**
   * What kind of poke this is (0109). A webhook is somebody's POST; an event
   * is a third party telling us something happened (`lib/routines/events/`);
   * a reply is somebody answering a routine's own mail. The run is the same
   * for all three — this decides the delivery key's prefix, the heading the
   * model sees above the payload, and what the run's history says started it.
   */
  source: "webhook" | "event" | "reply";
  /**
   * What a person reads in the run history — "Gmail · New mail" — and the
   * heading the model reads above the payload. Absent for a webhook, whose
   * body is whatever the sender chose and has no better name than that.
   */
  label?: string;
  /**
   * A reply's thread (`lib/routines/replies.ts`): the answer this run sends
   * goes into the same conversation, under "Re:". Absent for every other poke.
   */
  thread?: EmailThread;
  /**
   * Where the event came from, when the run's report should also go back
   * there — the Telegram chat a message was sent in. The routine's own
   * delivery channel still gets it; this is the conversation answered as
   * well. Read after the run by `poke-room.ts`, never by the executor, which
   * delivers exactly as before.
   */
  replyTo?: EventReplyTo;
  /**
   * How many routines started one another, by `run_routine`, to get here:
   * one for a routine an agent started from a conversation, two for one that
   * routine then started. Absent is zero. The tool refuses past
   * `MAX_CHAIN_DEPTH`, so two routines that start each other stop after a
   * few rounds instead of spending a workspace's credits in a loop.
   */
  depth?: number;
};

/** A place a poked run's report is answered to, besides its delivery channel. */
export type EventReplyTo = { provider: "telegram"; chatId: string; messageId?: number };

/**
 * What a run ended as. `summary` is the report it delivered, on an `ok` run
 * only: what a Siri shortcut waiting on `?wait=1` reads out, and what a
 * Telegram chat is answered with.
 */
export type RunResult = {
  status: "ok" | "skipped" | "failed" | "waiting";
  itemsNew: number;
  summary?: string;
};

/**
 * The claim a poke makes in `routine_deliveries`, by kind.
 *
 * Separate prefixes, so a webhook sender's `X-GitHub-Delivery` and a Composio
 * event id that happened to be the same string are two events and not one
 * already handled. An event's id arrives already namespaced by its provider
 * (`receive.ts` writes `<provider>:<id>`), so `evt:` keys cannot collide
 * between two providers either.
 */
export function pokeKey(trigger: IngestTrigger): string {
  const prefix = trigger.source === "event" ? "evt" : trigger.source === "reply" ? "reply" : "hook";
  return `${prefix}:${trigger.eventId}`;
}

/**
 * What started a run, as `routine_runs` records it (0109) and as a webhook
 * receiver is told it in `run.triggeredBy`.
 */
export type RunOrigin = {
  triggeredBy: "schedule" | "manual" | "webhook" | "event" | "reply" | "test";
  label: string | null;
};

function originOf(deps: ExecutorDeps, trigger: IngestTrigger | undefined): RunOrigin {
  // A poke names itself, whatever the dispatcher was built as.
  if (trigger) return { triggeredBy: trigger.source, label: trigger.label ?? null };
  if (isTest(deps)) return { triggeredBy: "test", label: null };
  return { triggeredBy: deps.trigger === "manual" ? "manual" : "schedule", label: null };
}

/**
 * A test run (0130): "Run a test" in the routine editor, which "costs the same
 * and goes only to you". It reads, thinks and is charged like any run, and
 * then leaves no mark outside its own row and its owner's private thread: no
 * channel, no filing, no browser, no claim on what it read, no cursor moved,
 * no notice, and the schedule as it was. Every branch below that would leave
 * one asks this first.
 */
function isTest(deps: ExecutorDeps): boolean {
  return deps.trigger === "test";
}

/** A cursor that has seen nothing — unlike `null`, which is a baseline run's. */
const NOTHING_SEEN: Cursor = { seenKeys: [], lastPublishedAt: null, etag: null, contentHash: null };

/** `claimItemKeys`, except that a test claims nothing the next real run will read. */
async function reserve(deps: ExecutorDeps, routineId: string, keys: string[]): Promise<string[]> {
  return isTest(deps) ? keys : claimItemKeys(deps.db, routineId, keys);
}

/** `releaseItemKeys`, for keys `reserve` took. A test took none. */
async function handBack(deps: ExecutorDeps, routineId: string, keys: string[]): Promise<void> {
  if (!isTest(deps)) await releaseItemKeys(deps.db, routineId, keys);
}

/**
 * Sends a run's result to its primary channel, and then to the others its
 * owner listed (`deliverToOtherChannels`, 0130), returning what the others
 * missed. A test sends nothing, and has no channel to send it to.
 */
async function deliverRun(
  routine: RoutineRow,
  deps: ExecutorDeps,
  primary: DeliveryChannel | null,
  message: { subject: string; body: string },
  context: DeliveryContext,
): Promise<string | undefined> {
  if (isTest(deps) || !primary) return undefined;
  await deliver(primary, message, deps.deliveryDeps, context);
  return deliverToOtherChannels(deps.env, deps.db, routine, message, deps.deliveryDeps, context);
}

export async function runRoutine(
  routine: RoutineRow,
  deps: ExecutorDeps,
  trigger?: IngestTrigger,
): Promise<RunResult> {
  const startedAt = deps.now();
  // Decided once, here, and written on every row this run produces — including
  // the ones that never reach a model — because "why did this run?" is asked of
  // a skipped row as often as of a delivered one.
  const origin = originOf(deps, trigger);
  let claimedKeys: string[] = [];
  let delivered = false;
  // Chosen before the turn rather than by the insert in `finish`, because a
  // browser task the turn starts has to name the run it answers before that
  // row exists (0100). Every branch writes its row with it.
  const runId = crypto.randomUUID();

  try {
    // Membership is checked before anything else. Removing someone from a
    // workspace cuts their RLS access instantly, but routines run under the
    // service role — without this an ex-member's routine keeps piping a
    // workspace agent's output to their personal Slack forever. Checked here
    // rather than in the member-removal handler so it holds however membership
    // ends (direct delete, workspace transfer, cascade).
    //
    // `role` as well as `user_id`, and the second column is not decoration.
    // Delivering is reading — a viewer may have a routine that mails them a
    // digest, and demoting somebody must not silently stop their mail. Filing
    // is WRITING: 0021 drew that line with `can_write_in_workspace`, and every
    // other write in the product is refused by RLS. This one cannot be, because
    // the executor holds the service role and RLS is not filtering it. So the
    // role is read here and the difference is applied below: a viewer's routine
    // keeps delivering and stops filing.
    const { data: membership, error: membershipError } = await deps.db
      .from("workspace_members")
      .select("user_id, role")
      .eq("workspace_id", routine.workspace_id)
      .eq("user_id", routine.user_id)
      .maybeSingle();

    if (membershipError) {
      throw new Error(`workspace membership lookup failed: ${membershipError.message}`);
    }
    if (!membership) {
      const reason = "the routine's owner is no longer a member of this workspace";
      await finish(routine, deps, startedAt, origin, {
        status: "skipped",
        itemsNew: 0,
        tokens: 0,
        error: reason,
        pause: reason,
      });
      return { status: "skipped", itemsNew: 0 };
    }

    // The agent has to be one its owner can still use (0104). Same reason as
    // membership above — the service role reads past the policy that hides
    // the routine from its owner once the agent stops being shared with them.
    //
    // Skipped WITHOUT a pause, and that is the difference from membership.
    // Losing an agent is undone by somebody sharing it again, and the routine
    // should simply be running again when that happens, not waiting for its
    // owner to find a switch on a screen that, until then, hid it from them.
    const access = await agentAccessFor(deps.db, routine.agent_id, routine.user_id);
    if (!access) {
      await finish(routine, deps, startedAt, origin, {
        status: "skipped",
        itemsNew: 0,
        tokens: 0,
        error: "the routine's agent is no longer shared with its owner",
      });
      return { status: "skipped", itemsNew: 0 };
    }

    // Credits are checked here — after membership, before anything is fetched
    // or claimed. It cannot move further down: past `claimItemKeys` a skipped
    // run leaves delivery keys reserved, and `claimItemKeys` only ever returns
    // newly-inserted ones, so those items could never be delivered again. The
    // cursor is deliberately left unadvanced, so once credits are added the run
    // picks up exactly what it would have reported. The routine's workspace
    // pays, whoever triggered it — a scheduled run has no caller at all.
    const verdict = await deps.entitlements.check(routine.workspace_id);
    const runEnv = deps.env;
    if (!verdict.allowed) {
      // Read before `finish` writes this run: the question is whether the
      // PREVIOUS one was also a quota skip.
      const alreadyTold = await lastRunWasQuotaSkip(deps.db, routine.id);
      await finish(routine, deps, startedAt, origin, {
        status: "skipped",
        itemsNew: 0,
        tokens: 0,
        error: QUOTA_SKIP_REASON,
      });
      if (!alreadyTold && !isTest(deps)) {
        await announceQuotaSkip(routine, deps);
      }
      return { status: "skipped", itemsNew: 0 };
    }

    // A `workspace` routine (0075) reads its own workspace, so none of the
    // fetch, diff, cursor or item machinery below applies to it — and its
    // summary is rendered in code rather than written by a model, so neither
    // does the summarise branch further down. It returns here, through
    // `finish`, like every other path.
    if (routine.source_kind === "workspace") {
      if (!deps.coverage) {
        // Loud, not silent. A cron Worker without this dep bound is a
        // deployment mistake, and a routine that quietly skips forever is the
        // failure this whole feature's pause machinery exists to avoid.
        await finish(routine, deps, startedAt, origin, {
          status: "failed",
          itemsNew: 0,
          tokens: 0,
          error: "this deployment cannot run a workspace report",
        });
        return { status: "failed", itemsNew: 0 };
      }

      // Claimed BEFORE the model call — covan-cloud#308. `claim_due_routines`
      // reclaims a routine whose `claimed_at` is stale (0055:82), so a worker
      // that dies between here and `finish` re-runs; `runOneRoutine` bypasses
      // claiming entirely by design, resting on exactly this backstop (see its
      // own docstring). Claimed after the call, as this branch was until
      // #308, a duplicate on an already-handled slot paid for one clustering
      // call before finding out. Claimed first, it costs nothing but the round
      // trip, which is what the `none` path below has always promised.
      //
      // The key shape is the `none` path's own (`keysToClaim`, below): no
      // cursor and no diff here either, so the run's identity is the trigger
      // that produced it, not anything about what was read.
      //
      // What a claim taken before the outcome is known means for each outcome:
      //
      //   * report — delivered, and the key stays: that is what it is for.
      //   * skip   — the key stays. A skip is this slot's answer, reached
      //     deliberately ("nothing to report", or the clustering ran and no
      //     topic cleared the floor); a duplicate that re-asked would pay to
      //     reach the same answer. The `none` path keeps its claims on a
      //     declined run for the same reason.
      //   * pause  — the key is handed back. A pause is not an answer for the
      //     slot but a refusal to run at all (the switch went off, the owner
      //     stopped being an admin, the workspace shrank to two), and the claim
      //     must not outlive it: a slot key is dead anyway once `finish`
      //     advances `next_run_at`, but a poke's key (`hook:`, `evt:`) is not, and a
      //     redelivery of that event after the routine is resumed would
      //     otherwise be refused as already handled.
      //   * throw  — the `catch` at the bottom of this function hands the key
      //     back, as it does on every path: `delivered` is still false.
      const reportKeysToClaim = trigger
        ? [pokeKey(trigger)]
        : deps.trigger === "manual"
          ? [`manual:${routine.id}@${startedAt.toISOString()}`]
          : [`slot:${routine.next_run_at}`];
      claimedKeys = await reserve(deps, routine.id, reportKeysToClaim);
      if (claimedKeys.length === 0) {
        // Already handled for this slot, and found out before anything was
        // spent — nothing to meter.
        await finish(routine, deps, startedAt, origin, {
          status: "skipped",
          itemsNew: 0,
          tokens: 0,
        });
        return { status: "skipped", itemsNew: 0 };
      }

      // The window is the routine's own period — covan-cloud#307. It was
      // seven days whatever the schedule said, so the weekly template was
      // right and an owner who edited it to daily got a daily email of the
      // same rolling week.
      const result = await deps.coverage(
        {
          workspaceId: routine.workspace_id,
          ownerId: routine.user_id,
          days: windowDays(routine.schedule_cron, routine.timezone, startedAt),
        },
        runEnv,
      );

      if (result.kind === "pause") {
        // Handed back before `finish`, so a release that fails lands in the
        // `catch` below — which tries again and records why — rather than
        // leaving a key held by a run that reports itself as a clean pause.
        await handBack(deps, routine.id, claimedKeys);
        claimedKeys = [];
        await finish(routine, deps, startedAt, origin, {
          status: "skipped",
          itemsNew: 0,
          tokens: 0,
          error: result.reason,
          pause: result.reason,
        });
        // Sent after `finish` commits, like `announceQuotaSkip` above and
        // `announcePause` itself (called from inside `finish`) — fix round 1,
        // finding B4. The pause must already be visible on the routine's page
        // before the owner is told about it, and `notifyOwner` swallows its
        // own errors, so there is nothing to lose by waiting for the write.
        //
        // None of this feature's three reasons is a repeated failure, so this
        // does not read through `announcePause` — see `announceCoveragePause`
        // for why that one's wording would be false here.
        if (!isTest(deps)) await announceCoveragePause(routine, deps, result.reason);
        return { status: "skipped", itemsNew: 0 };
      }

      if (result.kind === "skip") {
        // `model`/`tokens` are only present on the one skip that follows the
        // clustering call — see `CoverageRunResult`. Checking both narrows
        // both at once, which is what lets the branch below read them as
        // required rather than optional; the type does not say the two are
        // always set together, but `coverage-source.ts` guarantees they are.
        if (result.model !== undefined && result.tokens !== undefined) {
          await finish(routine, deps, startedAt, origin, {
            status: "skipped",
            itemsNew: 0,
            error: result.note,
            tokens: result.tokens,
            spend: result.spend ?? [],
            modelCall: { model: result.model, modelOutcome: "answered" },
          });
        } else {
          await finish(routine, deps, startedAt, origin, {
            status: "skipped",
            itemsNew: 0,
            tokens: 0,
            error: result.note,
          });
        }
        return { status: "skipped", itemsNew: 0 };
      }

      // `result.kind === "report"`, and this run holds the slot's key — it
      // was claimed above, before the model call (fix round 1, finding A3, and
      // covan-cloud#308).
      //
      // Delivered the same way every other routine is — the same channel
      // lookup, the same `deliver`, the same event — because nothing about
      // sending a message is specific to this source; only how the text was
      // produced is. Fix round 1, finding A4: this used to be a second,
      // uncommented copy of the ordinary path's lookup below; see
      // `loadDeliveryChannel` for why that was a real cost and not just
      // duplication.
      // A test has nowhere to send, and must not ask an address to confirm.
      const channel = isTest(deps) ? null : await loadDeliveryChannel(deps, routine);

      const deliveryNote = await deliverRun(
        routine,
        deps,
        channel,
        { subject: routine.name, body: result.summary },
        {
          event: EVENT_DELIVERED,
          routine: { id: routine.id, name: routine.name, agentId: routine.agent_id },
          run: {
            itemsNew: 1,
            itemsOverflow: 0,
            triggeredBy: origin.triggeredBy,
          },
          // The id its row is written with below, so an emailed report can be
          // answered (`lib/inbound-email/`); and, for a run answering a reply,
          // the thread that answer belongs in.
          runId,
          thread: trigger?.thread,
        },
      );
      delivered = true;

      await finish(routine, deps, startedAt, origin, {
        status: "ok",
        itemsNew: 1,
        summary: result.summary,
        deliveryNote,
        modelCall: { model: result.model, modelOutcome: "answered" },
        tokens: result.tokens,
        spend: result.spend,
        runId,
      });
      return { status: "ok", itemsNew: 1, summary: result.summary };
    }

    // A connection routine reads rows the reconciler already imported rather
    // than fetching anything itself — see `connection-source.ts` for why that
    // is the design and not a shortcut. Everything downstream is identical to a
    // feed's: the same diff, the same seen window, the same cap, the same
    // silent first run.
    let result: SourceResult;
    if (routine.source_kind === "connection") {
      result = {
        status: "items",
        items: await fetchConnectionItems(deps.db, {
          workspaceId: routine.workspace_id,
          connectionId: routine.source_config.connectionId,
        }),
        etag: null,
      };
    } else {
      // Rebuilt rather than passed through, so `SourceInput` keeps its narrower
      // union and `source.ts` stays what it is: the HTTP path, with the url
      // guard and the redirect loop that only an outbound fetch needs. A
      // connection reads the database and has no url to guard, and widening
      // that type to admit it would put a kind through a module with nothing
      // to do for it.
      result = await fetchSource(
        { source_kind: routine.source_kind, source_config: routine.source_config },
        // A test asks for the page whole: an ETag from the last real run
        // would answer "unchanged", and a test has to read something.
        isTest(deps) ? null : routine.cursor,
        deps.fetchDeps,
      );
    }

    if (result.status === "unchanged") {
      await finish(routine, deps, startedAt, origin, { status: "skipped", itemsNew: 0, tokens: 0 });
      return { status: "skipped", itemsNew: 0 };
    }

    let items: FeedItem[] = [];
    let pageText: string | undefined;
    let nextCursor: Cursor;
    // Every kind gets an idempotency key, not just rss. routine_deliveries'
    // unique constraint is then the backstop for a run that overruns the
    // stale-claim window or fails between delivering and recording.
    let keysToClaim: string[] = [];
    /**
     * New entries this run saw and will not deliver, dropped by the per-run cap.
     *
     * Recorded rather than discarded because they are not deferred, they are
     * gone: `diffItems` marks everything it saw as seen, including these, so a
     * busy feed's overflow is never delivered on a later run. `diffItems` has
     * always returned this number and this file used to throw it away, which
     * made a documented behaviour invisible in the two places somebody would
     * look for it — the message, and the run history.
     */
    let overflow = 0;

    const diffed = routine.source_kind === "rss" || routine.source_kind === "connection";

    if (result.status === "items" && diffed) {
      // A test reads the feed as if it had seen none of it — not as a first
      // run, which reports nothing — so it has something to show even when
      // nothing is new since the last real run.
      const diff = diffItems(result.items, isTest(deps) ? NOTHING_SEEN : routine.cursor);
      items = diff.newItems;
      overflow = diff.overflow;
      nextCursor = { ...diff.nextCursor, etag: result.etag };
      keysToClaim = items.map((i) => i.key);
    } else if (result.status === "content") {
      const baseline: Cursor = {
        seenKeys: routine.cursor?.seenKeys ?? [],
        lastPublishedAt: routine.cursor?.lastPublishedAt ?? null,
        etag: result.etag,
        contentHash: result.hash,
      };

      // First run is silent for source-watching routines: with no cursor there
      // is nothing to compare against, so record the hash and say nothing
      // rather than summarising the whole page at the user.
      if (routine.cursor === null && !isTest(deps)) {
        await finish(routine, deps, startedAt, origin, {
          status: "skipped",
          itemsNew: 0,
          tokens: 0,
          cursor: baseline,
        });
        return { status: "skipped", itemsNew: 0 };
      }

      pageText = result.text;
      nextCursor = baseline;
      // Hash *and* slot. The hash alone is a content identity, and nothing
      // prunes routine_deliveries, so a page that oscillates A→B→A→B would
      // report each state once and then go quiet forever — a status page
      // flipping between "operational" and "degraded" would stop telling
      // anyone. Composing with the slot still dedupes the case the backstop
      // exists for: a retry after failed bookkeeping runs against an
      // unadvanced next_run_at, so it lands in the same slot with the same key.
      keysToClaim =
        deps.trigger === "manual"
          ? [`hash:${result.hash}@manual:${startedAt.toISOString()}`]
          : [`hash:${result.hash}@${routine.next_run_at}`];
    } else {
      // source_kind === "none": nothing to diff, so it always runs — including
      // the first time. The scheduled slot is its identity, so two runs that
      // claim the same slot collide instead of double-delivering.
      nextCursor = routine.cursor ?? {
        seenKeys: [],
        lastPublishedAt: null,
        etag: null,
        contentHash: null,
      };
      // A poke is identified by the sender's event id rather than by a clock
      // slot. Two deliveries of one event collide on `routine_deliveries`'
      // unique constraint and the second is a no-op — and because the claim
      // happens before the channel lookup and before the model call, a repeat
      // costs nothing but the round trip. A slot key would be wrong twice over
      // here: two different events inside one scheduled slot would collide
      // with each other, and a retry of one event across a slot boundary
      // would not collide at all.
      //
      // A manual run is on-demand: it uses a timestamped manual key so it
      // neither collides with a previous manual run nor consumes the future
      // scheduled slot.
      keysToClaim = trigger
        ? [pokeKey(trigger)]
        : deps.trigger === "manual"
          ? [`manual:${routine.id}@${startedAt.toISOString()}`]
          : [`slot:${routine.next_run_at}`];
    }

    const hasWork = routine.source_kind === "none" || items.length > 0 || pageText !== undefined;
    if (!hasWork) {
      await finish(routine, deps, startedAt, origin, {
        status: "skipped",
        itemsNew: 0,
        tokens: 0,
        cursor: nextCursor,
      });
      return { status: "skipped", itemsNew: 0 };
    }

    // Reserve before sending. A concurrent or retried run gets back fewer keys.
    claimedKeys = await reserve(deps, routine.id, keysToClaim);
    if (diffed) {
      items = items.filter((i) => claimedKeys.includes(i.key));
    }
    if (claimedKeys.length === 0) {
      await finish(routine, deps, startedAt, origin, {
        status: "skipped",
        itemsNew: 0,
        tokens: 0,
        cursor: nextCursor,
      });
      return { status: "skipped", itemsNew: 0 };
    }

    // Checked before summarising: a routine with a missing channel shouldn't
    // pay for an LLM call it can never deliver. Scoping is `loadDeliveryChannel`'s
    // own comment now (fix round 1, finding A4) — the agent lookup just below
    // still needs its own: it is scoped to the routine's workspace rather than
    // its owner, and matching on id alone would make any tampered row a
    // cross-tenant read there too.
    const channel = isTest(deps) ? null : await loadDeliveryChannel(deps, routine);

    const { data: agent, error: agentError } = await deps.db
      .from("agents")
      .select("persona, model, temperature, reasoning_effort")
      .eq("id", routine.agent_id)
      .eq("workspace_id", routine.workspace_id)
      // Service-role client, so RLS is not filtering this. `claim_due_routines`
      // already skips routines marked by their agent's deletion and this should
      // therefore be unreachable — it is written because "should be
      // unreachable" is how a deleted agent's persona ends up in a Slack
      // message some Tuesday.
      .is("deleted_at", null)
      .maybeSingle();

    if (agentError) throw new Error(`agent lookup failed: ${agentError.message}`);

    // What the agent already knows, retrieved for this run.
    //
    // Placed here deliberately: after the quota check, after the run has
    // established it has something to report, and after the delivery channel
    // has been shown to exist — so a tick that will send nothing does not pay
    // to embed a query, which on a healthy feed is most ticks.
    //
    // Best-effort, for the reason `retrieval.ts` gives about a chat turn: an
    // ungrounded answer beats no answer. That module already falls back to
    // persona-only on its own failures, so reaching this catch means something
    // further out broke — and a digest that arrives without the handbook is
    // still worth more to the reader than a run that failed.
    let ragBlock = "";
    let embeddingTokens = 0;
    try {
      const retrieved = await deps.retrieve(
        {
          agentId: routine.agent_id,
          query: retrievalQueryFor(routine.instruction, items, pageText),
          scope: knowledgeScopeOf(routine),
        },
        runEnv,
      );
      ragBlock = retrieved.ragBlock;
      embeddingTokens = retrieved.embeddingTokens;
    } catch (err) {
      console.error("routine retrieval failed (continuing persona-only)", err);
    }

    const summariseInput = {
      persona: agent?.persona ?? null,
      // The routine's own choice first (0123), then the agent's.
      model: routine.model ?? agent?.model ?? null,
      temperature: agent?.temperature ?? null,
      reasoningEffort: routine.reasoning_effort ?? agent?.reasoning_effort ?? null,
      instruction: routine.instruction,
      items,
      pageText,
      payloadText: trigger?.payload,
      payloadLabel: trigger?.label,
      ragBlock,
      // A scheduled prompt has no source, so there is nothing for its output
      // to be irrelevant to — and one `false` would silence it permanently.
      // Everything that watches something may decline.
      //
      // A poked run may, even though its source_kind is `none`: it *does*
      // have material to be irrelevant to — the payload that arrived — and
      // the thing a webhook routine is most often asked to do is stay quiet
      // unless what came in matters.
      mayDecline: routine.source_kind !== "none" || trigger !== undefined,
      timezone: routine.timezone,
      // Only for a routine that ends. A standing order has no position, and a
      // line claiming one would be a fact the model invents a meaning for.
      //
      // `!=`, not `!==`, deliberately: `ingest.ts` builds a routine row
      // through a cast, so a select path that forgot this column yields
      // `undefined` rather than `null` for it (see `output_bundle_id`'s
      // comment above, on the same type, for the same optional-vs-nullable
      // point). Loose equality degrades that to "unbounded" — no position
      // at all — instead of `{ done, total: undefined }`, which would be a
      // position claiming a number the model would have to invent a meaning
      // for.
      runPosition:
        routine.ends_after_runs != null
          ? { done: routine.runs_done, total: routine.ends_after_runs }
          : undefined,
    };

    // The branch, and the whole of §D. A workspace with something for a tool
    // to point at runs the agent loop; everything else runs the single call
    // it always ran. `runWithTools` answers `null` for the second case, so
    // the question is asked once rather than twice.
    const browser = browserFor(routine, deps);
    // The routine's or its agent's own endpoint (0135): the run's completions
    // go there; its retrieval above stayed on the install's embeddings.
    const modelEnv = await withModelEndpoint(
      runEnv,
      deps.db,
      routine.workspace_id,
      summariseInput.model,
    );
    const summary =
      (await deps.runWithTools?.(
        {
          ...summariseInput,
          agentId: routine.agent_id,
          workspaceId: routine.workspace_id,
          userId: routine.user_id,
          routineRunId: runId,
          knowledgeScope: knowledgeScopeOf(routine),
          ...(browser ? { browser } : {}),
          ...(trigger?.depth ? { chainDepth: trigger.depth } : {}),
        },
        modelEnv,
      )) ?? (await deps.summarise(summariseInput, modelEnv));

    // The model read what arrived and judged none of it to be what was asked
    // for. This is a working run, not a failure and not an empty source: the
    // entries were real, they were read, and the answer was no.
    //
    // The cursor advances and the delivery claims stay, both deliberately. A
    // rejected entry has been judged; offering it again next run would spend
    // another model call to reach the same answer, and on a busy feed that is
    // most of the bill.
    if (summary.declined) {
      await finish(routine, deps, startedAt, origin, {
        status: "skipped",
        // What it read before deciding. Zero here would be indistinguishable
        // from a feed that had not moved, which is the question this number is
        // on the row to answer.
        itemsNew: items.length,
        itemsOverflow: overflow,
        tokens: summary.tokens,
        spend: [
          ...summary.spend,
          ...spends(
            embeddingSpend(
              embeddingModel(runEnv as { EMBEDDING_MODEL?: string }),
              embeddingTokens,
              "retrieval",
            ),
          ),
        ],
        cursor: nextCursor,
        error: NOTHING_RELEVANT_REASON,
        // A declined run made the call — two of them, in fact, since the
        // decision is a turn of its own. The columns describe the request, not
        // the delivery, so a `skipped` run that spent real money still says
        // which model spent it.
        modelCall: { model: summary.model, modelOutcome: summary.modelOutcome },
      });
      return { status: "skipped", itemsNew: 0 };
    }

    // What is sent and, if this routine files, what is kept — the same text,
    // overflow note included. A digest that was missing thirty entries is still
    // missing them a year later, and a filed copy that quietly dropped the
    // sentence saying so would be the more complete-looking of the two.
    const body = withOverflowNote(summary.text, overflow);

    /**
     * The turn started browser work that has not answered yet (0100). The
     * report is written down as a draft, nothing is sent, and
     * `lib/routines/held.ts` sends it once — with the answers in it — when
     * the last task settles, or after `HELD_MAX_MS` with what it has.
     *
     * Everything else is this run finishing as usual: the cursor advances,
     * the claims stay claimed (the report is coming; releasing them would
     * have the next run report the same entries again), the turn's spend is
     * charged, and the schedule moves on. Only a delivered run counts towards
     * a series, so `runs_done` waits for the send.
     */
    const heldFor = "heldFor" in summary ? (summary.heldFor as string[] | undefined) : undefined;
    if (heldFor && heldFor.length > 0) {
      await finish(routine, deps, startedAt, origin, {
        runId,
        status: "waiting",
        itemsNew: items.length,
        itemsOverflow: overflow,
        modelCall: { model: summary.model, modelOutcome: summary.modelOutcome },
        tokens: summary.tokens,
        spend: [
          ...summary.spend,
          ...spends(
            embeddingSpend(
              embeddingModel(runEnv as { EMBEDDING_MODEL?: string }),
              embeddingTokens,
              "retrieval",
            ),
          ),
        ],
        cursor: nextCursor,
        summary: body,
      });
      // Only once the row exists: a report nothing records can never be sent,
      // so a failure above hands the claims back for the next run instead.
      delivered = true;
      // In case every task answered before the row above existed.
      await deps.completeHeld?.(runId);
      return { status: "waiting", itemsNew: items.length };
    }

    const deliveryNote = await deliverRun(
      routine,
      deps,
      channel,
      { subject: routine.name, body },
      {
        event: EVENT_DELIVERED,
        routine: { id: routine.id, name: routine.name, agentId: routine.agent_id },
        // `items.length` rather than the claimed keys: what the summary is
        // about. `overflow` is what it is missing, which is the number a
        // receiver needs to know the digest is not the whole story.
        run: {
          itemsNew: items.length,
          itemsOverflow: overflow,
          // A poke names itself, whatever the dispatcher was built as.
          triggeredBy: origin.triggeredBy,
        },
        runId,
        thread: trigger?.thread,
      },
    );
    // Past this point the message is out. Releasing the claims would let the
    // next tick re-win them and send it again — the duplicate this whole
    // claim-first ordering exists to prevent. Leaving them claimed makes the
    // retry a no-op that simply advances the cursor.
    delivered = true;

    // Filing happens after the message is out and before the bookkeeping, and
    // it cannot fail the run. `fileOutput` returns a note instead of throwing;
    // the note reaches `routine_runs.filing_note`, where somebody looking at a
    // run that says "Sent" and shows no document can read why.
    const filing = await fileOutput(routine, deps, runEnv, {
      ownerMayWrite: membership.role !== "viewer",
      summary: body,
      at: startedAt,
    });

    await finish(routine, deps, startedAt, origin, {
      runId,
      status: "ok",
      itemsNew: items.length,
      itemsOverflow: overflow,
      deliveryNote,
      documentId: filing.documentId,
      filingNote: filing.note,
      modelCall: { model: summary.model, modelOutcome: summary.modelOutcome },
      // One ledger write for the run, so the embeddings this run paid for are
      // charged with the completion rather than in a second place that a later
      // change could forget. `filing.indexTokens` joins them for the same
      // reason: filing buys embeddings too. `tokens` stays the model's count,
      // which is what the run history shows.
      tokens: summary.tokens,
      spend: [
        ...summary.spend,
        ...spends(
          embeddingSpend(
            embeddingModel(runEnv as { EMBEDDING_MODEL?: string }),
            embeddingTokens,
            "retrieval",
          ),
          embeddingSpend(
            embeddingModel(runEnv as { EMBEDDING_MODEL?: string }),
            filing.indexTokens,
            "index",
          ),
        ),
      ],
      cursor: nextCursor,
      summary: summary.text,
    });
    return { status: "ok", itemsNew: items.length, summary: body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isProviderError(err)) await reportProviderFailure(deps.env, classifyProviderError(err));

    // Hand back anything reserved but *not sent*, so the next run retries it.
    // `delivered` is the whole point: once the message is out, a failure in the
    // bookkeeping that follows must not hand the keys back, or the re-claimed
    // routine sends the same summary a second time. If the release itself fails
    // those keys stay claimed and their items can never be delivered again —
    // claimItemKeys only ever returns newly-inserted keys — so that has to reach
    // routine_runs rather than vanish.
    let releaseError: string | null = null;
    if (!delivered && claimedKeys.length > 0) {
      try {
        await handBack(deps, routine.id, claimedKeys);
      } catch (releaseErr) {
        releaseError = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
      }
    }

    const recorded = releaseError
      ? `${message} (${claimedKeys.length} delivery claims could not be released: ${releaseError})`
      : message;

    try {
      await finish(routine, deps, startedAt, origin, {
        status: "failed",
        itemsNew: 0,
        tokens: 0,
        error: recorded,
        transient: transientFailure(err),
      });
    } catch {
      // Recording the failure failed too. Clear the claim on its own so the row
      // retries at its next due time instead of waiting out the stale-claim
      // window in claim_due_routines.
      try {
        const { error } = await deps.db
          .from("routines")
          .update({ claimed_at: null })
          .eq("id", routine.id);
        if (error) throw new Error(error.message);
      } catch {
        // Nothing left to try; the stale-claim reclaim is the backstop.
      }
    }

    return { status: "failed", itemsNew: 0 };
  }
}

/**
 * What `browse` may do on this run, or nothing — the routine's `browser_access`
 * (0100), read off the row and never from the model. The conversation is
 * opened only when a task first needs it, so a run that allows the browser and
 * does not use it opens nothing.
 */
function browserFor(
  routine: RoutineRow,
  deps: ExecutorDeps,
): Omit<RoutineBrowser, "started"> | undefined {
  if (isTest(deps)) return undefined;
  const access = routine.browser_access ?? "off";
  if (access === "off" || access === null) return undefined;
  if (access === "site" && !routine.browser_site) return undefined;
  return {
    access,
    site: access === "site" ? (routine.browser_site ?? null) : null,
    conversation: () => openRoutineConversation(deps.db, routine),
  };
}

/**
 * The delivery channel a run sends to.
 *
 * SCOPING: the service role bypasses RLS, so this lookup is scoped explicitly
 * from the routine row rather than on id alone — matching on id alone would
 * make any tampered row a cross-tenant read.
 *
 * Fix round 1, finding A4. Shared by the two paths that need a channel before
 * sending — the ordinary summarise path and the workspace report path — which
 * used to copy this query and both its guards byte for byte, with this
 * comment attached to only one of the two copies. The two sites differ in
 * what they do with the result next (one also reads an agent afterward),
 * which is an argument for extracting the lookup alone, not for leaving it
 * duplicated.
 */
async function loadDeliveryChannel(
  deps: ExecutorDeps,
  routine: RoutineRow,
): Promise<DeliveryChannel> {
  const { data: channel, error } = await deps.db
    .from("delivery_channels")
    .select(`${CONFIRMABLE_COLUMNS}, disabled_at`)
    .eq("id", routine.delivery_channel_id)
    .eq("user_id", routine.user_id)
    .maybeSingle();
  if (error) throw new Error(`delivery channel lookup failed: ${error.message}`);
  if (!channel) throw new Error("delivery channel missing");
  // Revoking the key that made it disabled it (0088), and the routine was
  // paused in the same statement. Reaching here means somebody resumed the
  // routine without choosing another channel; the destination is still one a
  // revoked key picked.
  if (channel.disabled_at) {
    throw new Error("delivery channel disabled: the API key that set it up was revoked");
  }
  // An email address that has not agreed to these messages is asked here, or
  // confirmed on the spot if it is the owner's own; `deliver` refuses it
  // otherwise, and that refusal is the run's failure, in words.
  return readyForDelivery(deps.env, channel as ConfirmableChannel);
}

/**
 * Files a delivered summary, if this routine files anything and this Worker can.
 *
 * Returns rather than throws, in every branch, and that is the whole design.
 * The message has already gone out by the time this is called. An exception
 * here would be caught by `runRoutine`, recorded as a failure, backed off
 * geometrically and at `MAX_FAILURES` would pause a routine that is delivering
 * perfectly — for the sake of an optional extra. Every way this can go wrong is
 * therefore a sentence, written to the run, where a person will read it.
 *
 * The three refusals, in the order they are asked:
 *
 *   1. The routine files nothing. No note: there is nothing to explain.
 *   2. This Worker has no document store. Not the owner's doing and not a
 *      fault — see `canFileDocuments` for why the cron Worker is routinely in
 *      this state — so it says which deployment is missing what.
 *   3. The owner is a viewer. Delivering is reading and filing is writing; the
 *      service role would happily do both, and this is the only thing standing
 *      where RLS normally stands.
 */
async function fileOutput(
  routine: RoutineRow,
  deps: ExecutorDeps,
  runEnv: RoutineEnv,
  input: { ownerMayWrite: boolean; summary: string; at: Date },
): Promise<{ documentId?: string; note?: string; indexTokens: number }> {
  // A test files nothing: its result is its owner's private thread (0130).
  if (isTest(deps)) return { indexTokens: 0 };
  if (!routine.output_bundle_id) return { indexTokens: 0 };
  if (!deps.file) return { note: NOTE_NO_DOCUMENT_STORE, indexTokens: 0 };
  if (!input.ownerMayWrite) return { note: NOTE_VIEWER, indexTokens: 0 };

  try {
    const result = await deps.file(
      {
        routineId: routine.id,
        routineName: routine.name,
        workspaceId: routine.workspace_id,
        bundleId: routine.output_bundle_id,
        // 0056 defaults the column and bounds it; this only covers a row read
        // through a projection that did not select it.
        retention: routine.output_retention ?? 52,
        summary: input.summary,
        at: input.at,
      },
      runEnv,
    );
    return result.filed
      ? { documentId: result.documentId, indexTokens: result.indexTokens }
      : { note: result.note, indexTokens: 0 };
  } catch (err) {
    // `fileRoutineOutput` is documented never to throw. This catch is for the
    // injected dependency rather than for that one: a test double, or a future
    // implementation that forgets the contract, must not be able to turn a
    // delivered run into a failed one.
    return {
      note: `not filed: ${err instanceof Error ? err.message : String(err)}`,
      indexTokens: 0,
    };
  }
}

/**
 * Writes the run row and the routine's next state. A failure backs the interval
 * off geometrically and, at MAX_FAILURES, pauses with a reason — a routine that
 * dies quietly while the UI still says "active" is the failure that destroys
 * trust in this feature.
 */
/**
 * What a run turned out to be.
 *
 * Split into a common half and a discriminated one so the money question cannot
 * be answered by omission. A branch that can have spent is *required* to say
 * what it spent (`spend`), so a future caller that forgets does not compile —
 * and a skipped or failed run that wanted to report a spend would have to
 * become one of the spending branches first.
 */
export type RunOutcome = {
  /**
   * The id the run's row is written with, when the run chose one first —
   * the agent path does, so a browser task can name the run it answers.
   * Absent lets Postgres choose, which every other branch does.
   */
  runId?: string;
  itemsNew: number;
  /** New entries the per-run cap declined. Only a run that delivered has any. */
  itemsOverflow?: number;
  cursor?: Cursor;
  error?: string;
  /** What was delivered. Absent for skipped and failed runs, which sent nothing. */
  summary?: string;
  /** The document this run filed, when it filed one. */
  documentId?: string;
  /** Why it filed nothing, when it was supposed to. See `fileOutput`. */
  filingNote?: string;
  /** What the routine's other channels missed (0130). See `deliverToOtherChannels`. */
  deliveryNote?: string;
  /** The remote's fault, not the routine's — judged against the higher limit. */
  transient?: boolean;
  /** Pause the routine with this reason, independently of the failure count. */
  pause?: string;
  /**
   * The model call this run made, when it made one.
   *
   * Absent on every branch that never reached a model — a feed that had not
   * moved, credits already spent, an upstream that failed before the
   * request. Absent means null in both columns, which is the truth rather than
   * a default: there is no model and no outcome for a request nobody sent.
   */
  modelCall?: ModelCall;
} & (
  | {
      status: "ok";
      tokens: number;
      /**
       * What was consumed, which is what the ledger is charged. `tokens` stays
       * the record of how many moved, and the run history shows that one.
       * Required, and that is the point.
       */
      spend: Spend[];
    }
  | {
      /**
       * A run that paid for a model call and then decided not to send.
       *
       * It is not an `"ok"` run — nothing was delivered — and it is not free
       * either, so it says what it spent. This branch exists so that widening
       * "skipped" to admit a spend could not be done without also saying so:
       * `spend` is required here for the same reason it is required above.
       */
      status: "skipped";
      tokens: number;
      spend: Spend[];
    }
  | {
      /**
       * A run whose report waits on its browser (0100). It spent what the
       * turn spent, and says so, for the reason `"ok"` does.
       */
      status: "waiting";
      tokens: number;
      spend: Spend[];
    }
  | { status: "skipped" | "failed"; tokens: 0; spend?: undefined }
);

async function finish(
  routine: RoutineRow,
  deps: ExecutorDeps,
  startedAt: Date,
  origin: RunOrigin,
  outcome: RunOutcome,
): Promise<void> {
  const finishedAt = deps.now();

  // postgrest-js resolves { data, error }; it does not throw. An unchecked
  // insert here would drop run history silently, and an unchecked update below
  // would leave claimed_at set with next_run_at and the cursor unadvanced —
  // which for a web or none routine means re-delivering the same content on
  // every tick. Both have to be loud.
  // The thread this run is shown in, written first so the run can name it
  // (0123). Null when the routine does not deliver to the Inbox, or the run
  // has nothing to show.
  const sessionId = await writeRunThread(routine, deps, outcome, finishedAt);
  const split = completionTokensOf(outcome);

  const { data: runRows, error: runError } = await deps.db
    .from("routine_runs")
    .insert({
      ...(outcome.runId ? { id: outcome.runId } : {}),
      routine_id: routine.id,
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      status: outcome.status,
      // What the run delivered, and — separately — what the model did. See 0070
      // for why these are two columns: `status` answers "did my routine send
      // anything?" for a person reading the history, and these answer "and what
      // happened to the request", which a run can get wrong while still
      // delivering. Null together, from one optional field, so a branch cannot
      // record one and forget the other.
      model: outcome.modelCall?.model ?? null,
      outcome: outcome.modelCall?.modelOutcome ?? null,
      items_new: outcome.itemsNew,
      items_overflow: outcome.itemsOverflow ?? 0,
      tokens: outcome.tokens,
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      error: outcome.error ?? null,
      summary: outcome.summary ?? null,
      document_id: outcome.documentId ?? null,
      filing_note: outcome.filingNote ?? null,
      delivery_note: outcome.deliveryNote ?? null,
      // Priced from these apart (0130); `tokens` stays the total it always was.
      prompt_tokens: split.promptTokens,
      completion_tokens: split.completionTokens,
      cached_tokens: split.cachedTokens,
      // Why this run happened at all (0109). A required argument rather than
      // something read off `deps`, so a new branch that forgets it does not
      // compile instead of quietly recording an event run as scheduled.
      triggered_by: origin.triggeredBy,
      trigger_label: origin.label,
      session_id: sessionId,
    })
    // The id is what the ledger files this run's charge against.
    .select("id");
  if (runError) throw new Error(`routine_runs insert failed: ${runError.message}`);
  const runId = (Array.isArray(runRows) ? runRows[0]?.id : undefined) as string | undefined;

  // Charged to the routine's workspace, not to whoever happened to trigger it
  // — a scheduled run has no caller at all. Best-effort: the run is finished
  // and delivered, and `routine_runs.tokens` above is the durable record, so a
  // ledger that cannot be written must not turn a successful run into a failed
  // one that retries and pays twice.
  //
  // Not keyed on `status === "ok"`. A run that paid for a model call and then
  // declined to send is a skipped run that spent real money, and charging it
  // as if it were free would make a filtered routine free to run.
  if (outcome.spend && outcome.spend.length > 0) {
    try {
      await deps.entitlements.record(routine.workspace_id, outcome.spend, {
        userId: routine.user_id,
        routineRunId: runId,
      });
    } catch (err) {
      console.error("failed to record routine credits", err);
    }
  }

  // A test leaves the routine as it found it: no next run, no failure counted,
  // no cursor, no series spent (0130).
  if (isTest(deps)) return;

  const failures = outcome.status === "failed" ? routine.consecutive_failures + 1 : 0;
  const base = nextRunAt(routine.schedule_cron, routine.timezone, finishedAt);
  const naturalDelay = base.getTime() - finishedAt.getTime();
  const multiplier = failures > 0 ? 2 ** (failures - 1) : 1;
  // Geometric backoff, but never more than six hours past the natural next run —
  // otherwise a failing daily routine drifts days into the future.
  const delay = Math.min(naturalDelay * multiplier, naturalDelay + MAX_BACKOFF_MS);
  const next = new Date(finishedAt.getTime() + delay);

  const patch: Record<string, unknown> = {
    last_run_at: finishedAt.toISOString(),
    next_run_at: next.toISOString(),
    claimed_at: null,
    consecutive_failures: failures,
    updated_at: finishedAt.toISOString(),
  };
  if (outcome.cursor) patch.cursor = outcome.cursor;

  const limit = outcome.transient ? MAX_TRANSIENT_FAILURES : MAX_FAILURES;
  // Only a pause reached this way is worth telling the owner about. The
  // membership pause below is deliberate — we are cutting off an ex-member, not
  // reporting a fault to them.
  const pausedByFailures = failures >= limit;
  if (pausedByFailures) {
    patch.status = "paused";
    patch.paused_reason = outcome.error ?? "repeated failures";
  }
  if (outcome.pause) {
    patch.status = "paused";
    patch.paused_reason = outcome.pause;
  }

  /**
   * A series spends a morning only when it delivered one.
   *
   * Guarded on `status === "ok"` and not on "did this run at all", which is the
   * whole content of 0074's `runs_done`: a week of a dead delivery channel would
   * otherwise complete a seven-morning series that nobody ever read, and leave
   * the routine saying "Finished".
   *
   * Deliberately NOT the rule the quota block above uses. That one is keyed on
   * tokens having been spent, because a declined run costs real money and must
   * be billed; this one is keyed on something having arrived, because a
   * declined run delivered nothing. Two different questions about the same
   * run, and the comment above says so for its own.
   *
   * A manual "Run now" counts the same as a scheduled tick: it delivers, and
   * the spec's rule is "only a delivered run increments" — nothing here asks
   * who or what started the run. The visible consequence is that pressing it
   * on a seven-morning series finishes the series one calendar day sooner,
   * with all seven pieces still delivered in order.
   *
   * Last, so a pause set by either branch above wins — *if* one is ever set
   * on an `"ok"` outcome. Nothing today does: `pausedByFailures` requires
   * `status === "failed"`, and the one call site that sets `outcome.pause`
   * always pairs it with `status: "skipped"`. So the `patch.status ===
   * undefined` check below is forward protection for a pause path that does
   * not exist yet, not a condition exercised by any test — written so that if
   * one is ever added, "delivered and then found a reason to stop" still
   * reads as stopped rather than as a finished series.
   */
  if (routine.ends_after_runs != null && outcome.status === "ok") {
    const done = routine.runs_done + 1;
    patch.runs_done = done;
    if (done >= routine.ends_after_runs && patch.status === undefined) {
      patch.status = "completed";
    }
  }

  const { error: updateError } = await deps.db.from("routines").update(patch).eq("id", routine.id);
  if (updateError) throw new Error(`routines update failed: ${updateError.message}`);

  if (pausedByFailures) {
    await announcePause(routine, deps, String(patch.paused_reason));
  } else if (outcome.status === "failed" && routine.consecutive_failures === 0) {
    // The first failure in a row, and only that one: a routine that keeps
    // failing is one email, and pausing is announced on its own above.
    await announceFailure(routine, deps, outcome.error ?? "something went wrong");
  }
}

/**
 * "A routine fails" (A16): an email to the owner's own address, if they
 * have not turned it off. Best-effort, for `notifyOwner`'s reason.
 */
async function announceFailure(
  routine: RoutineRow,
  deps: ExecutorDeps,
  error: string,
): Promise<void> {
  try {
    const mail = deps.mail === undefined ? mailerFrom(deps.env) : deps.mail;
    if (!mail) return;
    if (!(await wantsNotice(deps.db, routine.user_id, "routine_failed"))) return;
    const { data } = await deps.db.auth.admin.getUserById(routine.user_id);
    const email = data?.user?.email;
    if (!email) return;
    await mail(
      routineFailedEmail({
        email,
        routineName: routine.name,
        error,
        url: `${appUrlFrom(deps.env as { ALLOWED_ORIGIN?: string })}/routines/${routine.id}`,
      }),
    );
  } catch (err) {
    console.error("routine: the failure email did not go", err);
  }
}

/** How many run threads a routine keeps; older ones nobody replied in go. */
export const RUN_THREADS_KEPT = 20;

/**
 * One run as a thread in the Inbox (0123, reversing 0070 per routine).
 *
 * A delivered run reads as its report; a failed one says it failed and why,
 * which is what puts it in the owner's Needs you. A skipped run delivered
 * nothing and leaves nothing. The reply carries the model and the tokens the
 * run spent, so the usage figures read from replies (0124) see routine work
 * too.
 *
 * Best-effort: the run is already done and delivered, and a thread that
 * cannot be written must not fail it. Old run threads are pruned to the
 * newest `RUN_THREADS_KEPT`, never one somebody has replied in.
 */
export async function writeRunThread(
  routine: RoutineRow,
  deps: ExecutorDeps,
  outcome: RunOutcome,
  finishedAt: Date,
): Promise<string | null> {
  // A test's thread is the only place its result goes, so it is written
  // whether or not the routine delivers to the Inbox — and for a skip too,
  // which would otherwise be a button that seemed to do nothing.
  const test = isTest(deps);
  if (routine.deliver_inbox === false && !test) return null;
  const content =
    outcome.status === "ok"
      ? outcome.summary?.trim()
      : outcome.status === "failed"
        ? `This ${test ? "test" : "run"} failed: ${outcome.error ?? "something went wrong"}`
        : test
          ? `This test had nothing to report${outcome.error ? `: ${outcome.error}` : "."}`
          : undefined;
  if (!content) return null;

  try {
    const { data: session, error: sessionError } = await deps.db
      .from("chat_sessions")
      .insert({
        agent_id: routine.agent_id,
        user_id: routine.user_id,
        workspace_id: routine.workspace_id,
        kind: "routine",
        routine_id: routine.id,
        visibility: !test && routine.visibility === "shared" ? "shared" : "private",
        title: test ? `${routine.name} · test` : routine.name,
      })
      .select("id")
      .single();
    if (sessionError || !session) {
      console.error("routine: could not open the run's thread", sessionError);
      return null;
    }
    const sessionId = session.id as string;

    const tokens = completionTokensOf(outcome);
    const { error: messageError } = await deps.db.from("messages").insert({
      session_id: sessionId,
      role: "assistant",
      content,
      sender_id: null,
      created_at: finishedAt.toISOString(),
      model: outcome.modelCall?.model ?? tokens.model ?? null,
      prompt_tokens: tokens.promptTokens,
      completion_tokens: tokens.completionTokens,
      cached_tokens: tokens.cachedTokens,
      outcome: "answered",
    });
    if (messageError) console.error("routine: could not write the run's reply", messageError);

    await pruneRunThreads(deps.db, routine.id);
    return sessionId;
  } catch (err) {
    console.error("routine: could not write the run's thread", err);
    return null;
  }
}

/** The completion tokens a run spent, summed, for the reply that shows it. */
function completionTokensOf(outcome: RunOutcome): {
  model: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  cachedTokens: number | null;
} {
  const spent = "spend" in outcome ? (outcome.spend ?? []) : [];
  let model: string | null = null;
  let prompt = 0;
  let completion = 0;
  let cached = 0;
  let any = false;
  for (const s of spent) {
    if (s.kind !== "completion") continue;
    any = true;
    model = model ?? s.model;
    prompt += s.promptTokens;
    completion += s.completionTokens;
    cached += s.cachedTokens ?? 0;
  }
  return any
    ? { model, promptTokens: prompt, completionTokens: completion, cachedTokens: cached }
    : { model: null, promptTokens: null, completionTokens: null, cachedTokens: null };
}

async function pruneRunThreads(db: SupabaseClient, routineId: string): Promise<void> {
  const { data, error } = await db
    .from("chat_sessions")
    .select("id")
    .eq("routine_id", routineId)
    .eq("kind", "routine")
    .order("created_at", { ascending: false })
    .range(RUN_THREADS_KEPT, RUN_THREADS_KEPT + 49);
  if (error || !data || data.length === 0) return;
  const old = data.map((r) => r.id as string);
  // Kept: any thread somebody wrote in, which is a conversation now.
  const { data: replied } = await db
    .from("messages")
    .select("session_id")
    .in("session_id", old)
    .eq("role", "user");
  const keep = new Set((replied ?? []).map((r) => r.session_id as string));
  const gone = old.filter((id) => !keep.has(id));
  if (gone.length === 0) return;
  const { error: deleteError } = await db.from("chat_sessions").delete().in("id", gone);
  if (deleteError) console.error("routine: could not prune old run threads", deleteError);
}

/**
 * Tell the owner their routine stopped, through the channel it already
 * delivers to.
 *
 * A routine that dies quietly while the interface still reads "active" is the
 * failure that destroys trust in this feature: the mail stops arriving and
 * nothing anywhere says why. Best-effort by design — the pause is already
 * committed and visible on the routine's page, and a dead delivery channel is
 * itself a plausible reason for the pause, so a notice that cannot be sent must
 * not turn into a second failure.
 */
async function announcePause(
  routine: RoutineRow,
  deps: ExecutorDeps,
  reason: string,
): Promise<void> {
  await notifyOwner(routine, deps, "routine_paused", {
    subject: `Routine paused: ${routine.name}`,
    body:
      `"${routine.name}" has been paused after repeated failures, so it will not run again ` +
      `until you resume it.\n\nLast error: ${reason}\n\n` +
      `Open the routine in the app to resume it once the cause is fixed.`,
  });
}

/**
 * Tell the owner a gap-report routine stopped — in terms that are true for
 * this feature's three reasons, which `announcePause` is not.
 *
 * `announcePause` frames every pause as "paused after repeated failures" and
 * sends the owner to the routine itself to fix it. None of this feature's
 * three reasons is a failure: the report was switched off, the owner lost
 * admin, or the workspace shrank below the floor a topic can be reported
 * without naming who asked. All three are read-only facts about the
 * workspace, and two of them are fixed in its Settings rather than on this
 * routine — reusing `announcePause`'s wording here would tell the owner
 * something false twice over.
 *
 * A second, narrow function rather than a rewrite of `announcePause` itself:
 * that sentence is also what a repeated-failure pause and a membership-removal
 * pause would show, and changing it to fit this feature's three reasons would
 * change what those two say about theirs. Still reuses `announcePause`'s
 * `routine_paused` notice kind and `EVENT_PAUSED` webhook event — this is a
 * pause, just not a failure-shaped one, and the owner has only the one
 * preference toggle for "tell me when a routine stops."
 */
async function announceCoveragePause(
  routine: RoutineRow,
  deps: ExecutorDeps,
  reason: string,
): Promise<void> {
  await notifyOwner(routine, deps, "routine_paused", {
    subject: `Routine paused: ${routine.name}`,
    body:
      `"${routine.name}" has stopped: ${reason}.\n\n` +
      `It will not run again on its own. Once that is no longer true, open the ` +
      `routine in the app and resume it.`,
  });
}

/**
 * Tell the owner a routine was paused because events arrived faster than its
 * limit (0109) — `lib/routines/events/receive.ts` decides that, and pauses.
 *
 * Its own sentence, for `announceCoveragePause`'s reason: "paused after
 * repeated failures" would be false, since nothing failed. Something upstream
 * is sending far more than the routine was set up for — a filter that is too
 * wide, a channel busier than expected, a loop between two routines — and the
 * owner is the one who knows which. Exported because the pause is written by
 * the receiving side, which holds no `ExecutorDeps` of its own; the dispatcher
 * builds them and calls this.
 */
export async function announceEventFlood(
  routine: RoutineRow,
  deps: ExecutorDeps,
  reason: string,
): Promise<void> {
  await notifyOwner(routine, deps, "routine_paused", {
    subject: `Routine paused: ${routine.name}`,
    body:
      `"${routine.name}" has been paused: ${reason}\n\n` +
      `Nothing more will run until you resume it. If that many events were expected, ` +
      `narrow what it listens for first; otherwise check what is sending them.`,
  });
}

/**
 * Tell the owner an event routine has stopped hearing anything, because the
 * connection it listened through is gone or lapsed. Not paused — nothing about
 * the routine is wrong, and it starts working again the moment the event is
 * chosen afresh — but silent, which is the reason to say so: a routine that
 * waits for mail and never gets any looks exactly like a quiet inbox.
 */
export async function announceEventLapsed(
  routine: RoutineRow,
  deps: ExecutorDeps,
  reason: string,
): Promise<void> {
  await notifyOwner(routine, deps, "routine_paused", {
    subject: `Routine stopped listening: ${routine.name}`,
    body:
      `"${routine.name}" is no longer being told about new events: ${reason}

` +
      `Reconnect the app on the Integrations page, then choose the event again on the ` +
      `routine's page. Nothing that arrived in between will be replayed.`,
  });
}

/**
 * Tell the owner a run was skipped because the workspace is out of credits.
 *
 * Sent once, not once per tick. Ticks are minutes apart — five on the
 * Cloudflare trigger in wrangler.cron.toml, ROUTINE_TICK_MS on Node — so a
 * routine left waiting on credits would otherwise mail its owner thousands of
 * times before anybody topped up. `lastRunWasQuotaSkip` below is what makes it
 * once.
 */

async function announceQuotaSkip(routine: RoutineRow, deps: ExecutorDeps): Promise<void> {
  await notifyOwner(routine, deps, "quota_exhausted", {
    subject: `Routine waiting on credits: ${routine.name}`,
    body:
      `"${routine.name}" did not run: this workspace has no credits left.\n\n` +
      `Nothing has been lost. The routine was stopped before it read anything, so ` +
      `whatever it would have reported is still waiting, and it will run by itself ` +
      `once a workspace admin adds credits.\n\n` +
      `You will not get this message again for this routine until then.`,
  });
}

/**
 * Delivers a message from the engine to a routine's owner, through the channel
 * the routine already delivers to.
 *
 * Best-effort by design. Whatever prompted the message is already recorded and
 * visible on the routine's page, and a dead delivery channel is itself a
 * plausible reason for it, so a notice that cannot be sent must not turn into a
 * second failure.
 */
async function notifyOwner(
  routine: RoutineRow,
  deps: ExecutorDeps,
  kind: "routine_paused" | "quota_exhausted",
  message: { subject: string; body: string },
): Promise<void> {
  try {
    if (!(await wantsNotice(deps.db, routine.user_id, kind))) return;

    const { data: row } = await deps.db
      .from("delivery_channels")
      .select(CONFIRMABLE_COLUMNS)
      .eq("id", routine.delivery_channel_id)
      .eq("user_id", routine.user_id)
      .is("disabled_at", null)
      .maybeSingle();
    if (!row) return;
    const channel = await readyForDelivery(deps.env, row as ConfirmableChannel);

    await deliver(channel, message, deps.deliveryDeps, {
      // Named so a webhook receiver can file a notice apart from a result. No
      // `run` block: this is a message about the routine, not about a run —
      // the run that prompted it already failed and reported nothing.
      event: kind === "routine_paused" ? EVENT_PAUSED : EVENT_QUOTA_EXHAUSTED,
      routine: { id: routine.id, name: routine.name, agentId: routine.agent_id },
    });
  } catch {
    // Nothing left to do; the reason is already recorded against the run.
  }
}

/**
 * Has the owner turned this notice off?
 *
 * A missing row means they never touched the setting, which is every user until
 * they do — so no row means yes. A failed read means yes as well: these notices
 * exist because a routine dying in silence is the failure that destroys trust
 * in the feature, and a database hiccup is not a reason to add to the silence.
 * The worst case of guessing yes is one message somebody did not want.
 */
async function wantsNotice(
  db: SupabaseClient,
  userId: string,
  kind: "routine_paused" | "quota_exhausted" | "routine_failed",
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("notification_preferences")
      .select("routine_paused, quota_exhausted, routine_failed")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return true;
    return kind === "routine_paused"
      ? data.routine_paused !== false
      : kind === "quota_exhausted"
        ? data.quota_exhausted !== false
        : data.routine_failed !== false;
  } catch {
    return true;
  }
}

/**
 * Was this routine's previous run skipped for quota?
 *
 * The engine has no memory between ticks, so the run history is where it looks.
 * A failure to read is treated as "already told" — the cost of staying quiet
 * once is a missed notice; the cost of guessing the other way is a mailbox
 * filled once per tick until credits are added.
 */
async function lastRunWasQuotaSkip(db: SupabaseClient, routineId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("routine_runs")
      .select("status, error")
      .eq("routine_id", routineId)
      .order("finished_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return true;
    return data?.status === "skipped" && data?.error === QUOTA_SKIP_REASON;
  } catch {
    return true;
  }
}
