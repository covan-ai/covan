// Client mirrors of the worker's routine DTOs (worker/src/lib/dto.ts). Kept in
// their own file so api-client.ts stays a transport layer; the request
// functions themselves live there because `request()` is module-private.

import type { ReasoningEffort } from "./agent-meta";

/**
 * `connection` watches a bundle a Notion or Drive connection already keeps
 * current, and reports the documents that were added or changed since the last
 * run. It reads nothing from the provider itself — the sync has already done
 * that — so what it sees is only ever as fresh as the connection's own
 * interval.
 */
export type RoutineSourceKind = "rss" | "web" | "none" | "connection" | "workspace";

/**
 * The kinds the create dialog can produce. `rss` and `web` are left out on
 * purpose: covan#241 took the feed and page sources out of the dialog, and a
 * routine of either kind made elsewhere is still shown and edited as one.
 */
export type CreatableSourceKind = Exclude<RoutineSourceKind, "rss" | "web">;

export type Routine = {
  id: string;
  agentId: string;
  /** The owner. Compared against the caller's own id to split Team vs My. */
  userId: string;
  name: string;
  visibility: "private" | "shared";
  sourceKind: RoutineSourceKind;
  sourceUrl: string | null;
  /** Set only for `connection`. The connection whose documents it watches. */
  connectionId: string | null;
  instruction: string;
  deliveryChannelId: string;
  scheduleCron: string;
  timezone: string;
  triggerKind: RoutineTriggerKind;
  /**
   * What an `event` routine waits for, and whether the app agreed to tell us.
   * Null for every other kind, for an event routine whose event was never
   * chosen, and for anybody but the owner — the database shows it to the
   * owner alone.
   */
  event: RoutineEvent | null;
  /**
   * The bundle each delivered summary is filed into as a document, or null to
   * keep nothing — which is the default, and what every routine did before
   * filing existed.
   */
  outputBundleId: string | null;
  /** How many of its own filed documents this routine keeps. 52 by default. */
  outputRetention: number;
  /** After how many delivered runs this routine ends itself, or null for never. */
  endsAfterRuns: number | null;
  /** How many it has delivered. */
  runsDone: number;
  /**
   * Whether a scheduled run may use the browser: `off`, or `all`, carrying
   * what the owner's browser does in a conversation.
   */
  browserAccess: "off" | "all";
  /** The conversation this routine's browser works beside, once a run opened one. */
  browserConversationId: string | null;
  status: "active" | "paused" | "completed";
  /** Set when the engine paused this itself after repeated failures. */
  pausedReason: string | null;
  /** Who paused it by hand, and when (0123). Null for a pause the engine made. */
  pausedBy: string | null;
  pausedAt: number | null;
  /** Whether each run is also a thread in the Inbox. */
  deliverInbox: boolean;
  /** The model and thinking it runs on; null is its agent's. */
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  /**
   * Where it delivers after `deliveryChannelId` (0130). Ids only: a colleague
   * learns how many, and only the owner can look the channels up.
   */
  channelIds: string[];
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
};

/** A row of `GET /routines`: the routine, and what the list says under its name (A7). */
export type RoutineListItem = Routine & {
  ownerName: string | null;
  pausedByName: string | null;
  lastRun: {
    id: string;
    status: RoutineRun["status"];
    at: number;
    sessionId: string | null;
  } | null;
  /** When the run under way started, or null. A routine has no step count. */
  runningSince: number | null;
};

/** What a run cost, in what this deployment shows: credits, or dollars self-hosted. */
export type RoutineCost = { amount: number; unit: "credits" | "usd" };

/** The list's footer: "14 runs in the last 7 days · 13 done, 1 failed · 118 credits". */
export type RoutineStats = {
  days: number;
  runs: number;
  done: number;
  failed: number;
  skipped: number;
  cost: number;
  unit: RoutineCost["unit"];
};

/**
 * "About 15 to 25 credits per run · 4 runs a month. Based on the Daily
 * support digest." `low` and `high` are null when there is nothing to base
 * them on; `runsPerMonth` when no schedule was given.
 */
export type RoutineEstimate = {
  low: number | null;
  high: number | null;
  unit: RoutineCost["unit"];
  runsPerMonth: number | null;
  basedOn: { kind: "routine"; routineId: string; name: string } | { kind: "replies" } | null;
};

export type RoutineRun = {
  id: string;
  /**
   * `skipped` means "looked, nothing new" — it is not a failure. `waiting`
   * means the report is written and held until a browser task answers.
   */
  status: "ok" | "skipped" | "failed" | "waiting";
  itemsNew: number;
  /**
   * New entries this run saw and did not deliver, dropped by the per-run cap of
   * ten. They were marked seen, so they are not queued for a later run — they
   * are gone, which is why the number is shown rather than inferred.
   */
  itemsOverflow: number;
  /**
   * The run read real entries and the agent judged none of them to be what the
   * instruction asked for — as opposed to a run that found nothing new at all.
   * `itemsNew` is how many it read before deciding.
   */
  nothingRelevant: boolean;
  durationMs: number | null;
  error: string | null;
  /** What was delivered. Null for skipped and failed runs, and for runs
   *  recorded before routine_runs.summary existed. */
  summary: string | null;
  /** The document this run filed, when it filed one. */
  documentId: string | null;
  /**
   * Why a run that was supposed to file did not.
   *
   * Null in both ordinary cases — the routine files nothing, or filing worked —
   * so a note on screen always means the optional half of an otherwise
   * successful run failed. Worth showing rather than hiding: it is the only way
   * somebody finds out their scheduled worker has no document storage bound, or
   * that they were demoted to viewer last month.
   */
  filingNote: string | null;
  /**
   * How the model stopped (`messages.outcome`'s words). Null when the run
   * never reached a model, which every skipped run is, and for runs recorded
   * before 0070.
   *
   * Not the same question as `status`: `ok` says the run completed, and a run
   * whose turn was cut short did — it spent its tokens and delivered what it
   * had. Anything but `answered` on an `ok` run means it stopped before it
   * finished (covan#243).
   */
  outcome: RunOutcome | null;
  /** The model that answered. Null on the same runs as `outcome`. */
  model: string | null;
  /** What started this run. Null for runs recorded before it was written down. */
  triggeredBy: RunTrigger | null;
  /** "Gmail · New mail", for a run an event started. Null otherwise. */
  triggerLabel: string | null;
  /** The thread this run is shown in, when it has one (0123). */
  sessionId: string | null;
  /** What the routine's other channels missed (0130). */
  deliveryNote: string | null;
  /** What it cost; null for a run that called no model. Absent from a test's answer. */
  cost?: RoutineCost | null;
  startedAt: number;
};

/** `test` is "Run a test" (0130): a run that went only to its owner. */
export type RunTrigger = "schedule" | "manual" | "webhook" | "event" | "reply" | "test";

/**
 * Where the arrangement with the app stands. `failed` is retried on its own;
 * `expired` needs the person to reconnect the app; `disabled` is a paused
 * routine, not a fault.
 */
export type RoutineEventStatus = "pending" | "active" | "failed" | "expired" | "disabled";

export type RoutineEvent = {
  /** The catalogue id: `gmail.new_message`. */
  type: string;
  provider: string;
  app: string;
  label: string;
  /** Filters and choices. Never a secret. */
  config: Record<string, unknown>;
  status: RoutineEventStatus;
  /** Why it is `failed` or `expired`, written for a person. */
  statusDetail: string | null;
  lastEventAt: number | null;
  expiresAt: number | null;
};

/** One field of an event's config, as the dialog draws it. */
export type EventField = {
  key: string;
  label: string;
  /** `secret`: a password box whose value is never shown back (a bot token). */
  kind: "text" | "number" | "select" | "boolean" | "secret";
  optional?: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  advanced?: boolean;
};

/** What has to be connected before an event can be listened for. */
export type EventRequirement =
  | { kind: "composio"; toolkit: string }
  | { kind: "connection"; provider: "notion" | "google_drive" }
  | { kind: "slack" }
  | { kind: "none" };

/** One entry of GET /routines/events/catalog. */
export type EventCatalogEntry = {
  type: string;
  provider: string;
  app: string;
  label: string;
  description: string;
  fields: EventField[];
  requires: EventRequirement;
  /** Whether what it needs is connected in this workspace. */
  connected: boolean;
};

/** What a person picked: an entry, and its config. */
export type EventChoice = { type: string; config: Record<string, unknown> };

/**
 * What the owner has to hand out or paste for events to arrive, from
 * GET /routines/:id/event/setup: a GitHub webhook's URL and secret, or the
 * address a routine is mailed at, or a Telegram bot's pairing link. Every
 * other event is set up by Covan itself.
 */
export type EventSetup =
  | { kind: "none" }
  | { kind: "github"; url: string; secret: string; contentType: string }
  | { kind: "email"; address: string }
  /** A Telegram bot: the link a chat opens to pair, and the chats that have. */
  | { kind: "telegram"; botUsername: string; link: string; code: string; chats: string[] };

/** How a scheduled run's turn ended; the worker's `MESSAGE_OUTCOMES`. */
export type RunOutcome =
  "answered" | "paused" | "budget" | "tokens" | "runtime" | "cut_short" | "empty" | "truncated";

export type DeliveryChannelKind = "slack_webhook" | "email" | "webhook";

/** The secret is never returned; `label` is the mask computed at creation. */
export type DeliveryChannel = {
  id: string;
  kind: DeliveryChannelKind;
  label: string;
  createdAt: number;
  /**
   * False only for an email address that has not agreed to these messages.
   * Nothing is delivered to it until somebody there opens the link Covan
   * mailed it — unless it is your own sign-in address, which is confirmed as
   * it is added.
   */
  confirmed: boolean;
};

/** What happened to the question an unconfirmed address is sent. */
export type ConfirmationOutcome = "sent" | "recently" | "limit" | "unavailable";

/**
 * What creating a channel answers with.
 *
 * `signingSecret` is present only for `webhook`, only on this response, and
 * never again: the API stores it encrypted because signing needs it back, but
 * nothing reads it out to a client a second time. A screen that does not show
 * it here has lost it, and the only way forward is to rotate.
 */
export type CreatedDeliveryChannel = DeliveryChannel & {
  signingSecret?: string;
  confirmation?: ConfirmationOutcome;
};

/**
 * What POST /routines/draft returns. Note the field names differ from
 * CreateRoutineInput: `cron` not `scheduleCron`, and `channelKind` is only a
 * hint for preselecting a channel — the draft cannot know which channel id.
 */
export type RoutineDraft = {
  name: string;
  /**
   * Always a scheduled task. A feed or a page is still a routine the API can
   * create, but not one the dialog offers (covan#241), so the drafter folds one
   * into the instruction rather than proposing it — see `parseDraft`.
   */
  sourceKind: "none";
  sourceUrl: null;
  cron: string;
  instruction: string;
  channelKind: "slack" | "email";
  timezone: string;
};

/**
 * What starts a routine.
 *
 * Only a routine with no source of its own may be poked — see the migration for
 * why every answer to "it has a feed and somebody poked it, does it re-fetch?"
 * is a bad one. And because a routine's source can never change after it is
 * created, this is a decision made once, at creation.
 */
export type RoutineTriggerKind = "schedule" | "webhook" | "both" | "event";

/** What the routine detail screen knows about a webhook trigger. Never the token. */
export type RoutineTrigger =
  { configured: false } | { configured: true; createdAt: number; lastUsedAt: number | null };

export type CreateRoutineInput = {
  agentId: string;
  name: string;
  sourceKind: RoutineSourceKind;
  sourceUrl?: string | null;
  /** Required when sourceKind is `connection`. */
  connectionId?: string | null;
  instruction: string;
  /**
   * Exactly one of `deliveryChannelId` and `deliveryEmail`, enforced by the
   * worker's schema rather than by this type: a workspace with an existing
   * channel sends its id, and a workspace with none sends an address instead,
   * and the API creates the channel from it in the same request.
   */
  deliveryChannelId?: string;
  deliveryEmail?: string;
  scheduleCron: string;
  timezone: string;
  /** Omitted means `schedule`, which is what every routine was before this. */
  triggerKind?: RoutineTriggerKind;
  /** Required with `triggerKind: "event"`, refused otherwise. */
  event?: EventChoice;
  /** Null or omitted means the routine keeps nothing, which is the default. */
  outputBundleId?: string | null;
  outputRetention?: number;
  /** After how many delivered runs this routine ends itself, or null for never. */
  endsAfterRuns?: number | null;
  deliverInbox?: boolean;
  /** Null, or omitted, runs on the agent's model and thinking. */
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
};

export type UpdateRoutineInput = Partial<{
  name: string;
  instruction: string;
  scheduleCron: string;
  timezone: string;
  status: "active" | "paused";
  visibility: "private" | "shared";
  deliveryChannelId: string;
  /**
   * Nullable as well as optional, and the difference is the feature: absent
   * means "leave filing alone", null means "stop filing".
   */
  outputBundleId: string | null;
  outputRetention: number;
  browserAccess: "off" | "all";
  deliverInbox: boolean;
  /** Null hands the choice back to the agent. */
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
}>;
