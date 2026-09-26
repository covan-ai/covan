import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext, ToolEnv } from "../registry";
import { findToolTool } from "./find-tool";

/**
 * Searching a catalogue nobody has connected yet.
 *
 * The property worth pinning is the one that makes this tool different from
 * every other one in the harness: it is offered to a workspace with nothing
 * connected, because the answer "you would need to connect Linear first" is
 * only available to something that can see the unconnected half of the
 * catalogue. The other half of that property is that it never hands the model a
 * connection id for an application the workspace has not connected.
 */
vi.mock("../../entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../entitlements")>();
  return {
    ...actual,
    entitlementsFor: () => ({
      check: async () => ({ allowed: true }),
      record: async () => {},
      snapshot: async () => ({ used: 0, limit: null, resetsAt: null }),
    }),
  };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const GMAIL_CONNECTION = {
  id: "conn-1",
  workspace_id: "ws-1",
  label: "Ana's Gmail",
  transport: "composio",
  base_url: "https://backend.composio.dev",
  auth_kind: "composio",
  allowed_methods: ["GET"],
  config: {},
  account_id: null,
  toolkit_slug: "gmail",
  status: "active",
};

function ctxWith(
  connections: Record<string, unknown>[] = [],
  offeredSlugs?: Set<string>,
  offeredSchemas?: Map<string, Record<string, unknown>>,
): ToolContext {
  return {
    db: {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({ order: async () => ({ data: connections, error: null }) }),
          }),
        }),
      }),
    } as unknown as ToolContext["db"],
    env: { ROUTINE_SECRET_KEY: "k", COMPOSIO_API_KEY: "ck_test" } as ToolEnv,
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    offeredSlugs,
    offeredSchemas,
  };
}

function catalogue(items: unknown[]) {
  return new Response(JSON.stringify({ items }), { status: 200 });
}

const GMAIL_SEND = {
  slug: "GMAIL_SEND_EMAIL",
  name: "Send email",
  description: "Send an email from the connected account.",
  toolkit: { slug: "GMAIL" },
  input_parameters: { required: ["recipient_email", "subject"] },
};

const LINEAR_CREATE = {
  slug: "LINEAR_CREATE_ISSUE",
  name: "Create issue",
  description: "Create an issue.",
  toolkit: { slug: "LINEAR" },
  input_parameters: { required: ["title"] },
};

beforeEach(() => {
  fetchMock.mockReset();
});

describe("find_tool", () => {
  it("is offered whatever the workspace has connected, and only where there is a key", () => {
    // No `needs`, so `available.ts` falls through to true — the point of a
    // catalogue-wide search is that it answers before anything is connected.
    expect(findToolTool.needs).toBeUndefined();
    expect(findToolTool.isConfigured({} as ToolEnv)).toBe(false);
    expect(findToolTool.isConfigured({ COMPOSIO_API_KEY: "ck" } as ToolEnv)).toBe(true);
  });

  it("gives a connection id for a connected app and refuses to invent one otherwise", async () => {
    fetchMock.mockResolvedValue(catalogue([GMAIL_SEND, LINEAR_CREATE]));
    const out = await findToolTool.run({ query: "send a message" }, ctxWith([GMAIL_CONNECTION]));

    expect(out.kind).toBe("ok");
    const content = out.kind === "ok" ? out.content : "";
    expect(content).toContain("connectionId: conn-1");
    // The model is told in words what to do next, because `connectionsManifest`
    // ends with "never guess an id that is not on this list" and a slug with no
    // id beside it is an invitation to make one up.
    expect(content).toContain("LINEAR_CREATE_ISSUE");
    // Asserted on the unconnected entry itself rather than on the whole
    // answer: the closing line legitimately says the word `connectionId`, and a
    // looser match would pass whatever the entry said.
    const linearBlock = content
      .split("\n\n")
      .find((block) => block.startsWith("LINEAR_CREATE_ISSUE"));
    expect(linearBlock).toContain("NOT CONNECTED");
    expect(linearBlock).not.toContain("connectionId");
  });

  it("puts what the workspace can actually run first", async () => {
    fetchMock.mockResolvedValue(catalogue([LINEAR_CREATE, GMAIL_SEND]));
    const out = await findToolTool.run({ query: "send" }, ctxWith([GMAIL_CONNECTION]));
    const content = out.kind === "ok" ? out.content : "";
    expect(content.indexOf("GMAIL_SEND_EMAIL")).toBeLessThan(
      content.indexOf("LINEAR_CREATE_ISSUE"),
    );
  });

  it("writes down which slugs it put in front of the model", async () => {
    // The other half of `run_tool`'s guard, and the half with a precedent for
    // going missing: `message_steps.tokens` was added in 0060 and is NULL on
    // every row ever written because nothing filled it. A set nobody writes to
    // is a guard that never fires, and it fails silently in the safe
    // direction — everything keeps working, and the invented slug keeps
    // costing a 404.
    const offered = new Set<string>();
    fetchMock.mockResolvedValue(catalogue([GMAIL_SEND]));
    await findToolTool.run({ query: "send" }, ctxWith([GMAIL_CONNECTION], offered));
    expect([...offered]).toEqual(["GMAIL_SEND_EMAIL"]);
  });

  it("names the required parameters without fetching a schema", async () => {
    fetchMock.mockResolvedValue(catalogue([GMAIL_SEND]));
    const out = await findToolTool.run({ query: "send" }, ctxWith([GMAIL_CONNECTION]));
    expect(out.kind === "ok" && out.content).toContain("needs: recipient_email, subject");
    // One request, not one per candidate: a full schema each would arrive at
    // the model truncated mid-JSON by `MAX_TOOL_OUTPUT_CHARS`.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches one full schema when asked for detail", async () => {
    fetchMock.mockResolvedValueOnce(catalogue([GMAIL_SEND])).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...GMAIL_SEND,
          input_parameters: {
            type: "object",
            required: ["recipient_email"],
            properties: { recipient_email: { type: "string" } },
          },
        }),
        { status: 200 },
      ),
    );
    const out = await findToolTool.run(
      { query: "send", detail: true },
      ctxWith([GMAIL_CONNECTION]),
    );
    expect(out.kind === "ok" && out.content).toContain("recipient_email");
    expect(out.kind === "ok" && out.content).toContain("Arguments:");
  });

  it("says so plainly when nothing matches", async () => {
    fetchMock.mockResolvedValue(catalogue([]));
    const out = await findToolTool.run({ query: "brew coffee" }, ctxWith());
    expect(out.kind === "ok" && out.content).toContain("No operation in the catalogue matches");
  });

  it("forwards the catalogue's own failure rather than a shrug", async () => {
    fetchMock.mockResolvedValue(new Response("rate limited", { status: 429 }));
    const out = await findToolTool.run({ query: "send" }, ctxWith());
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("rate limited");
  });
});

/**
 * A question asked in a full sentence.
 *
 * Composio's search matches operation names, not meaning, and it stops
 * matching at around seven words — measured against the live catalogue, see
 * `RETRY_WORDS`. That is invisible until it bites, and it bites unevenly:
 * a GPT-5 agent writes the sentence and is told its connected calendar has
 * nothing, where a Claude agent writes three words and finds the operation.
 */
describe("a query too long for the catalogue to match", () => {
  const LONG = "list events from primary calendar between two dates ordered by start time";

  /** Reads the `search` parameter out of a recorded fetch call. */
  const searchOf = (call: number) =>
    new URL(String(fetchMock.mock.calls[call][0])).searchParams.get("search");

  it("asks again with the first few words rather than reporting nothing", async () => {
    fetchMock.mockResolvedValueOnce(catalogue([])).mockResolvedValueOnce(catalogue([GMAIL_SEND]));

    const out = await findToolTool.run({ query: LONG }, ctxWith());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(searchOf(0)).toBe(LONG);
    expect(searchOf(1)).toBe("list events from");
    expect(out.kind === "ok" && out.content).toContain("GMAIL_SEND_EMAIL");
  });

  it("still says nothing matched when the short query finds nothing either", async () => {
    // A fresh Response per call: a body can only be read once, and this test
    // is the only one here that reads two.
    fetchMock.mockImplementation(async () => catalogue([]));
    const out = await findToolTool.run({ query: LONG }, ctxWith());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The message names what the person asked for, not the trimmed version
    // the retry used — that is an implementation detail of this file.
    expect(out.kind === "ok" && out.content).toContain(LONG);
  });

  it("does not second-guess a search that worked", async () => {
    fetchMock.mockResolvedValue(catalogue([GMAIL_SEND]));
    await findToolTool.run({ query: LONG }, ctxWith());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a query that is already short", async () => {
    fetchMock.mockResolvedValue(catalogue([]));
    await findToolTool.run({ query: "brew coffee" }, ctxWith());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tells the model up front, so the retry is the exception and not the route", () => {
    const properties = findToolTool.input.properties as Record<string, { description: string }>;
    expect(properties.query.description).toMatch(/two or three words/i);
  });
});

/**
 * Asking for a schema, and the loop that used to cause.
 *
 * `detail` answered with the top match and nothing else. Measured in
 * production on 2026-09-25: asked for "list events" against a connected
 * calendar, the catalogue ranks `GOOGLECALENDAR_EVENTS_GET` — whose own
 * description says it does NOT list events — above
 * `GOOGLECALENDAR_EVENTS_LIST`. The model got the wrong schema, had no other
 * candidate left in the answer, and searched again in different words. Four
 * times in one turn, spending the budget without ever calling anything.
 */
describe("asking for the arguments of one operation", () => {
  const EVENTS_GET = {
    slug: "GOOGLECALENDAR_EVENTS_GET",
    name: "Get event",
    description: "Retrieves a SINGLE event. Does NOT list events.",
    toolkit: { slug: "GOOGLECALENDAR" },
    input_parameters: { required: ["event_id"] },
  };
  const EVENTS_LIST = {
    slug: "GOOGLECALENDAR_EVENTS_LIST",
    name: "List events",
    description: "Lists events from one calendar.",
    toolkit: { slug: "GOOGLECALENDAR" },
    input_parameters: { required: [] },
  };

  /** The search, then the one schema fetch `detail` makes. */
  function catalogueThen(schemaFor: Record<string, unknown>) {
    fetchMock
      .mockResolvedValueOnce(catalogue([EVENTS_GET, EVENTS_LIST]))
      .mockResolvedValueOnce(new Response(JSON.stringify(schemaFor), { status: 200 }));
  }

  it("describes the top match when no slug is named, as it always did", async () => {
    catalogueThen(EVENTS_GET);
    const out = await findToolTool.run({ query: "list events", detail: true }, ctxWith());
    expect(new URL(String(fetchMock.mock.calls[1][0])).pathname).toContain(
      "GOOGLECALENDAR_EVENTS_GET",
    );
    expect(out.kind === "ok" && out.content).toContain("Arguments:");
  });

  it("describes the operation the model names, over whatever ranked first", async () => {
    catalogueThen(EVENTS_LIST);
    await findToolTool.run(
      { query: "list events", detail: true, slug: "GOOGLECALENDAR_EVENTS_LIST" },
      ctxWith(),
    );
    // The ranking put EVENTS_GET first; the model asked for the other one and
    // got the other one. That is the whole fix.
    expect(new URL(String(fetchMock.mock.calls[1][0])).pathname).toContain(
      "GOOGLECALENDAR_EVENTS_LIST",
    );
  });

  it("takes a slug in any case, since a model retypes rather than copies", async () => {
    catalogueThen(EVENTS_LIST);
    await findToolTool.run(
      { query: "list events", detail: true, slug: "googlecalendar_events_list" },
      ctxWith(),
    );
    expect(new URL(String(fetchMock.mock.calls[1][0])).pathname).toContain(
      "GOOGLECALENDAR_EVENTS_LIST",
    );
  });

  it("remembers a detail answer under its own key, not the list's", async () => {
    const ctx = ctxWith();
    ctx.searchMemo = new Map();
    catalogueThen(EVENTS_LIST);
    await findToolTool.run(
      { query: "list events", detail: true, slug: "GOOGLECALENDAR_EVENTS_LIST" },
      ctx,
    );
    // Two different questions about the same words. Collapsing them would
    // answer a request for a schema with a list of one-liners.
    fetchMock.mockResolvedValueOnce(catalogue([EVENTS_GET, EVENTS_LIST]));
    const list = await findToolTool.run({ query: "list events" }, ctx);
    expect(list.kind === "ok" && list.content).not.toContain("You already ran this exact search");
  });

  it("keeps the other matches beside the schema, so a wrong pick costs nothing", async () => {
    catalogueThen(EVENTS_GET);
    const out = await findToolTool.run({ query: "list events", detail: true }, ctxWith());
    const content = out.kind === "ok" ? out.content : "";

    expect(content).toContain("GOOGLECALENDAR_EVENTS_LIST");
    expect(content).toContain("ask for detail on a slug by name rather than searching again");
    // And the one being described is not repeated in its own alternatives.
    expect(content.split("GOOGLECALENDAR_EVENTS_GET").length - 1).toBe(1);
  });
});

/**
 * The same search, asked twice in one turn.
 *
 * Measured: a production turn ran `find_tool {query: "list events", toolkit:
 * "googlecalendar"}`, spent three steps on other things, then ran it again
 * byte for byte and got the same 3,631 characters. A model that has just had a
 * tool call fail goes back to the search rather than to the list it already
 * has. The repeat still costs a step — the model chose to spend it — but it
 * need not cost a network call, and the answer can say so.
 */
describe("a search this turn has already answered", () => {
  it("answers from what it said the first time, without asking again", async () => {
    const ctx = ctxWith([GMAIL_CONNECTION]);
    ctx.searchMemo = new Map();

    fetchMock.mockResolvedValueOnce(catalogue([GMAIL_SEND]));
    const first = await findToolTool.run({ query: "send email" }, ctx);
    const second = await findToolTool.run({ query: "send email" }, ctx);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The same operations, so the model loses nothing by being told.
    expect(second.kind === "ok" && second.content).toContain("GMAIL_SEND_EMAIL");
    expect(second.kind === "ok" && second.content).toContain("You already ran this exact search");
    expect(first.kind === "ok" && first.content).not.toContain("You already ran");
  });

  it("does not care how the model capitalised its own question", async () => {
    const ctx = ctxWith();
    ctx.searchMemo = new Map();
    fetchMock.mockResolvedValueOnce(catalogue([GMAIL_SEND]));
    await findToolTool.run({ query: "send email" }, ctx);
    const again = await findToolTool.run({ query: "Send Email" }, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(again.kind === "ok" && again.content).toContain("You already ran");
  });

  it("treats a different toolkit as a different question", async () => {
    const ctx = ctxWith();
    ctx.searchMemo = new Map();
    // A fresh Response per call: a body can only be read once.
    fetchMock.mockImplementation(async () => catalogue([GMAIL_SEND]));
    await findToolTool.run({ query: "send email", toolkit: "gmail" }, ctx);
    await findToolTool.run({ query: "send email", toolkit: "slack" }, ctx);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("lets a fruitless search be tried again, which is the useful kind of repeat", async () => {
    const ctx = ctxWith();
    ctx.searchMemo = new Map();
    // Two calls per attempt: the query, then the shortened retry.
    fetchMock.mockImplementation(async () => catalogue([]));
    await findToolTool.run({ query: "brew a cup of coffee please" }, ctx);
    const calls = fetchMock.mock.calls.length;
    await findToolTool.run({ query: "brew a cup of coffee please" }, ctx);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
  });

  it("works for a turn that carries no memo at all", async () => {
    fetchMock.mockResolvedValue(catalogue([GMAIL_SEND]));
    const out = await findToolTool.run({ query: "send email" }, ctxWith());
    expect(out.kind).toBe("ok");
  });
});

/**
 * The alternatives beside a schema, and the parameter nobody was shown.
 *
 * Measured in production on 2026-09-26. Asked for "create event" against a
 * connected calendar, the catalogue ranks `GOOGLECALENDAR_BATCH_EVENTS` first,
 * so `detail` spent the whole of `MAX_SCHEMA_CHARS` on it and returned
 * `GOOGLECALENDAR_CREATE_EVENT` — the one the model went on to run — as a
 * description with no arguments at all.
 *
 * So the model used the shape it already knew, the raw Google Calendar REST
 * API, which is not the shape Composio accepts. Ten billed rejections followed.
 * Worse than the cost: it never learned that `timezone` exists, sent a `+03:00`
 * offset instead, and Composio defaults to UTC when that parameter is absent —
 * so five events were written to a real calendar three hours from where they
 * were asked for. #192.
 *
 * A one-line description is not enough to call an operation. The parameter names
 * are already in hand — `searchTools` returns them, which is how `needs:` is
 * printed — so this costs no extra request.
 */
describe("the alternatives beside a schema", () => {
  const BATCH_EVENTS = {
    slug: "GOOGLECALENDAR_BATCH_EVENTS",
    name: "Batch events",
    description: "Execute up to 1000 event mutations in one request.",
    toolkit: { slug: "GOOGLECALENDAR" },
    input_parameters: {
      required: ["operations"],
      properties: { operations: {}, fail_fast: {} },
    },
  };
  const CREATE_EVENT = {
    slug: "GOOGLECALENDAR_CREATE_EVENT",
    name: "Create event",
    description: "Create an event on a calendar.",
    toolkit: { slug: "GOOGLECALENDAR" },
    input_parameters: {
      required: ["start_datetime"],
      properties: {
        start_datetime: {},
        end_datetime: {},
        timezone: {},
        attendees: {},
        calendar_id: {},
      },
    },
  };

  it("names an alternative's parameters, so the model can run it without asking again", async () => {
    fetchMock
      .mockResolvedValueOnce(catalogue([BATCH_EVENTS, CREATE_EVENT]))
      .mockResolvedValueOnce(new Response(JSON.stringify(BATCH_EVENTS), { status: 200 }));

    const out = await findToolTool.run({ query: "create event", detail: true }, ctxWith());
    const content = out.kind === "ok" ? out.content : "";
    const alternatives = content.slice(content.indexOf("If that is not the one you want"));

    // The parameter whose absence cost five wrong events. A model that is shown
    // the name uses it; one that is not sends an offset and lands in UTC.
    expect(alternatives).toContain("timezone");
    expect(alternatives).toContain("start_datetime (required)");
  });
});

/**
 * Searching when the workspace has something connected.
 *
 * Composio's `/tools?search=…` answers alphabetically, and ten results never
 * reach the g's. Measured in production on 2026-09-26, with Google Calendar
 * connected and active throughout: four separate turns searched without a
 * `toolkit`, got `_2chat`, `acculynx`, `active_campaign`, `alpha_vantage` and
 * `blackboard` — every one of them marked NOT CONNECTED — and told the person
 * the agent had no calendar. Twice in those words.
 *
 * The connected-first sort cannot reach this: it reorders the rows that came
 * back, and the connected application was never among them. #193.
 */
describe("searching with a connected app in the workspace", () => {
  const TWO_CHAT = {
    slug: "_2CHAT_LIST_WEBHOOKS",
    name: "List webhooks",
    description: "List webhook subscriptions for WhatsApp.",
    toolkit: { slug: "_2CHAT" },
    input_parameters: { required: [] },
  };
  const CALENDAR_CREATE = {
    slug: "GOOGLECALENDAR_CREATE_EVENT",
    name: "Create event",
    description: "Create an event on a calendar.",
    toolkit: { slug: "GOOGLECALENDAR" },
    input_parameters: { required: ["start_datetime"] },
  };
  const CALENDAR_CONNECTION = {
    ...GMAIL_CONNECTION,
    id: "conn-cal",
    label: "Google Calendar",
    toolkit_slug: "googlecalendar",
  };

  /** The catalogue as it actually behaves: alphabetical, and the g's never fit. */
  function alphabeticalCatalogue() {
    fetchMock.mockImplementation((url: unknown) => {
      const toolkit = new URL(String(url)).searchParams.get("toolkit_slug");
      return Promise.resolve(
        catalogue(toolkit === "GOOGLECALENDAR" ? [CALENDAR_CREATE] : [TWO_CHAT]),
      );
    });
  }

  it("finds a connected app's operation that the catalogue-wide search missed", async () => {
    alphabeticalCatalogue();
    const out = await findToolTool.run({ query: "create event" }, ctxWith([CALENDAR_CONNECTION]));
    const content = out.kind === "ok" ? out.content : "";

    expect(content).toContain("GOOGLECALENDAR_CREATE_EVENT");
    // With the id beside it, which is the whole difference between "you could
    // connect a calendar" and an operation the agent can actually run.
    expect(content).toContain("connectionId: conn-cal");
  });
});

/**
 * Handing the schema on to `run_tool`.
 *
 * `offeredSlugs` has a precedent this must not repeat: `message_steps.tokens` was
 * added in 0060 and is NULL on every row ever written, because nothing filled it.
 * A map nobody writes to is a guard that never fires, and it fails silently in
 * the direction where everything looks fine. #195.
 */
describe("what run_tool is allowed to check against", () => {
  const SEND = {
    slug: "GMAIL_SEND_EMAIL",
    name: "Send email",
    description: "Send an email.",
    toolkit: { slug: "GMAIL" },
    input_parameters: {
      required: ["recipient_email"],
      properties: { recipient_email: { type: "string" } },
    },
  };

  it("records the schema of every candidate it listed", async () => {
    const schemas = new Map<string, Record<string, unknown>>();
    fetchMock.mockResolvedValue(catalogue([SEND]));
    await findToolTool.run({ query: "send" }, ctxWith([], undefined, schemas));

    // The schemas arrive with the search, so this is the one already in hand —
    // not a second request.
    expect(schemas.get("GMAIL_SEND_EMAIL")).toMatchObject({ required: ["recipient_email"] });
  });
});
