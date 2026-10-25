import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reading thirty days of mail and calendar, and keeping none of it.
 *
 * Composio is stubbed. The bodies below are in the shapes Composio's catalogue
 * publishes for each operation (probed 2026-10-26, see read.ts), with invented
 * people and invented subjects.
 */
const execute = vi.fn();
vi.mock("../composio/client", () => ({
  executeTool: (...args: unknown[]) => execute(...args),
}));

const {
  ArrivalReadError,
  MAIL_CAP,
  readSource,
  parseGmail,
  gmailThreads,
  parseOutlookMail,
  outlookThreads,
  parseGoogleCalendar,
  parseOutlookCalendar,
} = await import("./read");

const NOW = new Date("2026-10-26T09:00:00Z");
const ACCOUNT = { connectedAccountId: "ca_1", composioUserId: "u_1" };

function ok(data: unknown) {
  return { kind: "ok", body: JSON.stringify({ data, successful: true }) };
}

function gmailMessage(over: Record<string, unknown>) {
  return {
    messageId: "m",
    threadId: "t",
    sender: "Ada Lovelace <ada@acme.test>",
    subject: "Is the spring order still on?",
    messageTimestamp: "2026-10-20T08:00:00Z",
    labelIds: ["INBOX"],
    preview: { body: "Hello, quick question about the spring order", subject: "" },
    ...over,
  };
}

describe("parseGmail and gmailThreads", () => {
  const body = JSON.stringify({
    data: {
      messages: [
        gmailMessage({ messageId: "a1", threadId: "A", messageTimestamp: "2026-10-20T08:00:00Z" }),
        gmailMessage({
          messageId: "a2",
          threadId: "A",
          sender: "Me <me@covan.test>",
          subject: "Re: Is the spring order still on?",
          labelIds: ["SENT"],
          messageTimestamp: "2026-10-21T08:00:00Z",
        }),
        gmailMessage({
          messageId: "b1",
          threadId: "B",
          sender: "billing@vendor.test",
          subject: "Invoice 1042",
          preview: { body: "x".repeat(300) },
          messageTimestamp: "2026-10-22T08:00:00Z",
        }),
        gmailMessage({
          messageId: "c1",
          threadId: "C",
          sender: "me@covan.test",
          subject: "Something I started",
          labelIds: ["SENT"],
        }),
      ],
      nextPageToken: "p2",
    },
    successful: true,
  });

  it("reads the messages and the next page", () => {
    const page = parseGmail(body);
    expect(page.messages).toHaveLength(4);
    expect(page.nextPage).toBe("p2");
  });

  it("makes one item per thread somebody else wrote into", () => {
    const { items, selfDomains } = gmailThreads(parseGmail(body).messages);
    expect(items.map((i) => i.id).sort()).toEqual(["A", "B"]);
    expect(selfDomains).toEqual(["covan.test"]);
  });

  it("knows a thread the person replied to, from their sent label", () => {
    const { items } = gmailThreads(parseGmail(body).messages);
    const a = items.find((i) => i.id === "A")!;
    expect(a).toMatchObject({
      source: "mail",
      domain: "acme.test",
      subject: "Is the spring order still on?",
      fromMe: true,
      repliedByMe: true,
      at: "2026-10-21T08:00:00.000Z",
    });
  });

  it("keeps the sender's domain and never the address, and cuts the snippet at 200", () => {
    const { items } = gmailThreads(parseGmail(body).messages);
    const b = items.find((i) => i.id === "B")!;
    expect(b.domain).toBe("vendor.test");
    expect(JSON.stringify(b)).not.toContain("billing@");
    expect(b.snippet).toHaveLength(200);
    expect(b.fromMe).toBe(false);
    expect(b.repliedByMe).toBe(false);
  });

  it("reads a timestamp given in epoch milliseconds", () => {
    const body = JSON.stringify({
      data: {
        messages: [
          gmailMessage({
            threadId: "D",
            messageTimestamp: String(Date.parse("2026-10-23T10:00:00Z")),
          }),
        ],
      },
    });
    const { items } = gmailThreads(parseGmail(body).messages);
    expect(items[0].at).toBe("2026-10-23T10:00:00.000Z");
  });

  it("answers an unreadable body with no messages rather than a throw", () => {
    expect(parseGmail("not json")).toEqual({ messages: [], nextPage: null });
  });
});

describe("parseOutlookMail and outlookThreads", () => {
  const inbox = JSON.stringify({
    data: {
      value: [
        {
          id: "o1",
          conversationId: "X",
          subject: "Can you approve the quote?",
          from: { emailAddress: { name: "Grace", address: "grace@harbour.test" } },
          receivedDateTime: "2026-10-24T08:00:00Z",
          bodyPreview: "Please approve",
        },
        {
          id: "o2",
          conversationId: "Y",
          subject: "Weekly numbers",
          from: { emailAddress: { address: "reports@harbour.test" } },
          receivedDateTime: "2026-10-23T08:00:00Z",
          bodyPreview: "",
        },
      ],
      next_page_token: "n2",
    },
    successful: true,
  });
  const sent = JSON.stringify({
    data: {
      value: [
        {
          id: "s1",
          conversationId: "X",
          from: { emailAddress: { address: "me@covan.test" } },
          sentDateTime: "2026-10-25T08:00:00Z",
        },
      ],
    },
    successful: true,
  });

  it("joins the inbox to the sent folder by conversation", () => {
    const received = parseOutlookMail(inbox);
    expect(received.nextPage).toBe("n2");
    const { items, selfDomains } = outlookThreads(
      received.messages,
      parseOutlookMail(sent).messages,
    );
    const x = items.find((i) => i.id === "X")!;
    expect(x).toMatchObject({ domain: "harbour.test", repliedByMe: true, fromMe: true });
    const y = items.find((i) => i.id === "Y")!;
    expect(y).toMatchObject({ repliedByMe: false, fromMe: false });
    expect(selfDomains).toEqual(["covan.test"]);
  });
});

describe("the calendars", () => {
  it("reads Google Calendar events, dropping cancelled ones", () => {
    const body = JSON.stringify({
      data: {
        items: [
          {
            id: "e1",
            summary: "Weekly sync",
            status: "confirmed",
            start: { dateTime: "2026-10-20T09:00:00Z" },
            end: { dateTime: "2026-10-20T09:30:00Z" },
            attendees: [{ email: "a@acme.test" }, { email: "b@acme.test" }, { self: true }],
            organizer: { self: true },
            recurringEventId: "r1",
          },
          { id: "e2", summary: "Dropped", status: "cancelled", start: { date: "2026-10-21" } },
          {
            id: "e3",
            summary: "Offsite",
            start: { date: "2026-10-22" },
            end: { date: "2026-10-23" },
          },
        ],
      },
      successful: true,
    });
    const { items } = parseGoogleCalendar(body);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      source: "event",
      domain: "",
      subject: "Weekly sync",
      attendees: 3,
      durationMin: 30,
      organisedByMe: true,
      recurring: true,
    });
    expect(items[1].durationMin).toBe(1440);
  });

  it("reads an Outlook calendar view", () => {
    const body = JSON.stringify({
      data: {
        value: [
          {
            id: "v1",
            subject: "Interview",
            start: { dateTime: "2026-10-20T13:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-10-20T14:00:00.0000000", timeZone: "UTC" },
            attendees: [{ emailAddress: { address: "c@acme.test" } }],
            isOrganizer: false,
            type: "singleInstance",
          },
          { id: "v2", subject: "Gone", isCancelled: true },
        ],
      },
      successful: true,
    });
    const { items } = parseOutlookCalendar(body);
    expect(items).toEqual([
      expect.objectContaining({
        subject: "Interview",
        attendees: 1,
        durationMin: 60,
        organisedByMe: false,
        recurring: false,
      }),
    ]);
  });
});

describe("readSource", () => {
  beforeEach(() => execute.mockReset());

  function page(n: number, next: string | null) {
    return ok({
      messages: Array.from({ length: 100 }, (_, i) =>
        gmailMessage({ messageId: `m${n}-${i}`, threadId: `t${n}-${i}` }),
      ),
      nextPageToken: next ?? undefined,
    });
  }

  it("stops at two pages of a mailbox even when a third is offered", async () => {
    execute.mockResolvedValueOnce(page(1, "p2")).mockResolvedValueOnce(page(2, "p3"));
    const out = await readSource(
      {} as never,
      { connectionId: "c1", toolkit: "gmail", account: ACCOUNT },
      NOW,
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(out.items).toHaveLength(MAIL_CAP);
    expect(out.calls).toEqual(["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_EMAILS"]);
    const [, first] = execute.mock.calls[0];
    expect(first).toMatchObject({
      slug: "GMAIL_FETCH_EMAILS",
      connectedAccountId: "ca_1",
      userId: "u_1",
      arguments: expect.objectContaining({ max_results: 100, include_payload: false }),
    });
    expect(first.arguments.query).toContain("newer_than:30d");
    expect(execute.mock.calls[1][1].arguments.page_token).toBe("p2");
  });

  it("stops when there is no next page", async () => {
    execute.mockResolvedValueOnce(page(1, null));
    const out = await readSource(
      {} as never,
      { connectionId: "c1", toolkit: "gmail", account: ACCOUNT },
      NOW,
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(out.items).toHaveLength(100);
  });

  it("asks Google Calendar for the last thirty days in one call", async () => {
    execute.mockResolvedValueOnce(ok({ items: [] }));
    const out = await readSource(
      {} as never,
      { connectionId: "c2", toolkit: "googlecalendar", account: ACCOUNT },
      NOW,
    );
    expect(out.calls).toEqual(["GOOGLECALENDAR_EVENTS_LIST"]);
    expect(execute.mock.calls[0][1].arguments).toMatchObject({
      calendarId: "primary",
      timeMin: "2026-09-26T09:00:00.000Z",
      timeMax: "2026-10-26T09:00:00.000Z",
      maxResults: 250,
      singleEvents: true,
    });
  });

  it("reads Outlook's inbox, its sent folder and its calendar", async () => {
    execute
      .mockResolvedValueOnce(ok({ value: [] }))
      .mockResolvedValueOnce(ok({ value: [] }))
      .mockResolvedValueOnce(ok({ value: [] }));
    const out = await readSource(
      {} as never,
      { connectionId: "c3", toolkit: "outlook", account: ACCOUNT },
      NOW,
    );
    expect(out.calls).toEqual([
      "OUTLOOK_LIST_MESSAGES",
      "OUTLOOK_LIST_MESSAGES",
      "OUTLOOK_GET_CALENDAR_VIEW",
    ]);
    expect(execute.mock.calls[1][1].arguments.folder).toBe("sentitems");
  });

  it("gives up on the source with Composio's own words when a call fails", async () => {
    execute.mockResolvedValueOnce({ kind: "error", status: 401, message: "The grant has expired" });
    const reading = readSource(
      {} as never,
      { connectionId: "c1", toolkit: "gmail", account: ACCOUNT },
      NOW,
    );
    await expect(reading).rejects.toBeInstanceOf(ArrivalReadError);
    await expect(reading).rejects.toThrow("The grant has expired");
  });

  it("says which calls it made before it failed, so they are still paid for", async () => {
    execute.mockResolvedValueOnce(page(1, "p2")).mockResolvedValueOnce({
      kind: "error",
      status: 500,
      message: "boom",
    });
    const err = await readSource(
      {} as never,
      { connectionId: "c1", toolkit: "gmail", account: ACCOUNT },
      NOW,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ArrivalReadError);
    expect(err.calls).toEqual(["GMAIL_FETCH_EMAILS", "GMAIL_FETCH_EMAILS"]);
  });
});
