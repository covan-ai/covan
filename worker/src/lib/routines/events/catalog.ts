/**
 * Every kind of thing a routine can wait for, in one list.
 *
 * WHY A CATALOGUE AND NOT A COLUMN PER PROVIDER. A routine that waits for a
 * Gmail message and one that waits for a Slack reaction are the same routine:
 * something happened somewhere, here is a short account of it, do what the
 * instruction says. What differs is who has to be asked to say so, and that
 * is an adapter's business (`adapter.ts`). What a person picks — "Gmail · New
 * mail", with a search query — is this file's.
 *
 * So `routine_event_subscriptions` (0109) stores two strings out of here: the
 * provider, which picks the adapter, and the event type's id, which picks the
 * entry below. Moving an event from one adapter to another — Composio's Gmail
 * trigger to a native Gmail watch, the day the native one is worth its review
 * — is a change to an entry's `provider` and an adapter, and not to a single
 * routine row's meaning. The id stays the same; that is the promise the id
 * makes.
 *
 * ENTRIES ARRIVE WITH THEIR ADAPTERS. An entry without an adapter would be a
 * choice the dialog offers and the engine cannot keep, which is the one thing
 * this list must never be: the catalogue route filters on
 * `adapterFor(provider)?.isConfigured(env)`, so an entry whose adapter is
 * missing or unconfigured is never shown, and a row that names one is marked
 * `failed` with a sentence rather than left `pending` forever
 * (`lifecycle.ts`). Composio's — Gmail, Outlook, Google Calendar — are the
 * first, in `composio-catalog.ts` beside what Composio needs to serve them;
 * GitHub's (`github.ts`), WebSub's — YouTube and instant RSS (`websub.ts`) —
 * Slack's (`slack.ts`), and Notion's and Google Drive's (`notion.ts`, `drive.ts`)
 * sit beside their adapters the same way.
 */

import type { z } from "zod";
import { COMPOSIO_EVENTS } from "./composio-catalog";
import { GITHUB_EVENTS } from "./github";
import { WEBSUB_EVENTS } from "./websub";
import { SLACK_EVENTS } from "./slack";
import { NOTION_EVENTS } from "./notion";
import { DRIVE_EVENTS } from "./drive";

/**
 * Who sends the event. The adapter registry is keyed on this, and so is the
 * delivery key (`evt:<provider>:<id>`) — two providers' ids for unrelated
 * events cannot collide in `routine_deliveries`.
 */
export type EventProvider =
  "composio" | "slack" | "github" | "websub" | "notion" | "google_drive" | "telegram" | "email";

/**
 * What has to exist in the workspace before this event can be listened for.
 *
 * Checked when the person picks it, through their own client — so "connected"
 * means connected and visible to them, not merely present somewhere in the
 * workspace — and recorded as `config.connectionId` where there is a row to
 * point at, so the adapter knows whose grant to subscribe with.
 *
 *   composio    a `tool_connections` row with this toolkit, active
 *   connection  a `connections` row for this provider (Notion, Drive), active
 *   slack       the workspace's Slack installation
 *   none        nothing — the person pastes a URL or a token somewhere instead
 */
export type EventRequirement =
  | { kind: "composio"; toolkit: string }
  | { kind: "connection"; provider: "notion" | "google_drive" }
  | { kind: "slack" }
  | { kind: "none" };

/**
 * One field the dialog draws for this event's config. The zod schema on the
 * entry is what the API trusts; this is only how to ask for it, so a field
 * missing here is a value nobody can set, never a value that is set unchecked.
 */
export type EventField = {
  key: string;
  label: string;
  kind: "text" | "number" | "select" | "boolean";
  /** Absent means required, which is the rarer case — most filters narrow. */
  optional?: boolean;
  placeholder?: string;
  help?: string;
  options?: Array<{ value: string; label: string }>;
  /** Shown behind "More options": a HubSpot app id, not a search query. */
  advanced?: boolean;
};

/**
 * What an adapter makes of a raw delivery: the event's own id, and a short
 * account of it written for the model to read.
 *
 * `text` is the point of the whole arrangement. A Gmail delivery is several
 * kilobytes of headers and MIME parts, and handing that to the model is
 * paying ten thousand tokens to read "Ayşe asked whether Thursday still
 * works". The adapter writes the subject, the sender and the gist, and the
 * run reads that — under `MAX_MATERIAL_CHARS` like any payload, but usually a
 * tenth of it.
 *
 * `fields` are the facts a filter needs to see (`sender`, `channel`, `branch`)
 * without parsing `text` back apart.
 */
export type NormalizedEvent = {
  eventId: string;
  text: string;
  /** Overrides the entry's label for this one run: "GitHub · Push to main". */
  label?: string;
  fields?: Record<string, string>;
};

export type EventTypeDef = {
  /** Stable forever once shipped; routine rows hold it. `<app>.<what>`. */
  id: string;
  provider: EventProvider;
  /** What the dialog groups by: "Gmail", "Google Calendar". */
  app: string;
  /** What happened: "New mail", "Event starting soon". */
  label: string;
  /** One sentence the dialog shows under the choice. */
  description: string;
  requires: EventRequirement;
  /** What the API accepts as this event's config. Unknown keys are dropped. */
  config: z.ZodType<Record<string, unknown>>;
  fields: EventField[];
  /**
   * The filter the worker applies after the event arrives, for what the
   * provider cannot filter itself. Absent means every event the provider sends
   * runs the routine — which is right when the filter was already sent to the
   * provider, and the better place for it, because an event filtered there is
   * one nobody had to receive.
   */
  matches?: (config: Record<string, unknown>, event: NormalizedEvent) => boolean;
  /**
   * A made-up event of this kind, for "Send a test event": what the run reads
   * when the person wants to see the routine work without waiting for the
   * real thing.
   */
  sample: NormalizedEvent;
};

/**
 * The list, in the order the dialog offers it. Each provider's entries live
 * beside the adapter half that serves them; see the module comment.
 */
export const EVENT_TYPES: readonly EventTypeDef[] = [
  ...[
    ...COMPOSIO_EVENTS,
    ...GITHUB_EVENTS,
    ...WEBSUB_EVENTS,
    ...NOTION_EVENTS,
    ...DRIVE_EVENTS,
  ].map((spec) => spec.def),
  // Slack's entries are plain definitions: there is nothing per entry for the
  // adapter to keep beside them (`slack.ts`).
  ...SLACK_EVENTS,
];

/** `routine_runs.trigger_label` is at most this long (0109). */
export const MAX_TRIGGER_LABEL = 120;

/** "Gmail · New mail" — what a run's history says started it. */
export function triggerLabel(def: Pick<EventTypeDef, "app" | "label">, override?: string): string {
  return (override ?? `${def.app} · ${def.label}`).slice(0, MAX_TRIGGER_LABEL);
}

/**
 * The two lookups everything else goes through, as an object so a test can
 * hand in a catalogue of its own without mocking a module.
 */
export type EventCatalogue = {
  eventType: (id: string) => EventTypeDef | undefined;
  all: () => readonly EventTypeDef[];
};

export function catalogueOf(types: readonly EventTypeDef[]): EventCatalogue {
  const byId = new Map(types.map((t) => [t.id, t]));
  return { eventType: (id) => byId.get(id), all: () => types };
}

export const CATALOGUE: EventCatalogue = catalogueOf(EVENT_TYPES);

/**
 * What a person chose, checked against the catalogue: the entry, and the config
 * as the entry's schema left it. The one place a choice becomes trusted, used
 * by both `POST /routines` and `PUT /routines/:id/event`, so the two cannot
 * accept different things.
 */
export type EventChoice = { def: EventTypeDef; config: Record<string, unknown> };

export function parseEventChoice(
  catalogue: EventCatalogue,
  type: string,
  config: unknown,
): { ok: true; choice: EventChoice } | { ok: false; error: string } {
  const def = catalogue.eventType(type);
  if (!def) return { ok: false, error: "unknown event type" };
  const parsed = def.config.safeParse(config ?? {});
  if (!parsed.success) {
    // The first problem, named by its field, because the dialog shows one line.
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "config";
    return { ok: false, error: `${where}: ${issue?.message ?? "invalid"}` };
  }
  return { ok: true, choice: { def, config: parsed.data } };
}
