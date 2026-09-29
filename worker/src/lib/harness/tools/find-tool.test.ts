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
const { recordSpy } = vi.hoisted(() => ({ recordSpy: vi.fn(async () => {}) }));

vi.mock("../../entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../entitlements")>();
  return {
    ...actual,
    entitlementsFor: () => ({
      check: async () => ({ allowed: true }),
      record: recordSpy,
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
  toolkit_slug: "gmail",
  status: "active",
};

function ctxWith(
  connections: Record<string, unknown>[] = [],
  offeredSlugs?: Set<string>,
  offeredOperations?: Map<string, import("../../composio/client").ComposioTool>,
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
    offeredOperations,
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

/** Same operation, but publishing the schema a search row really carries. */
const SEND_WITH_PROPERTIES = {
  ...GMAIL_SEND,
  input_parameters: {
    type: "object",
    required: ["recipient_email", "subject"],
    properties: {
      recipient_email: { type: "string" },
      subject: { type: "string" },
      body: { type: "string" },
      cc: { type: "array" },
    },
  },
};

/** The same row with `n` properties, for the "+N more" cut. */
function withProperties(row: typeof SEND_WITH_PROPERTIES, n: number) {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < n; i += 1) properties[`p${i}`] = { type: "string" };
  return { ...row, input_parameters: { type: "object", required: [], properties } };
}

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

  describe("ordering within one application", () => {
    /** The two operations from the incident, in the order Composio returned them. */
    const CLEAR_CALENDAR = {
      slug: "GOOGLECALENDAR_CLEAR_CALENDAR",
      name: "Clear calendar",
      description: "Clears a primary calendar by deleting all events from it.",
      toolkit: { slug: "GOOGLECALENDAR" },
      input_parameters: { required: ["calendar_id"] },
    };
    const DELETE_EVENT = {
      slug: "GOOGLECALENDAR_DELETE_EVENT",
      name: "Delete event",
      description: "Deletes one event from a calendar.",
      toolkit: { slug: "GOOGLECALENDAR" },
      input_parameters: { required: ["event_id", "calendar_id"] },
    };
    const CALENDAR_CONNECTION = {
      id: "c-cal",
      label: "Google Calendar",
      transport: "composio",
      toolkit_slug: "googlecalendar",
      status: "active",
    };

    it("puts the operation that answers the question above the one that does not", async () => {
      // 2026-09-26, production, a real calendar. Somebody asked an agent to
      // delete a few recurring events; `find_tool` was called with exactly this
      // query, Composio ranked CLEAR_CALENDAR first, the model read in order,
      // and the calendar was emptied. #201.
      //
      // `delete` and `event` are both in DELETE_EVENT's name and neither is in
      // CLEAR_CALENDAR's. `calendar` and `google` score for neither, because
      // they name the application both are in.
      fetchMock.mockResolvedValue(catalogue([CLEAR_CALENDAR, DELETE_EVENT]));
      const out = await findToolTool.run(
        { query: "delete event google calendar", toolkit: "googlecalendar" },
        ctxWith([CALENDAR_CONNECTION]),
      );
      const content = out.kind === "ok" ? out.content : "";
      expect(content.indexOf("GOOGLECALENDAR_DELETE_EVENT")).toBeLessThan(
        content.indexOf("GOOGLECALENDAR_CLEAR_CALENDAR"),
      );
    });

    it("leaves the catalogue's order alone when the query separates nothing", async () => {
      // The degradation that makes this safe to ship. A query whose words appear
      // in neither name scores both at zero, the sort is stable, and the result
      // is exactly what Composio said — which is the behaviour this replaced.
      fetchMock.mockResolvedValue(catalogue([CLEAR_CALENDAR, DELETE_EVENT]));
      const out = await findToolTool.run(
        { query: "tidy up", toolkit: "googlecalendar" },
        ctxWith([CALENDAR_CONNECTION]),
      );
      const content = out.kind === "ok" ? out.content : "";
      expect(content.indexOf("GOOGLECALENDAR_CLEAR_CALENDAR")).toBeLessThan(
        content.indexOf("GOOGLECALENDAR_DELETE_EVENT"),
      );
    });

    it("breaks a tie on the name that is about less else", async () => {
      // The 2026-09-28 tie, verbatim. "list pull requests" scores three of three
      // against BOTH of these — LIST, PULL, REQUEST — and the second is about
      // comments on a review. Composio returns them alphabetically (measured
      // 2026-09-29), so C precedes P and the wrong one came first; the model
      // happened to choose correctly and nothing in the order helped it.
      const LIST_PRS = {
        slug: "GITHUB_LIST_PULL_REQUESTS",
        name: "List pull requests",
        description: "Lists pull requests in a repository.",
        toolkit: { slug: "GITHUB" },
        input_parameters: { required: ["owner", "repo"] },
      };
      const LIST_REVIEW_COMMENTS = {
        slug: "GITHUB_LIST_COMMENTS_FOR_A_PULL_REQUEST_REVIEW",
        name: "List comments for a pull request review",
        description: "Lists comments left on one review of a pull request.",
        toolkit: { slug: "GITHUB" },
        input_parameters: { required: ["owner", "repo", "pull_number", "review_id"] },
      };
      const GITHUB_CONNECTION = {
        id: "c-gh",
        label: "GitHub",
        transport: "composio",
        toolkit_slug: "github",
        status: "active",
      };

      fetchMock.mockImplementation(async () => catalogue([LIST_REVIEW_COMMENTS, LIST_PRS]));
      const out = await findToolTool.run(
        { query: "list pull requests", toolkit: "github" },
        ctxWith([GITHUB_CONNECTION]),
      );
      const content = out.kind === "ok" ? out.content : "";
      expect(content.indexOf("GITHUB_LIST_PULL_REQUESTS")).toBeLessThan(
        content.indexOf("GITHUB_LIST_COMMENTS_FOR_A_PULL_REQUEST_REVIEW"),
      );
    });

    it("does not break a tie of zero, which would rebuild the order #201 was about", async () => {
      // The guard, as its own case. `unasked` prefers the name carrying fewer
      // words nobody asked for, and at a score of zero that is just "prefer the
      // shorter name": CLEAR is one unasked word, DELETE and EVENT are two. So
      // an unguarded tiebreak puts the destructive operation first on a query
      // that separates neither — which is what #201 was. The test above this one
      // asserts the catalogue order survives; this one says why it must.
      fetchMock.mockImplementation(async () => catalogue([CLEAR_CALENDAR, DELETE_EVENT]));
      const out = await findToolTool.run(
        { query: "tidy up", toolkit: "googlecalendar" },
        ctxWith([CALENDAR_CONNECTION]),
      );
      const content = out.kind === "ok" ? out.content : "";
      expect(content.indexOf("GOOGLECALENDAR_CLEAR_CALENDAR")).toBeLessThan(
        content.indexOf("GOOGLECALENDAR_DELETE_EVENT"),
      );
    });

    it("never lets relevance lift an application nobody has connected", async () => {
      // The ordering of the two rules is the safety property. A word-for-word
      // match in an app the workspace cannot run is still a call that cannot
      // succeed, so connectedness is compared first and relevance only breaks
      // its ties.
      // A fresh Response per call: `GMAIL_SEND_EMAIL` scores nothing for
      // "delete event", so the connected-app re-ask now fires and a single
      // Response would be read twice. The assertion is unchanged — connectedness
      // is still compared before relevance.
      fetchMock.mockImplementation(async () => catalogue([DELETE_EVENT, GMAIL_SEND]));
      const out = await findToolTool.run(
        { query: "delete event" },
        // Gmail connected, Google Calendar not.
        ctxWith([GMAIL_CONNECTION]),
      );
      const content = out.kind === "ok" ? out.content : "";
      expect(content.indexOf("GMAIL_SEND_EMAIL")).toBeLessThan(
        content.indexOf("GOOGLECALENDAR_DELETE_EVENT"),
      );
    });
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

  it("does not offer an operation this connection has already proven it cannot run", async () => {
    // The largest failure class in the harness, and the one nothing could see:
    // Composio's catalogue is the union of what every account of an app COULD
    // have, a connected account has a subset, and `/api/v3.1/tools` takes no
    // parameter that names an account. So the catalogue offers operations
    // execution cannot run — twenty of the thirty run_tool failures ever
    // recorded. Learnt from the 404 and kept on the connection.
    // A fresh Response per call, because this test now also proves the other
    // half: a dead row does not count as an answer, so the connected-app re-ask
    // fires for exactly the workspace whose account is missing operations.
    fetchMock.mockImplementation(async () => catalogue([GMAIL_SEND]));
    const dead = {
      ...GMAIL_CONNECTION,
      config: { unavailable_tools: { GMAIL_SEND_EMAIL: new Date().toISOString() } },
    };

    const out = await findToolTool.run({ query: "send" }, ctxWith([dead]));

    expect(out.kind).toBe("ok");
    expect(out.kind === "ok" && out.content).not.toContain("GMAIL_SEND_EMAIL");
    // And the answer distinguishes "the catalogue has nothing" from "your
    // account cannot run what it has", because those ask different things of
    // the person being talked to.
    expect(out.kind === "ok" && out.content).toContain("broader authorisation");
  });

  it("offers it again once the record has aged out", async () => {
    // It expires because it can stop being true: re-authorising an app with
    // wider scopes adds operations the account did not have.
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    fetchMock.mockResolvedValue(catalogue([GMAIL_SEND]));
    const stale = {
      ...GMAIL_CONNECTION,
      config: { unavailable_tools: { GMAIL_SEND_EMAIL: old } },
    };

    const out = await findToolTool.run({ query: "send" }, ctxWith([stale]));
    expect(out.kind === "ok" && out.content).toContain("GMAIL_SEND_EMAIL");
  });

  it("names the required parameters without fetching a schema", async () => {
    fetchMock.mockResolvedValue(catalogue([GMAIL_SEND]));
    const out = await findToolTool.run({ query: "send" }, ctxWith([GMAIL_CONNECTION]));
    expect(out.kind === "ok" && out.content).toContain("needs: recipient_email, subject");
    // One request, not one per candidate: a full schema each would arrive at
    // the model truncated mid-JSON by `MAX_TOOL_OUTPUT_CHARS`.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names every argument of the first candidate, so run_tool can be called without a second search", async () => {
    // 65 find_tool calls bought 28 run_tool calls in 2026-09-20..27 — 3.10 per
    // turn that used it. The list already holds every candidate's schema (that
    // is what feeds `needs:` and run_tool's validator); it just did not print
    // the optional half, so the model asked for detail to learn it.
    fetchMock.mockResolvedValue(catalogue([SEND_WITH_PROPERTIES, LINEAR_CREATE]));
    const out = await findToolTool.run({ query: "send an email" }, ctxWith([GMAIL_CONNECTION]));
    const content = out.kind === "ok" ? out.content : "";
    const [first, second] = content.split("\n\n");

    expect(first).toContain("takes: recipient_email: string (required)");
    expect(first).toMatch(/takes: .*subject/);
    // The optional ones too — they are the half a second search was buying.
    expect(first).toContain("body");
    // Only the first candidate, and only one request for the lot.
    expect(second).toContain("needs:");
    expect(second).not.toContain("takes:");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("names a required argument the publisher forgot to describe", async () => {
    // `properties` and `required` are separate keys and `composio/client.ts` reads
    // them separately, so `required ⊆ keys(properties)` is an assumption. When it
    // breaks, `takes:` — built from `properties` and printed INSTEAD of `needs:` —
    // used to drop the one argument the call cannot omit, and the model learned
    // about it from `run_tool`'s complaint after paying for the call. #210.
    const undescribed = {
      ...GMAIL_SEND,
      input_parameters: {
        type: "object",
        required: ["recipient_email", "thread_id"],
        properties: { recipient_email: { type: "string" }, body: { type: "string" } },
      },
    };
    fetchMock.mockResolvedValue(catalogue([undescribed]));

    const out = await findToolTool.run({ query: "send an email" }, ctxWith([GMAIL_CONNECTION]));
    const content = out.kind === "ok" ? out.content : "";

    expect(content).toMatch(/takes: .*thread_id/);
    // Bare, because the schema published no type for it — the honest rendering.
    expect(content).toContain("recipient_email: string (required)");
    // And the count stays sane: the union is what `+N more` subtracts from.
    expect(content).not.toMatch(/\+-?\d+ more/);
  });

  it("gives every named argument its type, so the first call is the right shape", async () => {
    // The names alone were not enough, and production is where that showed up:
    // told an argument was called `attendees` and not told it was a string, the
    // model passed an array and bought `Input should be a valid string on
    // parameter 'attendees.0'` — a step out of eight and a billed Composio call
    // to learn one word.
    fetchMock.mockResolvedValue(catalogue([SEND_WITH_PROPERTIES, LINEAR_CREATE]));
    const out = await findToolTool.run({ query: "send an email" }, ctxWith([GMAIL_CONNECTION]));
    const first = (out.kind === "ok" ? out.content : "").split("\n\n")[0];

    // A scalar and a list read differently, which is the distinction the
    // failures were actually about.
    expect(first).toContain("subject: string");
    expect(first).toContain("cc: array");
    // One word, not a schema: no descriptions, no nesting, no enums.
    expect(first).not.toContain("description");
    expect(first).not.toContain("properties");
  });

  it("does not name arguments for a first candidate nobody can run", async () => {
    // Naming the arguments of something the workspace cannot reach invites a
    // call that cannot succeed.
    // A fresh Response per call: with nothing runnable in the broad answer the
    // tool searches again per connected toolkit, and a body reads once.
    fetchMock.mockImplementation(async () =>
      catalogue([{ ...SEND_WITH_PROPERTIES, toolkit: { slug: "LINEAR" } }]),
    );
    const out = await findToolTool.run({ query: "create an issue" }, ctxWith([GMAIL_CONNECTION]));
    const content = out.kind === "ok" ? out.content : "";
    expect(content).toContain("NOT CONNECTED");
    expect(content).not.toContain("takes:");
  });

  it("offers the same slugs whether or not it printed their arguments", async () => {
    // What run_tool is allowed to run is filled before anything is rendered,
    // so a rendering change cannot move it. Pinned because the two are easy to
    // fuse while editing one of them.
    const five = [1, 2, 3, 4, 5].map((n) => ({
      ...SEND_WITH_PROPERTIES,
      slug: `GMAIL_OP_${n}`,
    }));
    // "anything" scores zero against every candidate, so the connected-app
    // re-ask fires and each call needs its own Response.
    fetchMock.mockImplementation(async () => catalogue(five));
    const offered = new Set<string>();
    await findToolTool.run({ query: "anything" }, ctxWith([GMAIL_CONNECTION], offered));
    expect([...offered].sort()).toEqual(five.map((t) => t.slug).sort());
  });

  it("cuts a description that would swallow the answer, and leaves the approval card's whole", async () => {
    // WIX_MCP_SEARCH_WIX_API_SPEC really does publish a description of this
    // shape. The card a person approves needs the whole text; the model
    // choosing between five candidates does not.
    const wix = {
      ...LINEAR_CREATE,
      slug: "WIX_MCP_SEARCH_WIX_API_SPEC",
      description: "Inspect the Wix REST API spec. ".repeat(100),
    };
    fetchMock.mockImplementation(async () => catalogue([wix]));
    const operations = new Map<string, import("../../composio/client").ComposioTool>();
    const out = await findToolTool.run(
      { query: "wix" },
      ctxWith([GMAIL_CONNECTION], new Set(), operations),
    );
    const content = out.kind === "ok" ? out.content : "";
    expect(content.split("\n\n")[0].length).toBeLessThan(400);
    expect(operations.get("WIX_MCP_SEARCH_WIX_API_SPEC")!.description.length).toBe(3100);
  });

  it("says when a schema was cut rather than ending mid-JSON", async () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 200; i += 1) {
      properties[`field_number_${i}`] = { type: "string", description: "x".repeat(40) };
    }
    fetchMock.mockResolvedValueOnce(catalogue([SEND_WITH_PROPERTIES])).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...GMAIL_SEND,
          input_parameters: { type: "object", required: ["recipient_email"], properties },
        }),
        { status: 200 },
      ),
    );
    const out = await findToolTool.run(
      { query: "send", slug: "GMAIL_SEND_EMAIL", detail: true },
      ctxWith([GMAIL_CONNECTION]),
    );
    const content = out.kind === "ok" ? out.content : "";
    expect(content).toMatch(/\[trimmed: \d+ characters, showing the first 4000\]/);
    expect(content).toContain("Arguments:");
  });

  it("says how many arguments it did not list", async () => {
    fetchMock.mockResolvedValue(catalogue([withProperties(SEND_WITH_PROPERTIES, 30)]));
    const out = await findToolTool.run({ query: "send" }, ctxWith([GMAIL_CONNECTION]));
    expect(out.kind === "ok" && out.content).toContain("+6 more");
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

  it("describes the top match when no slug is named", async () => {
    // Until 2026-09-28 this asserted `EVENTS_GET` — the catalogue's own first
    // result — and that assertion was the bug #194 is about, written down. Asked
    // to "list events", `detail` answered with the schema of an operation whose
    // description says *"Retrieves a SINGLE event. Does NOT list events."*
    //
    // The ranking now scores a candidate on how much of the question its name
    // answers: EVENTS_LIST takes both `list` and `event`, EVENTS_GET only
    // `event`. Nothing here knows what either operation does; it is the words
    // the model itself chose.
    catalogueThen(EVENTS_LIST);
    const out = await findToolTool.run({ query: "list events", detail: true }, ctxWith());
    expect(new URL(String(fetchMock.mock.calls[1][0])).pathname).toContain(
      "GOOGLECALENDAR_EVENTS_LIST",
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
    const schemas = new Map<string, import("../../composio/client").ComposioTool>();
    fetchMock.mockResolvedValue(catalogue([SEND]));
    await findToolTool.run({ query: "send" }, ctxWith([], undefined, schemas));

    // The schemas arrive with the search, so this is the one already in hand —
    // not a second request.
    expect(schemas.get("GMAIL_SEND_EMAIL")).toMatchObject({
      slug: "GMAIL_SEND_EMAIL",
      // The schema, for the argument check...
      inputSchema: { required: ["recipient_email"] },
      // ...and the two fields the approval card needs. #201.
      description: "Send an email.",
    });
  });
});

/**
 * How much of the catalogue the ranking gets to see.
 *
 * `relevance` was measured correct and unreachable. On 2026-09-28 a turn asked for
 * a repository's open pull requests; step 0 searched with `toolkit: "github"` and
 * the first row back was `GITHUB_GENERATE_RELEASE_NOTES`.
 * `GITHUB_LIST_PULL_REQUESTS` scores three of three and would have led — it simply
 * was not in the ten rows the search asked for. Sixteen steps and $0.58, answered
 * at step fifteen.
 */
describe("how much of the catalogue the ranking gets to see", () => {
  const GITHUB_CONNECTION = {
    ...GMAIL_CONNECTION,
    id: "conn-gh",
    label: "covan's GitHub",
    toolkit_slug: "github",
  };

  const LIST_PRS = {
    slug: "GITHUB_LIST_PULL_REQUESTS",
    name: "List pull requests",
    description: "List a repository's pull requests.",
    toolkit: { slug: "GITHUB" },
    input_parameters: { required: ["owner", "repo"] },
  };

  /** Rows that score nothing for "list pull requests", to bury the one that does. */
  const noise = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      slug: `GITHUB_UNRELATED_${i}`,
      name: `Unrelated ${i}`,
      description: "Something else entirely.",
      toolkit: { slug: "GITHUB" },
      input_parameters: { required: [] },
    }));

  it("asks the catalogue for a whole page, not for the five it will show", () => {
    fetchMock.mockImplementation(async () => catalogue([LIST_PRS]));
    return findToolTool
      .run({ query: "list pull requests", toolkit: "github" }, ctxWith([GITHUB_CONNECTION]))
      .then(() => {
        expect(String(fetchMock.mock.calls[0][0])).toContain("limit=50");
      });
  });

  /**
   * A catalogue that truncates like the real one.
   *
   * `catalogue()` above returns whatever it is handed, which is fine everywhere
   * else and useless here: the whole subject of these tests is how many rows the
   * request ASKS for, so the mock has to honour `limit` or the page size is not
   * what is being varied. (It does not honour relevance ordering — that is
   * Composio's and is the one thing about this change still unverified.)
   */
  const pagedCatalogue = (items: unknown[]) => async (url: unknown) => {
    const limit = Number(new URL(String(url)).searchParams.get("limit") ?? 10);
    return catalogue(items.slice(0, limit));
  };

  it("finds the operation Composio ranked thirtieth", async () => {
    // The regression. With a page of ten this is unreachable however good the
    // local scorer is, because a local sort can only reorder what arrived.
    fetchMock.mockImplementation(pagedCatalogue([...noise(29), LIST_PRS]));

    const out = await findToolTool.run(
      { query: "list pull requests", toolkit: "github" },
      ctxWith([GITHUB_CONNECTION]),
    );
    const first = (out.kind === "ok" ? out.content : "").split("\n\n")[0];

    expect(first).toContain("GITHUB_LIST_PULL_REQUESTS");
  });

  it("still shows five, however many it ranked", async () => {
    // Supply grew; the prompt did not. This is what makes the page free.
    fetchMock.mockImplementation(pagedCatalogue([...noise(29), LIST_PRS]));
    const offered = new Set<string>();

    await findToolTool.run(
      { query: "list pull requests", toolkit: "github" },
      ctxWith([GITHUB_CONNECTION], offered),
    );

    expect(offered.size).toBe(5);
  });

  it("charges once, however many requests the search took", async () => {
    // `spend()` is per search and not per row or per request. A bigger page and
    // the connected-app re-asks must not change what somebody is billed.
    recordSpy.mockClear();
    fetchMock.mockImplementation(pagedCatalogue([...noise(29), LIST_PRS]));

    await findToolTool.run({ query: "list pull requests" }, ctxWith([GITHUB_CONNECTION]));

    expect(recordSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * When a connected row counts as an answer.
 *
 * The gate on the connected-app re-asks used to be mere presence — one connected
 * row in the broad results, however irrelevant, cancelled all four targeted
 * searches. The broad search answers alphabetically, so applications early in the
 * catalogue and commonly connected switched the compensation off permanently.
 */
describe("when a connected row counts as an answer", () => {
  const GITHUB_CONNECTION = {
    ...GMAIL_CONNECTION,
    id: "conn-gh",
    label: "covan's GitHub",
    toolkit_slug: "github",
  };

  const LIST_PRS = {
    slug: "GITHUB_LIST_PULL_REQUESTS",
    name: "List pull requests",
    description: "List a repository's pull requests.",
    toolkit: { slug: "GITHUB" },
    input_parameters: { required: [] },
  };

  const RELEASE_NOTES = {
    slug: "GITHUB_GENERATE_RELEASE_NOTES",
    name: "Generate release notes",
    description: "Generate release notes.",
    toolkit: { slug: "GITHUB" },
    input_parameters: { required: [] },
  };

  it("re-asks the connected application when the row it got answers nothing", async () => {
    // Exactly the 2026-09-28 shape: the broad answer holds a connected row that
    // scores zero for the question asked.
    let call = 0;
    fetchMock.mockImplementation(async () => {
      call += 1;
      return call === 1 ? catalogue([RELEASE_NOTES]) : catalogue([LIST_PRS, RELEASE_NOTES]);
    });

    const out = await findToolTool.run(
      { query: "list pull requests" },
      ctxWith([GITHUB_CONNECTION]),
    );
    const content = out.kind === "ok" ? out.content : "";

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(content.indexOf("GITHUB_LIST_PULL_REQUESTS")).toBeLessThan(
      content.indexOf("GITHUB_GENERATE_RELEASE_NOTES"),
    );
  });

  it("does not re-ask when the row it got already answers the question", async () => {
    // The other side: a full-scoring connected row makes the extra requests waste.
    fetchMock.mockImplementation(async () => catalogue([LIST_PRS]));

    await findToolTool.run({ query: "list pull requests" }, ctxWith([GITHUB_CONNECTION]));

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
