import { executeTool, type ComposioEnv } from "../composio/client";

/**
 * Thirty days of what arrived, read through Composio and kept in memory only.
 *
 * Every reader returns `ArrivalItem`s: a sender's domain (never the address),
 * a subject, at most 200 characters of preview, and a few flags. Nothing here
 * writes anywhere; `scan.ts` hands the items to the model and keeps counts.
 *
 * The operations, probed against Composio's catalogue on 2026-10-26 (input and
 * output schemas from `GET /api/v3.1/tools/<slug>`; no mailbox was read for
 * the probe, so the shapes are the published ones):
 *
 *   gmail           GMAIL_FETCH_EMAILS — `query`, `max_results`, `page_token`,
 *                   `verbose: false` + `include_payload: false` for metadata
 *                   only. Answers `data.messages[]` (`messageId`, `threadId`,
 *                   `sender`, `subject`, `messageTimestamp`, `labelIds`,
 *                   `preview`, `messageText`) and `data.nextPageToken`. Sent
 *                   mail is NOT excluded from the query: a `SENT` label in the
 *                   same thread is how a reply is known.
 *   outlook (mail)  OUTLOOK_LIST_MESSAGES — `folder`, `top`, `page_token`,
 *                   `received_date_time_ge`, `select`. Answers `data.value[]`
 *                   (`conversationId`, `subject`, `from.emailAddress.address`,
 *                   `receivedDateTime`/`sentDateTime`, `bodyPreview`) and
 *                   `data.next_page_token`. Read twice: the inbox, then one
 *                   page of `sentitems` to know which conversations got a reply.
 *   outlook (cal.)  OUTLOOK_GET_CALENDAR_VIEW — `start_datetime`,
 *                   `end_datetime`, `top`. Answers `data.value[]` (`subject`,
 *                   `start`/`end.dateTime`, `attendees[]`, `isOrganizer`,
 *                   `type`, `isCancelled`).
 *   googlecalendar  GOOGLECALENDAR_EVENTS_LIST — `calendarId`, `timeMin`,
 *                   `timeMax`, `maxResults`, `singleEvents`. Answers
 *                   `data.items[]` (`summary`, `status`, `start`/`end` with
 *                   `dateTime` or `date`, `attendees[]`, `organizer.self`,
 *                   `recurringEventId`).
 */

export type ArrivalItem = {
  /** Thread, conversation or event id; used in memory only. */
  id: string;
  source: "mail" | "event";
  /** The sender's domain; "" for events. */
  domain: string;
  subject: string;
  /** At most 200 characters; "" for events. */
  snippet: string;
  /** ISO time of the newest message, or of the event's start. */
  at: string;
  /** The newest message in the thread is the person's own. */
  fromMe: boolean;
  /** Any message in the thread is the person's own. */
  repliedByMe: boolean;
  attendees?: number;
  durationMin?: number;
  organisedByMe?: boolean;
  recurring?: boolean;
};

export type ScanToolkit = "gmail" | "outlook" | "googlecalendar";

export type ReadSource = {
  connectionId: string;
  toolkit: ScanToolkit;
  account: { connectedAccountId: string; composioUserId: string };
};

export type ReadResult = {
  items: ArrivalItem[];
  /** Tool slugs executed, one per call, for metering. */
  calls: string[];
  /** The person's own mail domains, seen on their sent mail. */
  selfDomains: string[];
};

export const MAIL_CAP = 200;
export const MAIL_PAGE = 100;
export const EVENT_CAP = 250;
export const WINDOW_DAYS = 30;
export const SNIPPET_MAX = 200;

/**
 * A source that could not be read. `calls` were still made, and are still paid
 * for. `status` is Composio's: 5xx is worth another attempt, anything else (an
 * expired grant, a refused scope, a 200 that said it failed) is not.
 */
export class ArrivalReadError extends Error {
  constructor(
    message: string,
    readonly calls: string[],
    readonly status = 0,
  ) {
    super(message);
    this.name = "ArrivalReadError";
  }
}

// ---------------------------------------------------------------------------
// small readers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isRecord(x: unknown): x is Json {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function str(x: unknown): string {
  return typeof x === "string" ? x : "";
}

/** `data` of a Composio body, or null when the body is not one. */
function dataOf(body: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return null;
    return isRecord(parsed.data) ? parsed.data : parsed;
  } catch {
    return null;
  }
}

function list(x: unknown): Json[] {
  return Array.isArray(x) ? x.filter(isRecord) : [];
}

/** The domain of `Name <a@b.c>` or `a@b.c`, lower-cased; "" when there is none. */
function domainOf(sender: string): string {
  const match = /@([^>\s]+)/.exec(sender);
  return match ? match[1].toLowerCase().replace(/[>.]+$/, "") : "";
}

/** ISO from an ISO string or epoch milliseconds; "" when neither. */
function isoOf(raw: unknown): string {
  const s = str(raw).trim();
  if (!s) return "";
  const ms = /^\d{10,}$/.test(s)
    ? Number(s)
    : Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) || !s.includes("T") ? s : `${s}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
}

function cut(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, SNIPPET_MAX);
}

function newestFirst<T extends { at: string }>(a: T, b: T): number {
  return b.at.localeCompare(a.at);
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))].sort();
}

// ---------------------------------------------------------------------------
// gmail
// ---------------------------------------------------------------------------

type MailMessage = {
  thread: string;
  domain: string;
  subject: string;
  snippet: string;
  at: string;
  mine: boolean;
};

export function parseGmail(body: string): { messages: MailMessage[]; nextPage: string | null } {
  const data = dataOf(body);
  if (!data) return { messages: [], nextPage: null };
  const messages = list(data.messages).map((m): MailMessage => {
    const labels = Array.isArray(m.labelIds) ? m.labelIds : [];
    const preview = isRecord(m.preview) ? str(m.preview.body) : "";
    return {
      thread: str(m.threadId) || str(m.messageId),
      domain: domainOf(str(m.sender)),
      subject: str(m.subject),
      snippet: cut(preview || str(m.messageText)),
      at: isoOf(m.messageTimestamp),
      mine: labels.includes("SENT"),
    };
  });
  return { messages, nextPage: str(data.nextPageToken) || null };
}

/** One item per thread somebody else wrote into; a thread of only the person's own mail is none. */
function threads(messages: MailMessage[]): ArrivalItem[] {
  const byThread = new Map<string, MailMessage[]>();
  for (const m of messages) {
    if (!m.thread) continue;
    byThread.set(m.thread, [...(byThread.get(m.thread) ?? []), m]);
  }
  const items: ArrivalItem[] = [];
  for (const [id, group] of byThread) {
    const sorted = [...group].sort(newestFirst);
    const theirs = sorted.find((m) => !m.mine);
    if (!theirs) continue;
    items.push({
      id,
      source: "mail",
      domain: theirs.domain,
      subject: theirs.subject,
      snippet: theirs.snippet,
      at: sorted[0].at,
      fromMe: sorted[0].mine,
      repliedByMe: sorted.some((m) => m.mine),
    });
  }
  return items.sort(newestFirst);
}

export function gmailThreads(messages: MailMessage[]): {
  items: ArrivalItem[];
  selfDomains: string[];
} {
  return {
    items: threads(messages),
    selfDomains: unique(messages.filter((m) => m.mine).map((m) => m.domain)),
  };
}

// ---------------------------------------------------------------------------
// outlook
// ---------------------------------------------------------------------------

export function parseOutlookMail(body: string): {
  messages: MailMessage[];
  nextPage: string | null;
} {
  const data = dataOf(body);
  if (!data) return { messages: [], nextPage: null };
  const messages = list(data.value).map((m): MailMessage => {
    const from =
      isRecord(m.from) && isRecord(m.from.emailAddress) ? str(m.from.emailAddress.address) : "";
    return {
      thread: str(m.conversationId) || str(m.id),
      domain: domainOf(from),
      subject: str(m.subject),
      snippet: cut(str(m.bodyPreview)),
      at: isoOf(m.receivedDateTime) || isoOf(m.sentDateTime),
      mine: false,
    };
  });
  return { messages, nextPage: str(data.next_page_token) || null };
}

/** The inbox joined to one page of the sent folder by conversation. */
export function outlookThreads(
  received: MailMessage[],
  sent: MailMessage[],
): { items: ArrivalItem[]; selfDomains: string[] } {
  const ids = new Set(received.map((m) => m.thread));
  const mine = sent.filter((m) => ids.has(m.thread)).map((m) => ({ ...m, mine: true }));
  return {
    items: threads([...received, ...mine]),
    selfDomains: unique(sent.map((m) => m.domain)),
  };
}

// ---------------------------------------------------------------------------
// calendars
// ---------------------------------------------------------------------------

function minutesBetween(start: string, end: string): number | undefined {
  if (!start || !end) return undefined;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 60_000) : undefined;
}

function event(
  id: string,
  subject: string,
  start: string,
  end: string,
  extra: Partial<ArrivalItem>,
): ArrivalItem {
  return {
    id,
    source: "event",
    domain: "",
    subject,
    snippet: "",
    at: start,
    fromMe: false,
    repliedByMe: false,
    durationMin: minutesBetween(start, end),
    ...extra,
  };
}

function googleTime(x: unknown): string {
  if (!isRecord(x)) return "";
  return isoOf(x.dateTime) || isoOf(x.date);
}

export function parseGoogleCalendar(body: string): {
  items: ArrivalItem[];
  nextPage: string | null;
} {
  const data = dataOf(body);
  if (!data) return { items: [], nextPage: null };
  const items = list(data.items)
    .filter((e) => str(e.status) !== "cancelled")
    .map((e) =>
      event(str(e.id), str(e.summary), googleTime(e.start), googleTime(e.end), {
        attendees: list(e.attendees).length,
        organisedByMe: isRecord(e.organizer) && e.organizer.self === true,
        recurring: Boolean(str(e.recurringEventId)) || Array.isArray(e.recurrence),
      }),
    );
  return { items, nextPage: str(data.nextPageToken) || null };
}

function outlookTime(x: unknown): string {
  return isRecord(x) ? isoOf(x.dateTime) : "";
}

export function parseOutlookCalendar(body: string): {
  items: ArrivalItem[];
  nextPage: string | null;
} {
  const data = dataOf(body);
  if (!data) return { items: [], nextPage: null };
  const items = list(data.value)
    .filter((e) => e.isCancelled !== true)
    .map((e) =>
      event(str(e.id), str(e.subject), outlookTime(e.start), outlookTime(e.end), {
        attendees: list(e.attendees).length,
        organisedByMe: e.isOrganizer === true,
        recurring: ["occurrence", "exception", "seriesMaster"].includes(str(e.type)),
      }),
    );
  return { items, nextPage: str(data.next_page_token) || null };
}

// ---------------------------------------------------------------------------
// reading a source
// ---------------------------------------------------------------------------

/** Composio does not charge for the two failures that never left it. */
function billed(status: number): boolean {
  return status !== 501 && status !== 502;
}

export async function readSource(
  env: ComposioEnv,
  source: ReadSource,
  now: Date,
): Promise<ReadResult> {
  const calls: string[] = [];
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString();
  const until = now.toISOString();

  async function call(slug: string, args: Record<string, unknown>): Promise<string> {
    const res = await executeTool(env, {
      slug,
      connectedAccountId: source.account.connectedAccountId || undefined,
      userId: source.account.composioUserId,
      arguments: args,
    });
    if (res.kind === "error") {
      if (billed(res.status)) calls.push(slug);
      throw new ArrivalReadError(res.message, calls, res.status);
    }
    calls.push(slug);
    return res.body;
  }

  async function pages(
    slug: string,
    args: (cursor: string | null) => Record<string, unknown>,
    parse: (body: string) => { messages: MailMessage[]; nextPage: string | null },
  ): Promise<MailMessage[]> {
    const out: MailMessage[] = [];
    let cursor: string | null = null;
    do {
      const page = parse(await call(slug, args(cursor)));
      out.push(...page.messages);
      cursor = page.nextPage;
    } while (cursor && out.length < MAIL_CAP);
    return out.slice(0, MAIL_CAP);
  }

  switch (source.toolkit) {
    case "gmail": {
      const messages = await pages(
        "GMAIL_FETCH_EMAILS",
        (cursor) => ({
          query: `newer_than:${WINDOW_DAYS}d -category:promotions -category:social`,
          max_results: MAIL_PAGE,
          verbose: false,
          include_payload: false,
          ...(cursor ? { page_token: cursor } : {}),
        }),
        parseGmail,
      );
      return { ...gmailThreads(messages), calls };
    }
    case "outlook": {
      const received = await pages(
        "OUTLOOK_LIST_MESSAGES",
        (cursor) => ({
          folder: "inbox",
          top: MAIL_PAGE,
          received_date_time_ge: since,
          select: ["id", "conversationId", "subject", "from", "receivedDateTime", "bodyPreview"],
          ...(cursor ? { page_token: cursor } : {}),
        }),
        parseOutlookMail,
      );
      const sent = parseOutlookMail(
        await call("OUTLOOK_LIST_MESSAGES", {
          folder: "sentitems",
          top: MAIL_PAGE,
          select: ["id", "conversationId", "from", "sentDateTime"],
        }),
      ).messages;
      const mail = outlookThreads(received, sent);
      const calendar = parseOutlookCalendar(
        await call("OUTLOOK_GET_CALENDAR_VIEW", {
          start_datetime: since,
          end_datetime: until,
          top: EVENT_CAP,
        }),
      ).items;
      return {
        items: [...mail.items, ...calendar.slice(0, EVENT_CAP)],
        calls,
        selfDomains: mail.selfDomains,
      };
    }
    case "googlecalendar": {
      const { items } = parseGoogleCalendar(
        await call("GOOGLECALENDAR_EVENTS_LIST", {
          calendarId: "primary",
          timeMin: since,
          timeMax: until,
          maxResults: EVENT_CAP,
          singleEvents: true,
        }),
      );
      return { items: items.slice(0, EVENT_CAP), calls, selfDomains: [] };
    }
  }
}
