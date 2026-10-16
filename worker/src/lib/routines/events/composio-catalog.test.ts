import { describe, it, expect, vi } from "vitest";
import { COMPOSIO_EVENTS, composioSpec, textOfHtml, toolData } from "./composio-catalog";
import { CATALOGUE, MAX_TRIGGER_LABEL, parseEventChoice, triggerLabel } from "./catalog";

const spec = (id: string) => {
  const found = composioSpec(id);
  if (!found) throw new Error(`no spec ${id}`);
  return found;
};
const config = (id: string, input: unknown) => {
  const parsed = parseEventChoice(CATALOGUE, id, input);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.choice.config;
};
const noFetch = vi.fn(async () => null);

describe("the Composio entries", () => {
  it("are the catalogue, each once, each served by Composio", () => {
    const ids = CATALOGUE.all().map((d) => d.id);
    expect(ids).toEqual(COMPOSIO_EVENTS.map((s) => s.def.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of COMPOSIO_EVENTS) {
      expect(s.def.provider).toBe("composio");
      expect(s.def.requires.kind).toBe("composio");
      expect(s.slug).toMatch(/^[A-Z][A-Z_]+_TRIGGER$|^GMAIL_NEW_GMAIL_MESSAGE$/);
      expect(s.def.id).toMatch(/^[a-z]+\.[a-z_]+$/);
      expect(triggerLabel(s.def).length).toBeLessThanOrEqual(MAX_TRIGGER_LABEL);
    }
  });

  it("each accept an empty config, so a person can pick one and go", () => {
    for (const s of COMPOSIO_EVENTS) {
      expect(parseEventChoice(CATALOGUE, s.def.id, {}).ok).toBe(true);
    }
  });

  it("each draw a field for every key their schema keeps", () => {
    for (const s of COMPOSIO_EVENTS) {
      const shape = (s.def.config as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      expect(Object.keys(shape).sort()).toEqual(s.def.fields.map((f) => f.key).sort());
    }
  });

  it("each describe their own sample without throwing", async () => {
    for (const s of COMPOSIO_EVENTS) {
      expect(s.def.sample.text.length).toBeGreaterThan(10);
    }
  });
});

describe("gmail.new_message", () => {
  const s = spec("gmail.new_message");

  it("listens to the inbox when asked for nothing, not to mail you sent", () => {
    expect(s.triggerConfig(config("gmail.new_message", {}))).toEqual({ labelIds: "INBOX" });
  });

  it("sends a search alone, since Composio lets a search win over a label", () => {
    expect(
      s.triggerConfig(config("gmail.new_message", { query: "from:x@y.z", label: "STARRED" })),
    ).toEqual({ query: "from:x@y.z" });
    expect(s.triggerConfig(config("gmail.new_message", { label: "STARRED" }))).toEqual({
      labelIds: "STARRED",
    });
  });

  it("treats an empty search as none", () => {
    expect(s.triggerConfig(config("gmail.new_message", { query: "   " }))).toEqual({
      labelIds: "INBOX",
    });
  });

  it("refuses a label that is not one it offers", () => {
    expect(parseEventChoice(CATALOGUE, "gmail.new_message", { label: "SPAM" }).ok).toBe(false);
  });

  it("writes a mail as headers and its text, keyed by the message id", async () => {
    const out = await s.describe(
      {
        message_id: "18c2",
        sender: "Ayşe <ayse@example.com>",
        to: "me@example.com",
        subject: "Thursday",
        message_text: "Does Thursday work?",
        message_timestamp: "2026-10-16T09:00:00Z",
        attachment_list: [{}, {}],
        payload: { huge: "x".repeat(50_000) },
      },
      noFetch,
    );
    expect(out?.eventId).toBe("gmail:18c2");
    expect(out?.text).toContain("From: Ayşe <ayse@example.com>");
    expect(out?.text).toContain("Subject: Thursday");
    expect(out?.text).toContain("Attachments: 2");
    expect(out?.text).toContain("Does Thursday work?");
    // The raw MIME payload is exactly what is not handed to the model.
    expect(out?.text).not.toContain("xxxx");
    expect(out?.fields).toEqual({ sender: "Ayşe <ayse@example.com>", subject: "Thursday" });
  });

  it("cuts a long body", async () => {
    const out = await s.describe({ id: "1", message_text: "a".repeat(20_000) }, noFetch);
    expect(out!.text.length).toBeLessThan(7_000);
    expect(out!.text).toContain("cut at");
  });

  it("runs nothing for a delivery with no id", async () => {
    expect(await s.describe({ subject: "x" }, noFetch)).toBeNull();
  });
});

describe("outlook.new_message", () => {
  const s = spec("outlook.new_message");

  it("sends Composio's names for the filters it was given, and nothing for the rest", () => {
    expect(s.triggerConfig(config("outlook.new_message", {}))).toEqual({});
    expect(
      s.triggerConfig(
        config("outlook.new_message", {
          fromEmail: "billing@example.com",
          subjectContains: "Invoice",
          hasAttachments: true,
          folder: "archive",
        }),
      ),
    ).toEqual({
      from_email: "billing@example.com",
      subject_contains: "Invoice",
      has_attachments: true,
      folder_id: "archive",
    });
  });

  it("asks for the message, because the delivery is only its id", async () => {
    const fetch = vi.fn(async () => ({
      data: {
        subject: "Invoice 114",
        from: { emailAddress: { name: "Billing", address: "billing@example.com" } },
        toRecipients: [{ emailAddress: { address: "me@example.com" } }],
        receivedDateTime: "2026-10-16T09:00:00Z",
        body: { contentType: "html", content: "<p>Due on the <b>30th</b>.</p>" },
      },
      successful: true,
    }));
    const out = await s.describe({ event_type: "created", id: "AAMk1" }, fetch);
    expect(fetch).toHaveBeenCalledWith(
      "OUTLOOK_GET_MESSAGE",
      expect.objectContaining({ message_id: "AAMk1" }),
    );
    expect(out?.eventId).toBe("outlook:AAMk1");
    expect(out?.text).toContain("From: Billing <billing@example.com>");
    expect(out?.text).toContain("Due on the 30th.");
    expect(out?.text).not.toContain("<p>");
    expect(out?.fields?.sender).toBe("Billing <billing@example.com>");
  });

  it("still runs on what the delivery said when the lookup fails", async () => {
    const out = await s.describe(
      { id: "AAMk2", outlook_message: { subject: "Hello", bodyPreview: "short" } },
      noFetch,
    );
    expect(out?.text).toContain("Subject: Hello");
    expect(out?.text).toContain("short");
  });
});

describe("outlook.new_event", () => {
  it("asks for the event by its id", async () => {
    const fetch = vi.fn(async () =>
      JSON.stringify({
        data: {
          subject: "Planning",
          start: { dateTime: "2026-11-03T10:00:00", timeZone: "Europe/Istanbul" },
          end: { dateTime: "2026-11-03T11:00:00", timeZone: "Europe/Istanbul" },
          location: { displayName: "Room 4" },
          organizer: { emailAddress: { address: "ayse@example.com" } },
          attendees: [{ emailAddress: { address: "me@example.com" } }],
        },
      }),
    );
    const out = await spec("outlook.new_event").describe({ id: "EV1" }, fetch);
    expect(fetch).toHaveBeenCalledWith("OUTLOOK_GET_EVENT", { event_id: "EV1" });
    expect(out?.text).toContain("Event: Planning");
    expect(out?.text).toContain("Starts: 2026-11-03T10:00:00 Europe/Istanbul");
    expect(out?.text).toContain("Where: Room 4");
  });
});

describe("Google Calendar", () => {
  it("watches the main calendar unless told otherwise", () => {
    expect(spec("gcal.event_created").triggerConfig(config("gcal.event_created", {}))).toEqual({
      calendarId: "primary",
    });
    expect(
      spec("gcal.event_canceled").triggerConfig(
        config("gcal.event_canceled", { calendarId: "team@group.calendar.google.com" }),
      ),
    ).toEqual({ calendarId: "team@group.calendar.google.com" });
  });

  it("sends how many minutes before an event to fire, fifteen by default", () => {
    const s = spec("gcal.starting_soon");
    expect(s.triggerConfig(config("gcal.starting_soon", {}))).toEqual({
      calendarId: "primary",
      minutesBeforeStart: 15,
    });
    expect(s.triggerConfig(config("gcal.starting_soon", { minutesBefore: "5" }))).toEqual({
      calendarId: "primary",
      minutesBeforeStart: 5,
    });
    expect(parseEventChoice(CATALOGUE, "gcal.starting_soon", { minutesBefore: 0 }).ok).toBe(false);
  });

  it("keys a starting-soon event by occurrence, so next week's runs too", async () => {
    const s = spec("gcal.starting_soon");
    const week1 = await s.describe(
      {
        event_id: "e1",
        start_timestamp: 1_700_000_000,
        summary: "Standup",
        minutes_until_start: 14.6,
      },
      noFetch,
    );
    const week2 = await s.describe(
      { event_id: "e1", start_timestamp: 1_700_604_800, summary: "Standup" },
      noFetch,
    );
    expect(week1?.eventId).not.toBe(week2?.eventId);
    expect(week1?.text).toContain("Starts in: 15 minutes");
  });

  it("keys each change to an event as its own event", async () => {
    const s = spec("gcal.event_updated");
    const a = await s.describe(
      {
        event_id: "e1",
        updated_at: "2026-10-16T09:00:00Z",
        updated_fields: { start: { old: "10:00", new: "11:00" } },
      },
      noFetch,
    );
    const b = await s.describe(
      { event_id: "e1", updated_at: "2026-10-16T10:00:00Z", updated_fields: {} },
      noFetch,
    );
    expect(a?.eventId).not.toBe(b?.eventId);
    expect(a?.text).toContain('start: "10:00" → "11:00"');
  });

  it("describes a new and a canceled event", async () => {
    const created = await spec("gcal.event_created").describe(
      {
        event_id: "e2",
        summary: "Intro",
        start_time: "2026-11-04T15:00:00+03:00",
        organizer_email: "m@x.y",
      },
      noFetch,
    );
    expect(created?.text).toContain("Event: Intro");
    expect(created?.text).toContain("Organizer: m@x.y");
    const canceled = await spec("gcal.event_canceled").describe({ event_id: "e3" }, noFetch);
    expect(canceled?.eventId).toBe("gcal-canceled:e3");
    expect(canceled?.text).toContain("Canceled:");
  });
});

describe("helpers", () => {
  it("toolData unwraps the envelope a tool call answers with", () => {
    expect(toolData({ data: { a: 1 }, successful: true })).toEqual({ a: 1 });
    expect(toolData(JSON.stringify({ data: { response_data: { b: 2 } } }))).toEqual({ b: 2 });
    expect(toolData("not json")).toBeNull();
    expect(toolData(null)).toBeNull();
  });

  it("textOfHtml keeps the words and drops the markup", () => {
    expect(textOfHtml("<style>p{}</style><p>One&nbsp;&amp; two</p><br>three")).toBe(
      "One & two\n\nthree",
    );
  });
});
