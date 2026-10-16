/**
 * The events Composio listens for on Covan's behalf: Gmail, Outlook and
 * Google Calendar.
 *
 * Each entry is two halves. The `def` is the catalogue's business
 * (`catalog.ts`) — what a person picks, what config is accepted, how the
 * dialog asks for it. The rest is Composio's: which trigger type to make
 * (`slug`), what to put in its `trigger_config`, and how to make a delivery's
 * `data` into a paragraph for the model. Kept apart from the adapter
 * (`composio.ts`) so the catalogue can be imported without the HTTP client and
 * the service role coming with it.
 *
 * WHERE THE FILTERS GO. Into `trigger_config`, wherever Composio's trigger
 * takes one: a Gmail search, an Outlook folder and sender, a calendar id. A
 * mail that does not match is then never delivered at all — nothing is read,
 * nothing is counted, nothing runs — which is better than receiving it and
 * dropping it here. So none of these entries has a `matches`.
 *
 * WHAT IS NOT HERE, AND WHY.
 *   HubSpot   Composio's HubSpot triggers want an `app_id` and a developer API
 *             key — a HubSpot developer app of the person's own — before they
 *             deliver anything. That is a setup nobody connecting HubSpot from
 *             the Integrations page has done, and a developer key is a secret
 *             that would have to live somewhere better than `config`. Left for
 *             a native HubSpot integration.
 *   Outlook   Only "a new event", not "an event changed": the change trigger
 *   changes   fires for every edit of every event, with nothing to filter on.
 *
 * TIMING. Gmail and Google Calendar triggers are polled by Composio, not
 * pushed, so an event arrives on Composio's polling schedule — minutes, not
 * seconds. Outlook's are pushed. Nothing here can change that, and the
 * dialog says "shortly after", not "the moment".
 */

import { z } from "zod";
import type { EventTypeDef, NormalizedEvent } from "./catalog";

/**
 * How a description asks Composio for more than the delivery carried — an
 * Outlook delivery is an id and nothing else. `null` when the call failed; the
 * description then says what it can from the id.
 */
export type ToolFetch = (slug: string, args: Record<string, unknown>) => Promise<unknown | null>;

export type ComposioEventSpec = {
  def: EventTypeDef;
  /** Composio's trigger type. Checked by `composio-webhook-subscribe.ts`. */
  slug: string;
  /** The person's config, as Composio's trigger wants it. */
  triggerConfig: (config: Record<string, unknown>) => Record<string, unknown>;
  /** A delivery's `data`, in a paragraph. `null` runs nothing. */
  describe: (data: Record<string, unknown>, fetch: ToolFetch) => Promise<NormalizedEvent | null>;
};

/**
 * The most of a message body the model is shown. A routine about a mail needs
 * what the mail says, and a quoted thread underneath it is mostly what earlier
 * mails said; the run's own `MAX_MATERIAL_CHARS` is the ceiling, this is
 * what a reasonable reply is made from.
 */
const MAX_BODY_CHARS = 6_000;

// ---- small readers ----------------------------------------------------------

function str(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Lines with a value, joined — a missing field is left out, not "undefined". */
function lines(pairs: Array<[string, string]>): string {
  return pairs
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

function clip(text: string, max = MAX_BODY_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n[…cut at ${max} characters]` : text;
}

/** HTML to readable text, roughly — enough for a model, not for a browser. */
export function textOfHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The result of a Composio tool call, unwrapped. `executeTool` answers the
 * whole envelope; the record is under `data`, and on some tools under
 * `data.response_data` a level further down.
 */
export function toolData(body: unknown): Record<string, unknown> | null {
  let value: unknown = body;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const outer = rec(value);
  const data = rec(outer?.data) ?? outer;
  return rec(data?.response_data) ?? data;
}

/** An Outlook address object (`{emailAddress:{name,address}}`) as one string. */
function outlookAddress(value: unknown): string {
  const inner = rec(rec(value)?.emailAddress);
  if (!inner) return "";
  const name = str(inner.name);
  const address = str(inner.address);
  return name && address && name !== address ? `${name} <${address}>` : address || name;
}

function outlookAddresses(value: unknown): string {
  return Array.isArray(value) ? value.map(outlookAddress).filter(Boolean).join(", ") : "";
}

/** An Outlook `{dateTime, timeZone}` as one string. */
function outlookTime(value: unknown): string {
  const r = rec(value);
  if (!r) return str(value);
  return [str(r.dateTime), str(r.timeZone)].filter(Boolean).join(" ");
}

// ---- config schemas -----------------------------------------------------------

/** An optional bit of text: trimmed, and empty means absent. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

const GMAIL_LABELS = [
  { value: "INBOX", label: "Inbox" },
  { value: "IMPORTANT", label: "Important" },
  { value: "STARRED", label: "Starred" },
  { value: "UNREAD", label: "Unread" },
  { value: "CATEGORY_PERSONAL", label: "Primary" },
] as const;

const gmailConfig = z.object({
  query: optionalText(500),
  label: z.enum(GMAIL_LABELS.map((l) => l.value) as [string, ...string[]]).optional(),
});

const outlookMailConfig = z.object({
  folder: optionalText(200),
  fromEmail: optionalText(320),
  subjectContains: optionalText(200),
  hasAttachments: z.boolean().optional(),
});

const calendarConfig = z.object({ calendarId: optionalText(300) });

const startingSoonConfig = z.object({
  calendarId: optionalText(300),
  minutesBefore: z.coerce.number().int().min(1).max(240).default(15),
});

const CALENDAR_FIELD = {
  key: "calendarId",
  label: "Calendar",
  kind: "text" as const,
  optional: true,
  placeholder: "primary",
  help: "Leave empty for your main calendar, or paste another calendar's id.",
  advanced: true,
};

// ---- the entries ----------------------------------------------------------------

const gmailNewMessage: ComposioEventSpec = {
  slug: "GMAIL_NEW_GMAIL_MESSAGE",
  def: {
    id: "gmail.new_message",
    provider: "composio",
    app: "Gmail",
    label: "New email",
    description: "Runs shortly after a matching email arrives in your Gmail.",
    requires: { kind: "composio", toolkit: "gmail" },
    config: gmailConfig,
    fields: [
      {
        key: "query",
        label: "Only emails matching",
        kind: "text",
        optional: true,
        placeholder: "from:billing@example.com has:attachment",
        help: "A Gmail search, as you would type it in Gmail. Empty means every new email in the inbox.",
      },
      {
        key: "label",
        label: "In",
        placeholder: "Inbox",
        kind: "select",
        optional: true,
        options: [...GMAIL_LABELS],
        help: "Used when there is no search. With a search, write it there instead: in:inbox, is:starred.",
        advanced: true,
      },
    ],
    sample: {
      eventId: "sample",
      text:
        lines([
          ["From", "Ayşe Demir <ayse@example.com>"],
          ["To", "you@example.com"],
          ["Subject", "Thursday's review"],
        ]) + "\n\nHi — does Thursday at 14:00 still work for the review? I can move it to Friday.",
    },
  },
  // A search wins over a label at Composio, so only one is sent. With neither,
  // the inbox: without a label the trigger also fires for mail you sent.
  triggerConfig: (config) =>
    config.query ? { query: config.query } : { labelIds: (config.label as string) ?? "INBOX" },
  describe: async (data) => {
    const id = str(data.message_id) || str(data.id);
    if (!id) return null;
    const subject = str(data.subject);
    const sender = str(data.sender);
    const header = lines([
      ["From", sender],
      ["To", str(data.to)],
      ["Subject", subject || "(no subject)"],
      ["Received", str(data.message_timestamp)],
      [
        "Attachments",
        Array.isArray(data.attachment_list) && data.attachment_list.length > 0
          ? String(data.attachment_list.length)
          : "",
      ],
    ]);
    const body = str(data.message_text);
    return {
      eventId: `gmail:${id}`,
      text: body ? `${header}\n\n${clip(body)}` : header,
      fields: { sender, subject },
    };
  },
};

const outlookNewMessage: ComposioEventSpec = {
  slug: "OUTLOOK_MESSAGE_TRIGGER",
  def: {
    id: "outlook.new_message",
    provider: "composio",
    app: "Outlook",
    label: "New email",
    description: "Runs when a matching email arrives in your Outlook mailbox.",
    requires: { kind: "composio", toolkit: "outlook" },
    config: outlookMailConfig,
    fields: [
      {
        key: "fromEmail",
        label: "Only from",
        kind: "text",
        optional: true,
        placeholder: "billing@example.com",
      },
      {
        key: "subjectContains",
        label: "Subject contains",
        kind: "text",
        optional: true,
      },
      {
        key: "hasAttachments",
        label: "Only emails with attachments",
        kind: "boolean",
        optional: true,
      },
      {
        key: "folder",
        label: "Folder",
        kind: "text",
        optional: true,
        placeholder: "inbox",
        help: "A folder name such as inbox or archive, or a folder id.",
        advanced: true,
      },
    ],
    sample: {
      eventId: "sample",
      text:
        lines([
          ["From", "Ayşe Demir <ayse@example.com>"],
          ["Subject", "Invoice 2026-114"],
        ]) + "\n\nHi, attached is this month's invoice. Payment is due on the 30th.",
    },
  },
  triggerConfig: (config) => {
    const out: Record<string, unknown> = {};
    if (config.folder) out.folder_id = config.folder;
    if (config.fromEmail) out.from_email = config.fromEmail;
    if (config.subjectContains) out.subject_contains = config.subjectContains;
    if (config.hasAttachments === true) out.has_attachments = true;
    return out;
  },
  // The delivery is an id; the message is asked for. If that fails the run
  // still happens, with what little the delivery said — a routine that never
  // hears about a mail because a lookup failed is the worse outcome.
  describe: async (data, fetch) => {
    const id = str(data.id);
    if (!id) return null;
    const fetched = toolData(
      await fetch("OUTLOOK_GET_MESSAGE", {
        message_id: id,
        select: ["subject", "from", "toRecipients", "receivedDateTime", "body", "hasAttachments"],
      }),
    );
    const message = fetched ?? rec(data.outlook_message) ?? {};
    const sender = outlookAddress(message.from);
    const subject = str(message.subject);
    const bodyRec = rec(message.body);
    const rawBody = str(bodyRec?.content) || str(message.bodyPreview);
    const body = str(bodyRec?.contentType).toLowerCase() === "html" ? textOfHtml(rawBody) : rawBody;
    const header = lines([
      ["From", sender],
      ["To", outlookAddresses(message.toRecipients)],
      ["Subject", subject || "(no subject)"],
      ["Received", str(message.receivedDateTime)],
      ["Has attachments", message.hasAttachments === true ? "yes" : ""],
    ]);
    return {
      eventId: `outlook:${id}`,
      text: body ? `${header}\n\n${clip(body)}` : header,
      fields: { sender, subject },
    };
  },
};

const outlookNewEvent: ComposioEventSpec = {
  slug: "OUTLOOK_EVENT_TRIGGER",
  def: {
    id: "outlook.new_event",
    provider: "composio",
    app: "Outlook",
    label: "New calendar event",
    description: "Runs when an event is added to your Outlook calendar.",
    requires: { kind: "composio", toolkit: "outlook" },
    config: z.object({}),
    fields: [],
    sample: {
      eventId: "sample",
      text: lines([
        ["Event", "Quarterly planning"],
        ["Starts", "2026-11-03T10:00:00 Europe/Istanbul"],
        ["Ends", "2026-11-03T11:30:00 Europe/Istanbul"],
        ["Organizer", "Ayşe Demir <ayse@example.com>"],
        ["Attendees", "you@example.com, mert@example.com"],
      ]),
    },
  },
  triggerConfig: () => ({}),
  describe: async (data, fetch) => {
    const id = str(data.id);
    if (!id) return null;
    const event = toolData(await fetch("OUTLOOK_GET_EVENT", { event_id: id })) ?? {};
    const bodyRec = rec(event.body);
    const rawBody = str(bodyRec?.content) || str(event.bodyPreview);
    const body = str(bodyRec?.contentType).toLowerCase() === "html" ? textOfHtml(rawBody) : rawBody;
    const header = lines([
      ["Event", str(event.subject) || "(untitled event)"],
      ["Starts", outlookTime(event.start)],
      ["Ends", outlookTime(event.end)],
      ["Where", str(rec(event.location)?.displayName)],
      ["Organizer", outlookAddress(event.organizer)],
      [
        "Attendees",
        Array.isArray(event.attendees) ? event.attendees.map(outlookAddress).join(", ") : "",
      ],
    ]);
    return { eventId: `outlook-event:${id}`, text: body ? `${header}\n\n${clip(body)}` : header };
  },
};

/** Composio wants `calendarId`; empty means the person's main calendar. */
function calendarTarget(config: Record<string, unknown>): Record<string, unknown> {
  return { calendarId: (config.calendarId as string | undefined) ?? "primary" };
}

const gcalCreated: ComposioEventSpec = {
  slug: "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_CREATED_TRIGGER",
  def: {
    id: "gcal.event_created",
    provider: "composio",
    app: "Google Calendar",
    label: "New event",
    description: "Runs shortly after an event is added to your calendar.",
    requires: { kind: "composio", toolkit: "googlecalendar" },
    config: calendarConfig,
    fields: [CALENDAR_FIELD],
    sample: {
      eventId: "sample",
      text: lines([
        ["Event", "Intro call with Mert"],
        ["Starts", "2026-11-04T15:00:00+03:00"],
        ["Ends", "2026-11-04T15:30:00+03:00"],
        ["Organizer", "Mert Kaya <mert@example.com>"],
      ]),
    },
  },
  triggerConfig: calendarTarget,
  describe: async (data) => {
    const id = str(data.event_id);
    if (!id) return null;
    const organizer = [str(data.organizer_name), str(data.organizer_email)]
      .filter(Boolean)
      .join(" ");
    return {
      eventId: `gcal-created:${id}`,
      text: lines([
        ["Event", str(data.summary) || "(untitled event)"],
        ["Starts", str(data.start_time)],
        ["Ends", str(data.end_time)],
        ["Organizer", organizer],
        ["Calendar", str(data.calendar_id)],
      ]),
    };
  },
};

const gcalUpdated: ComposioEventSpec = {
  slug: "GOOGLECALENDAR_GOOGLE_CALENDAR_EVENT_UPDATED_TRIGGER",
  def: {
    id: "gcal.event_updated",
    provider: "composio",
    app: "Google Calendar",
    label: "Event changed",
    description: "Runs shortly after an event on your calendar is moved or edited.",
    requires: { kind: "composio", toolkit: "googlecalendar" },
    config: calendarConfig,
    fields: [CALENDAR_FIELD],
    sample: {
      eventId: "sample",
      text: lines([
        ["Event", "Weekly sync"],
        ["Changed", "start: 2026-11-05T10:00:00+03:00 → 2026-11-05T11:00:00+03:00"],
      ]),
    },
  },
  triggerConfig: calendarTarget,
  describe: async (data) => {
    const id = str(data.event_id);
    if (!id) return null;
    const changed = rec(data.updated_fields) ?? {};
    const changes = Object.entries(changed)
      .slice(0, 20)
      .map(([field, value]) => {
        const v = rec(value);
        const before = v ? JSON.stringify(v.old ?? v.previous ?? v.before ?? null) : "";
        const after = v ? JSON.stringify(v.new ?? v.current ?? v.after ?? null) : "";
        return v ? `${field}: ${before} → ${after}` : `${field}: ${JSON.stringify(value)}`;
      })
      .join("\n");
    const summaryChange = rec(changed.summary);
    const title = str(data.summary) || str(summaryChange?.new) || "(event)";
    return {
      // The same event changes many times; each change is its own event.
      eventId: `gcal-updated:${id}:${str(data.updated_at)}`,
      text: `${lines([
        ["Event", title],
        ["Event id", id],
        ["Updated", str(data.updated_at)],
      ])}\n\nWhat changed:\n${clip(changes || "(not described)", 3_000)}`,
    };
  },
};

const gcalStartingSoon: ComposioEventSpec = {
  slug: "GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER",
  def: {
    id: "gcal.starting_soon",
    provider: "composio",
    app: "Google Calendar",
    label: "Event starting soon",
    description: "Runs a set number of minutes before each event on your calendar starts.",
    requires: { kind: "composio", toolkit: "googlecalendar" },
    config: startingSoonConfig,
    fields: [
      {
        key: "minutesBefore",
        label: "Minutes before it starts",
        kind: "number",
        optional: true,
        placeholder: "15",
      },
      CALENDAR_FIELD,
    ],
    sample: {
      eventId: "sample",
      text: lines([
        ["Event", "Customer call — Acme"],
        ["Starts in", "15 minutes (2026-11-06T14:00:00+03:00)"],
        ["Attendees", "you@example.com, buyer@acme.example"],
        ["Join", "https://meet.google.com/abc-defg-hij"],
      ]),
    },
  },
  triggerConfig: (config) => ({
    ...calendarTarget(config),
    minutesBeforeStart: config.minutesBefore ?? 15,
  }),
  describe: async (data) => {
    const id = str(data.event_id);
    if (!id) return null;
    const minutes = str(data.minutes_until_start);
    const starts = str(data.start_time);
    const attendees = Array.isArray(data.attendees)
      ? data.attendees
          .map((a) => (typeof a === "string" ? a : str(rec(a)?.email)))
          .filter(Boolean)
          .join(", ")
      : "";
    const description = str(data.description);
    const header = lines([
      ["Event", str(data.summary) || "(untitled event)"],
      ["Starts in", minutes ? `${Math.round(Number(minutes))} minutes (${starts})` : starts],
      ["Where", str(data.location)],
      ["Organizer", str(data.organizer_email)],
      ["Attendees", attendees],
      ["Join", str(data.hangout_link)],
      ["Link", str(data.html_link)],
    ]);
    return {
      // One per occurrence: a weekly meeting starts soon every week.
      eventId: `gcal-soon:${id}:${str(data.start_timestamp) || starts}`,
      text: description ? `${header}\n\n${clip(description, 3_000)}` : header,
    };
  },
};

const gcalCanceled: ComposioEventSpec = {
  slug: "GOOGLECALENDAR_EVENT_CANCELED_DELETED_TRIGGER",
  def: {
    id: "gcal.event_canceled",
    provider: "composio",
    app: "Google Calendar",
    label: "Event canceled",
    description: "Runs shortly after an event on your calendar is canceled or deleted.",
    requires: { kind: "composio", toolkit: "googlecalendar" },
    config: calendarConfig,
    fields: [CALENDAR_FIELD],
    sample: {
      eventId: "sample",
      text: lines([
        ["Canceled", "Design review"],
        ["At", "2026-11-07T09:12:00Z"],
      ]),
    },
  },
  triggerConfig: calendarTarget,
  describe: async (data) => {
    const id = str(data.event_id);
    if (!id) return null;
    return {
      eventId: `gcal-canceled:${id}`,
      text: lines([
        ["Canceled", str(data.summary) || "(an event whose title Google no longer shows)"],
        ["Event id", id],
        ["At", str(data.cancelled_at)],
      ]),
    };
  },
};

export const COMPOSIO_EVENTS: readonly ComposioEventSpec[] = [
  gmailNewMessage,
  outlookNewMessage,
  outlookNewEvent,
  gcalCreated,
  gcalUpdated,
  gcalStartingSoon,
  gcalCanceled,
];

const BY_ID = new Map(COMPOSIO_EVENTS.map((spec) => [spec.def.id, spec]));

export function composioSpec(eventTypeId: string): ComposioEventSpec | undefined {
  return BY_ID.get(eventTypeId);
}
