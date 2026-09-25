// worker/src/lib/routines/executor.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { nextRunAt } from "./schedule";
import { fetchSource, type FetchDeps, type SourceResult } from "./source";
import { UpstreamError } from "./upstream-error";
import { fetchConnectionItems } from "./connection-source";
import { diffItems, type Cursor, type FeedItem } from "./feed";
import { claimItemKeys, deliver, releaseItemKeys, type DeliveryDeps } from "./delivery";
import { EVENT_DELIVERED, EVENT_PAUSED, EVENT_QUOTA_EXHAUSTED } from "./webhook";
import { NOTE_NO_DOCUMENT_STORE, NOTE_VIEWER, type FilingInput, type FilingResult } from "./filing";
import { embeddingCost, type Entitlements } from "../entitlements";
import { WARN_AT, sameInstant } from "../entitlements/warn";
import {
  billsTheOperator,
  keysForUser,
  withProviderKeys,
  type ProviderKeys,
} from "../keys/resolve";

export const MAX_FAILURES = 5;

/**
 * Written to `routine_runs.error` when a run is skipped for quota, and matched
 * exactly on the next tick to decide whether the owner has already been told.
 * Kept free of anything variable — a reset date in here would make every run
 * look like a new one and the notice would repeat.
 */
export const QUOTA_SKIP_REASON = "skipped: the owner's monthly token quota is used up";

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

/** Backoff never pushes a routine more than this far past its natural next run. */
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

export type RoutineRow = {
  id: string;
  agent_id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  source_kind: "rss" | "web" | "none" | "connection";
  /** `url` for rss and web, `connectionId` for connection, empty for none. */
  source_config: { url?: string; connectionId?: string };
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
   * Whether this run is allowed to decide there is nothing worth sending.
   *
   * False for a scheduled prompt, which has no source for its output to be
   * irrelevant *to* — the instruction is the whole job, and one `false` would
   * silence "remind the team to post standup" permanently. True for everything
   * that watches something, and for a poked run, whose payload is exactly such
   * a thing.
   */
  mayDecline: boolean;
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
};

export type AgentRunResult = {
  text: string;
  /** How many tokens moved. The durable record, and what the run history shows. */
  tokens: number;
  /** What they cost, in the unit the allowance counts in. See `weighTokens`. */
  weightedTokens: number;
  declined: boolean;
};

export type RetrievalInput = { agentId: string; query: string };

export type ExecutorDeps = {
  /** Service-role client — bypasses RLS. See the scoping note below. */
  db: SupabaseClient;
  /**
   * The house env, before any per-owner key overlay. Kept alongside
   * `entitlements` so `runRoutine` can ask `keysForUser` whose key answers this
   * run — the same question `guardQuota` asks on a request, asked here because
   * a scheduled run has no request to guard.
   */
  env: RoutineEnv;
  summarise: (
    input: SummariseInput,
    env: RoutineEnv,
  ) => Promise<{
    text: string;
    tokens: number;
    /** What they cost, in the unit the allowance counts in. See `weighTokens`. */
    weightedTokens: number;
    /**
     * The model read the material and judged none of it to be what the
     * instruction asked for, so this run delivers nothing. Only ever true when
     * the input allowed it — see `SummariseInput.mayDecline`.
     */
    declined: boolean;
  }>;
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
   * What set this run going, reported to a webhook receiver as
   * `run.triggeredBy`.
   *
   * A string on the wire rather than a boolean, because the answer already has
   * more than two values in prospect: the cron tick, the button on the
   * routine's page, and — once a routine can be poked from outside — an
   * incoming request. Defaults to the schedule, which is what a caller that
   * has not thought about it almost always means.
   */
  trigger?: string;
  /** What the routine's owner may spend. Unmetered on a self-hosted install. */
  entitlements: Entitlements;
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
};

export async function runRoutine(
  routine: RoutineRow,
  deps: ExecutorDeps,
  trigger?: IngestTrigger,
): Promise<{ status: "ok" | "skipped" | "failed"; itemsNew: number }> {
  const startedAt = deps.now();
  let claimedKeys: string[] = [];
  let delivered = false;

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
      await finish(routine, deps, startedAt, {
        status: "skipped",
        itemsNew: 0,
        tokens: 0,
        error: reason,
        pause: reason,
      });
      return { status: "skipped", itemsNew: 0 };
    }

    // Quota is checked here — after membership, before anything is fetched or
    // claimed. It cannot move further down: past `claimItemKeys` a skipped run
    // leaves delivery keys reserved, and `claimItemKeys` only ever returns
    // newly-inserted ones, so those items could never be delivered again. The
    // cursor is deliberately left unadvanced, so once the quota resets the run
    // picks up exactly what it would have reported.
    const verdict = await deps.entitlements.check(routine.user_id);
    // The routine's owner may be past their allowance while their workspace
    // carries it. Resolved here rather than in `guardQuota` because a scheduled
    // run has no request to guard.
    const keys = await keysForUser(deps.env, deps.db, routine.user_id, verdict.allowed);
    const runEnv = withProviderKeys(deps.env, keys);
    if (!verdict.allowed && billsTheOperator(keys)) {
      // Read before `finish` writes this run: the question is whether the
      // PREVIOUS one was also a quota skip.
      const alreadyTold = await lastRunWasQuotaSkip(deps.db, routine.id);
      await finish(routine, deps, startedAt, {
        status: "skipped",
        itemsNew: 0,
        tokens: 0,
        error: QUOTA_SKIP_REASON,
      });
      if (!alreadyTold) {
        await announceQuotaSkip(routine, deps, verdict.resetsAt);
      }
      return { status: "skipped", itemsNew: 0 };
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
        routine.cursor,
        deps.fetchDeps,
      );
    }

    if (result.status === "unchanged") {
      await finish(routine, deps, startedAt, { status: "skipped", itemsNew: 0, tokens: 0 });
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
      const diff = diffItems(result.items, routine.cursor);
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
      if (routine.cursor === null) {
        await finish(routine, deps, startedAt, {
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
      keysToClaim = [`hash:${result.hash}@${routine.next_run_at}`];
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
      keysToClaim = trigger ? [`hook:${trigger.eventId}`] : [`slot:${routine.next_run_at}`];
    }

    const hasWork = routine.source_kind === "none" || items.length > 0 || pageText !== undefined;
    if (!hasWork) {
      await finish(routine, deps, startedAt, {
        status: "skipped",
        itemsNew: 0,
        tokens: 0,
        cursor: nextCursor,
      });
      return { status: "skipped", itemsNew: 0 };
    }

    // Reserve before sending. A concurrent or retried run gets back fewer keys.
    claimedKeys = await claimItemKeys(deps.db, routine.id, keysToClaim);
    if (diffed) {
      items = items.filter((i) => claimedKeys.includes(i.key));
    }
    if (claimedKeys.length === 0) {
      await finish(routine, deps, startedAt, {
        status: "skipped",
        itemsNew: 0,
        tokens: 0,
        cursor: nextCursor,
      });
      return { status: "skipped", itemsNew: 0 };
    }

    // Checked before summarising: a routine with a missing channel shouldn't
    // pay for an LLM call it can never deliver.
    //
    // SCOPING: the service role bypasses RLS, so both lookups below are scoped
    // explicitly from the routine row — the channel to its owner, the agent to
    // the routine's workspace. Matching on id alone would make any tampered row
    // a cross-tenant read.
    const { data: channel, error: channelError } = await deps.db
      .from("delivery_channels")
      .select("kind, secret_ciphertext")
      .eq("id", routine.delivery_channel_id)
      .eq("user_id", routine.user_id)
      .maybeSingle();

    if (channelError) throw new Error(`delivery channel lookup failed: ${channelError.message}`);
    if (!channel) throw new Error("delivery channel missing");

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
    // Through `runEnv`, so an owner who brought their own key pays for the
    // embedding as well as the completion.
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
      model: agent?.model ?? null,
      temperature: agent?.temperature ?? null,
      reasoningEffort: agent?.reasoning_effort ?? null,
      instruction: routine.instruction,
      items,
      pageText,
      payloadText: trigger?.payload,
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
    };

    // The branch, and the whole of §D. A workspace with something for a tool
    // to point at runs the agent loop; everything else runs the single call
    // it always ran. `runWithTools` answers `null` for the second case, so
    // the question is asked once rather than twice.
    const summary =
      (await deps.runWithTools?.(
        {
          ...summariseInput,
          agentId: routine.agent_id,
          workspaceId: routine.workspace_id,
          userId: routine.user_id,
        },
        runEnv,
      )) ?? (await deps.summarise(summariseInput, runEnv));

    // The model read what arrived and judged none of it to be what was asked
    // for. This is a working run, not a failure and not an empty source: the
    // entries were real, they were read, and the answer was no.
    //
    // The cursor advances and the delivery claims stay, both deliberately. A
    // rejected entry has been judged; offering it again next run would spend
    // another model call to reach the same answer, and on a busy feed that is
    // most of the bill.
    if (summary.declined) {
      await finish(routine, deps, startedAt, {
        status: "skipped",
        // What it read before deciding. Zero here would be indistinguishable
        // from a feed that had not moved, which is the question this number is
        // on the row to answer.
        itemsNew: items.length,
        itemsOverflow: overflow,
        tokens: summary.tokens + embeddingCost(embeddingTokens),
        // Embedding cost is already in the counter's unit — see
        // `EMBEDDING_TOKEN_WEIGHT` — so it is added to both without reweighing.
        weightedTokens: summary.weightedTokens + embeddingCost(embeddingTokens),
        cursor: nextCursor,
        error: NOTHING_RELEVANT_REASON,
        keys,
      });
      return { status: "skipped", itemsNew: 0 };
    }

    // What is sent and, if this routine files, what is kept — the same text,
    // overflow note included. A digest that was missing thirty entries is still
    // missing them a year later, and a filed copy that quietly dropped the
    // sentence saying so would be the more complete-looking of the two.
    const body = withOverflowNote(summary.text, overflow);

    await deliver(channel, { subject: routine.name, body }, deps.deliveryDeps, {
      event: EVENT_DELIVERED,
      routine: { id: routine.id, name: routine.name, agentId: routine.agent_id },
      // `items.length` rather than the claimed keys: what the summary is
      // about. `overflow` is what it is missing, which is the number a
      // receiver needs to know the digest is not the whole story.
      run: {
        itemsNew: items.length,
        itemsOverflow: overflow,
        // A poke names itself, whatever the dispatcher was built as.
        triggeredBy: trigger ? "webhook" : (deps.trigger ?? "schedule"),
      },
    });
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

    await finish(routine, deps, startedAt, {
      status: "ok",
      itemsNew: items.length,
      itemsOverflow: overflow,
      documentId: filing.documentId,
      filingNote: filing.note,
      // One counter write for the run, so the embeddings this run paid for are
      // charged with the completion rather than in a second place that a later
      // change could forget — including the decision about whose key paid,
      // which `finish` makes once from `keys`.
      //
      // `filing.indexTokens` joins the retrieval embeddings in the same sum for
      // exactly that reason: filing buys embeddings too, and a second
      // `record()` call for them would be a second place to forget whose key
      // paid. A 3,000-character summary is about two chunks — roughly 800
      // embedding tokens, which `embeddingCost` weights down to single figures
      // against a chat token. Filing is opt-in because of what it means, not
      // because of what it costs.
      tokens: summary.tokens + embeddingCost(embeddingTokens + filing.indexTokens),
      weightedTokens: summary.weightedTokens + embeddingCost(embeddingTokens + filing.indexTokens),
      cursor: nextCursor,
      summary: summary.text,
      keys,
    });
    return { status: "ok", itemsNew: items.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

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
        await releaseItemKeys(deps.db, routine.id, claimedKeys);
      } catch (releaseErr) {
        releaseError = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
      }
    }

    const recorded = releaseError
      ? `${message} (${claimedKeys.length} delivery claims could not be released: ${releaseError})`
      : message;

    try {
      await finish(routine, deps, startedAt, {
        status: "failed",
        itemsNew: 0,
        tokens: 0,
        error: recorded,
        transient: err instanceof UpstreamError && err.transient,
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
 * be answered by omission. Only an `"ok"` run ever spends, so only `"ok"` may
 * carry a non-zero `tokens` — and, having spent, it is *required* to name whose
 * key it spent. The alternative shape, an optional `keys?`, compiles for a
 * future caller who forgets it and then quietly bills the operator for tokens
 * somebody else's key paid for; that is a mistake worth spending a type on.
 *
 * `tokens: 0` as a literal on the other branch is the same idea from the other
 * end: a skipped or failed run that wanted to report a spend would have to
 * become an `"ok"` one first, and would then have to say who paid.
 */
type RunOutcome = {
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
  /** The remote's fault, not the routine's — judged against the higher limit. */
  transient?: boolean;
  /** Pause the routine with this reason, independently of the failure count. */
  pause?: string;
} & (
  | {
      status: "ok";
      tokens: number;
      /**
       * The same spend in the unit the allowance counts in, which is what the
       * counter is charged. `tokens` stays the record of how many moved, and
       * the run history shows that one. See `weighTokens`.
       */
      weightedTokens: number;
      /** Whose key paid for `tokens`. Required, and that is the point. */
      keys: ProviderKeys;
    }
  | {
      /**
       * A run that paid for a model call and then decided not to send.
       *
       * It is not an `"ok"` run — nothing was delivered — and it is not free
       * either, so it carries the same answer about who paid. This branch
       * exists so that widening "skipped" to admit a spend could not be done
       * without also answering that question: `keys` is required here for the
       * same reason it is required above.
       */
      status: "skipped";
      tokens: number;
      weightedTokens: number;
      keys: ProviderKeys;
    }
  | { status: "skipped" | "failed"; tokens: 0; weightedTokens?: 0; keys?: undefined }
);

async function finish(
  routine: RoutineRow,
  deps: ExecutorDeps,
  startedAt: Date,
  outcome: RunOutcome,
): Promise<void> {
  const finishedAt = deps.now();

  // postgrest-js resolves { data, error }; it does not throw. An unchecked
  // insert here would drop run history silently, and an unchecked update below
  // would leave claimed_at set with next_run_at and the cursor unadvanced —
  // which for a web or none routine means re-delivering the same content on
  // every tick. Both have to be loud.
  const { error: runError } = await deps.db.from("routine_runs").insert({
    routine_id: routine.id,
    started_at: startedAt.toISOString(),
    finished_at: finishedAt.toISOString(),
    status: outcome.status,
    items_new: outcome.itemsNew,
    items_overflow: outcome.itemsOverflow ?? 0,
    tokens: outcome.tokens,
    duration_ms: finishedAt.getTime() - startedAt.getTime(),
    error: outcome.error ?? null,
    summary: outcome.summary ?? null,
    document_id: outcome.documentId ?? null,
    filing_note: outcome.filingNote ?? null,
  });
  if (runError) throw new Error(`routine_runs insert failed: ${runError.message}`);

  // Charged to the routine's owner, not to whoever happened to trigger it — a
  // scheduled run has no caller at all. Best-effort: the run is finished and
  // delivered, and `routine_runs.tokens` above is the durable record, so a
  // counter that cannot be written must not turn a successful run into a failed
  // one that retries and pays twice.
  // Only what the operator is billed for — same rule as `recordQuota` on a
  // request, asked through the same predicate. `outcome.keys` is what makes the
  // type narrow rather than a second guard: the branches that can have spent
  // anything are exactly the branches carrying the answer to who paid, so a
  // spend the union let through without one would not compile.
  //
  // Not keyed on `status === "ok"` any more. A run that paid for a model call
  // and then declined to send is a skipped run that spent real money, and
  // billing it as if it were free would make a filtered routine free to run.
  // Guarded on the number that is actually recorded, not on the one beside it.
  // `record` is called directly here rather than through `recordQuota`, so it
  // has none of that function's own `Number.isFinite` check — and `> 0` is
  // false for both `undefined` and `NaN`, which is the whole of what is needed.
  if (
    outcome.weightedTokens &&
    outcome.weightedTokens > 0 &&
    outcome.keys &&
    billsTheOperator(outcome.keys)
  ) {
    try {
      // The weighted figure, not the raw one — the counter is denominated in
      // what tokens cost, and `routine_runs.tokens` above already keeps what
      // moved. `outcome.keys` being required on exactly the branches that can
      // spend is what makes this reachable only where there is one.
      await deps.entitlements.record(routine.user_id, outcome.weightedTokens);
      await warnOwnerIfLow(routine, deps);
    } catch (err) {
      console.error("failed to record routine token usage", err);
    }
  }

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

  const { error: updateError } = await deps.db.from("routines").update(patch).eq("id", routine.id);
  if (updateError) throw new Error(`routines update failed: ${updateError.message}`);

  if (pausedByFailures) {
    await announcePause(routine, deps, String(patch.paused_reason));
  }
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
 * Tell the owner a run was skipped because their allowance is spent.
 *
 * Sent once, not once per tick. Ticks are minutes apart — five on the
 * Cloudflare trigger in wrangler.cron.toml, ROUTINE_TICK_MS on Node — so a
 * routine left waiting on a monthly allowance would otherwise mail its owner
 * thousands of times before the month turned over. `lastRunWasQuotaSkip` below
 * is what makes it once.
 */
/**
 * Say something before the allowance is gone, for somebody whose spend is all
 * scheduled.
 *
 * `lib/entitlements/warn.ts` does this on a request, and it is reached from
 * `recordQuota` — which a routine never calls, because a scheduled run has no
 * request to hang one off. So an account whose routines quietly spend a month's
 * allowance got no warning at all, and the first news of the limit was a run
 * skipped for being out of it. That is the failure `warnIfLow` was written to
 * remove, left open on the one path where nobody is watching.
 *
 * It shares the column rather than adding one, and that is deliberate:
 * `quota_warned_for` means "this period has been warned about", not "chat has
 * warned about it". Whichever side notices first sends the one message, and the
 * other stays quiet.
 *
 * `quota_exhausted` is the preference it asks, for the same reason — it is the
 * owner's switch for hearing about their allowance, and inventing a second one
 * would mean a migration to split a question nobody asked to have split.
 *
 * Best-effort throughout, like every notice from this engine: the run is
 * finished and delivered, and a message that cannot be sent must not turn a
 * successful run into a failed one.
 */
async function warnOwnerIfLow(routine: RoutineRow, deps: ExecutorDeps): Promise<void> {
  try {
    const { used, limit, resetsAt } = await deps.entitlements.snapshot(routine.user_id);
    // `limit: null` is the open build answering "unmetered" — a self-hosted
    // Covan brings its own key and has no allowance to run low on.
    if (limit === null || limit <= 0 || !resetsAt) return;
    if (used / limit < WARN_AT) return;

    const { data: prefs } = await deps.db
      .from("notification_preferences")
      .select("quota_warned_for")
      .eq("user_id", routine.user_id)
      .maybeSingle();
    if (sameInstant(prefs?.quota_warned_for as string | null | undefined, resetsAt)) return;

    // Stamped before the send, not after. The two orders fail differently: this
    // way a dead delivery channel costs one missed warning, the other way round
    // it costs a message per run for the rest of the period.
    const { error } = await deps.db.from("notification_preferences").upsert(
      {
        user_id: routine.user_id,
        quota_warned_for: resetsAt,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error) return;

    const when = new Date(resetsAt);
    const readable = Number.isNaN(when.getTime())
      ? "when your allowance resets"
      : when.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

    await notifyOwner(routine, deps, "quota_exhausted", {
      subject: "Your monthly allowance is running low",
      body:
        `Your routines have used ${Math.round((used / limit) * 100)}% of this month's token ` +
        `allowance, and "${routine.name}" is one of them.\n\n` +
        `Nothing has stopped. This is early notice rather than a problem: once the ` +
        `allowance is gone, routines wait instead of running, and they start again by ` +
        `themselves on ${readable}.\n\n` +
        `You will not get this message again this month.`,
    });
  } catch {
    // Nothing left to do. The spend is already recorded and the run is done.
  }
}

async function announceQuotaSkip(
  routine: RoutineRow,
  deps: ExecutorDeps,
  resetsAt: string,
): Promise<void> {
  const when = new Date(resetsAt);
  const readable = Number.isNaN(when.getTime())
    ? "when your allowance resets"
    : when.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });

  await notifyOwner(routine, deps, "quota_exhausted", {
    subject: `Routine waiting on your allowance: ${routine.name}`,
    body:
      `"${routine.name}" did not run: your monthly token allowance is used up.\n\n` +
      `Nothing has been lost. The routine was stopped before it read anything, so ` +
      `whatever it would have reported is still waiting, and it will run by itself ` +
      `once the allowance resets on ${readable}.\n\n` +
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

    const { data: channel } = await deps.db
      .from("delivery_channels")
      .select("kind, secret_ciphertext")
      .eq("id", routine.delivery_channel_id)
      .eq("user_id", routine.user_id)
      .maybeSingle();
    if (!channel) return;

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
  kind: "routine_paused" | "quota_exhausted",
): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("notification_preferences")
      .select("routine_paused, quota_exhausted")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return true;
    return kind === "routine_paused"
      ? data.routine_paused !== false
      : data.quota_exhausted !== false;
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
 * filled once per tick until the allowance resets.
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
