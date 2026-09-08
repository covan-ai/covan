// Client mirrors of the worker's routine DTOs (worker/src/lib/dto.ts). Kept in
// their own file so api-client.ts stays a transport layer; the request
// functions themselves live there because `request()` is module-private.

/**
 * `connection` watches a bundle a Notion or Drive connection already keeps
 * current, and reports the documents that were added or changed since the last
 * run. It reads nothing from the provider itself — the sync has already done
 * that — so what it sees is only ever as fresh as the connection's own
 * interval.
 */
export type RoutineSourceKind = "rss" | "web" | "none" | "connection";

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
  status: "active" | "paused";
  /** Set when the engine paused this itself after repeated failures. */
  pausedReason: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  createdAt: number;
};

export type RoutineRun = {
  id: string;
  /** `skipped` means "looked, nothing new" — it is not a failure. */
  status: "ok" | "skipped" | "failed";
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
  startedAt: number;
};

/** The secret is never returned; `label` is the mask computed at creation. */
export type DeliveryChannel = {
  id: string;
  kind: "slack_webhook" | "email";
  label: string;
  createdAt: number;
};

/**
 * What POST /routines/draft returns. Note the field names differ from
 * CreateRoutineInput: `cron` not `scheduleCron`, and `channelKind` is only a
 * hint for preselecting a channel — the draft cannot know which channel id.
 */
export type RoutineDraft = {
  name: string;
  sourceKind: "rss" | "web" | "none";
  sourceUrl: string | null;
  cron: string;
  instruction: string;
  channelKind: "slack" | "email";
  timezone: string;
};

export type CreateRoutineInput = {
  agentId: string;
  name: string;
  sourceKind: RoutineSourceKind;
  sourceUrl?: string | null;
  /** Required when sourceKind is `connection`. */
  connectionId?: string | null;
  instruction: string;
  deliveryChannelId: string;
  scheduleCron: string;
  timezone: string;
};

export type UpdateRoutineInput = Partial<{
  name: string;
  instruction: string;
  scheduleCron: string;
  timezone: string;
  status: "active" | "paused";
  visibility: "private" | "shared";
  deliveryChannelId: string;
}>;
