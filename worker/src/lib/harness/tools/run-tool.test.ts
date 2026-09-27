import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ToolContext, ToolEnv } from "../registry";
import { runToolTool } from "./run-tool";

/**
 * Running an operation at a connected application, and the four things that
 * stand between a model and somebody else's mailbox.
 *
 * The first two are checked here in full, because they are this file's whole
 * reason to exist: the connection must be the caller's, and the operation must
 * belong to the connection. The third — that a person said yes — is checked in
 * every shape it comes in, including the one a scheduled run cannot answer.
 *
 * `composioAccount` is mocked because the credential path has its own home
 * (`lib/harness/secrets.ts`) and its own reason: asking the database for
 * permission before reaching past it. What matters here is that the identifiers
 * the request carries come from THAT call and never from the model.
 */
const composioAccount = vi.fn(async () => ({
  connectedAccountId: "ca_real",
  composioUserId: "cu_real",
}));
vi.mock("../secrets", () => ({ composioAccount: () => composioAccount() }));

const entitlements = { allowed: true as boolean };
const recordSpy = vi.fn(async (_userId: string, _tokens: number) => {});
vi.mock("../../entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../entitlements")>();
  return {
    ...actual,
    entitlementsFor: () => ({
      check: async () =>
        entitlements.allowed
          ? { allowed: true }
          : { allowed: false, used: 10, limit: 10, resetsAt: "2026-11-01T00:00:00Z" },
      record: (userId: string, tokens: number) => recordSpy(userId, tokens),
      snapshot: async () => ({ used: 0, limit: null, resetsAt: null }),
    }),
  };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

const CONNECTION = {
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

/**
 * A context whose chain mirrors what the tool actually calls: `loadConnection`
 * is `select().eq().eq().maybeSingle()`, and the grant read is
 * `select().eq().eq().eq().maybeSingle()`. Told apart by table, because getting
 * them the wrong way round is how a test proves the wrong thing.
 */
function ctxWith(
  over: {
    row?: Record<string, unknown> | null;
    grant?: { mode: string } | null;
    approved?: string[];
    approvedSlugs?: string[];
    confirmed?: boolean;
    routineRunId?: string;
    offeredSlugs?: Set<string>;
    offeredOperations?: Map<string, import("../../composio/client").ComposioTool>;
  } = {},
): ToolContext {
  const row = over.row === undefined ? CONNECTION : over.row;
  return {
    db: {
      from: (table: string) =>
        table === "tool_connection_grants"
          ? {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    eq: () => ({
                      maybeSingle: async () => ({ data: over.grant ?? null, error: null }),
                    }),
                  }),
                }),
              }),
            }
          : {
              select: () => ({
                eq: () => ({
                  eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
                }),
              }),
            },
    } as unknown as ToolContext["db"],
    offeredSlugs: over.offeredSlugs,
    offeredOperations: over.offeredOperations,
    env: {
      ALLOWED_ORIGIN: "https://app.covan.test",
      ROUTINE_SECRET_KEY: "k",
      COMPOSIO_API_KEY: "ck_test",
    } as ToolEnv,
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    ...(over.approved ? { approvedConnections: over.approved } : {}),
    ...(over.approvedSlugs ? { approvedSlugs: over.approvedSlugs } : {}),
    ...(over.confirmed ? { confirmed: true } : {}),
    ...(over.routineRunId ? { routineRunId: over.routineRunId } : {}),
  };
}

const CALL = {
  connectionId: "conn-1",
  slug: "GMAIL_SEND_EMAIL",
  arguments: { recipient_email: "ana@example.com", subject: "hi" },
};

beforeEach(() => {
  fetchMock.mockReset();
  composioAccount.mockClear();
  composioAccount.mockResolvedValue({ connectedAccountId: "ca_real", composioUserId: "cu_real" });
  entitlements.allowed = true;
  recordSpy.mockReset();
  recordSpy.mockImplementation(async () => {});
  fetchMock.mockResolvedValue(new Response('{"successful":true}', { status: 200 }));
});

describe("run_tool", () => {
  it("refuses a connection that is not in this workspace, before any fetch", async () => {
    // `loadConnection` filters on workspace as well as id, so a foreign row
    // simply is not found. The assertion that matters is the second one: the
    // refusal happens with no request having been made on anybody's behalf.
    const out = await runToolTool.run(CALL, ctxWith({ row: null }));
    expect(out).toEqual({ kind: "error", message: "no such connection in this workspace" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores a connected_account_id the model put in the arguments", async () => {
    // The whole reason this is not `http_request` with a Composio base URL. A
    // model that writes its own account reference must not be able to reach
    // another workspace's grant with it.
    const out = await runToolTool.run(
      {
        ...CALL,
        arguments: { ...CALL.arguments, connected_account_id: "ca_somebody_else" },
      },
      ctxWith({ approved: ["conn-1"] }),
    );
    expect(out.kind).toBe("ok");

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.connected_account_id).toBe("ca_real");
    expect(body.user_id).toBe("cu_real");
    // It still travels as an argument, because Composio may legitimately have a
    // parameter by that name and stripping keys the model sent is a different
    // and worse kind of surprise. What it does not do is decide anything.
    expect(body.arguments.connected_account_id).toBe("ca_somebody_else");
  });

  it("refuses a slug find_tool never returned, instead of paying for the 404", async () => {
    // Production, 19:04:38 and identically again at 19:05:39: find_tool
    // returned GOOGLECALENDAR_EVENTS_LIST and the next step ran
    // GOOGLECALENDAR_EVENTS_LIST_ALL_CALENDARS, which does not exist. The
    // invented slug is plausible — it even guessed a naming convention — so
    // nothing but the list the turn was actually given can tell them apart.
    const out = await runToolTool.run(
      { ...CALL, slug: "GMAIL_SEND_EMAIL_TO_MANY" },
      ctxWith({
        approved: ["conn-1"],
        offeredSlugs: new Set(["GMAIL_SEND_EMAIL", "GMAIL_CREATE_DRAFT"]),
      }),
    );
    expect(out.kind).toBe("error");
    // The list is the point. An error that only says no sends the model back
    // to find_tool for something it has already been told.
    expect(out.kind === "error" && out.message).toContain("GMAIL_SEND_EMAIL, GMAIL_CREATE_DRAFT");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs a slug that find_tool did return", async () => {
    const out = await runToolTool.run(
      CALL,
      ctxWith({ approved: ["conn-1"], offeredSlugs: new Set(["GMAIL_SEND_EMAIL"]) }),
    );
    expect(out.kind).toBe("ok");
  });

  it("refuses nothing when find_tool has not answered this turn", async () => {
    // An empty set is not "nothing was offered", it is "nobody searched". The
    // slug can have come from an earlier turn still in the transcript or from
    // a standing grant, and refusing those would break working behaviour to
    // prevent a mistake that has not happened.
    const out = await runToolTool.run(
      CALL,
      ctxWith({ approved: ["conn-1"], offeredSlugs: new Set() }),
    );
    expect(out.kind).toBe("ok");
  });

  it("does not second-guess a slug a person has already approved", async () => {
    // The resumed half of a confirmed call carries a fresh, empty set and a
    // slug that went through this guard when it was proposed. Checking it
    // again against whatever the second half happened to search for would
    // refuse an action somebody said yes to.
    const out = await runToolTool.run(
      CALL,
      ctxWith({ confirmed: true, offeredSlugs: new Set(["GMAIL_CREATE_DRAFT"]) }),
    );
    expect(out.kind).toBe("ok");
  });

  it("refuses a slug from another toolkit locally, not by way of a 400", async () => {
    const out = await runToolTool.run(
      { ...CALL, slug: "SLACK_SEND_MESSAGE" },
      ctxWith({ approved: ["conn-1"] }),
    );
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("not an operation of gmail");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a connection that has not finished connecting", async () => {
    const out = await runToolTool.run(
      CALL,
      ctxWith({ row: { ...CONNECTION, status: "pending" }, approved: ["conn-1"] }),
    );
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("has not finished connecting");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the model to a different tool when the connection is not an application", async () => {
    const out = await runToolTool.run(
      CALL,
      ctxWith({ row: { ...CONNECTION, transport: "sql", toolkit_slug: null } }),
    );
    expect(out.kind === "error" && out.message).toContain("query_database");
  });

  it("asks the first time, and does not ask again on the same connection", async () => {
    const asked = await runToolTool.run(CALL, ctxWith());
    expect(asked.kind).toBe("needs_confirmation");
    expect(asked.kind === "needs_confirmation" && asked.summary).toContain("GMAIL_SEND_EMAIL");
    expect(fetchMock).not.toHaveBeenCalled();

    // One click unlocks that connection for the rest of the turn. `loop.ts`
    // derives this set from the steps; here it is handed over directly.
    const again = await runToolTool.run(CALL, ctxWith({ approved: ["conn-1"] }));
    expect(again.kind).toBe("ok");
  });

  it("still asks for a connection nobody approved this turn", async () => {
    const out = await runToolTool.run(CALL, ctxWith({ approved: ["conn-other"] }));
    expect(out.kind).toBe("needs_confirmation");
  });

  it("does not ask when a standing grant says always", async () => {
    const out = await runToolTool.run(CALL, ctxWith({ grant: { mode: "always" } }));
    expect(out.kind).toBe("ok");
  });

  it("still asks when the grant says ask, which is what no row means anyway", async () => {
    const out = await runToolTool.run(CALL, ctxWith({ grant: { mode: "ask" } }));
    expect(out.kind).toBe("needs_confirmation");
  });

  it("returns an error rather than a pause when nobody is watching", async () => {
    // A `needs_confirmation` in a scheduled run returns `paused` from
    // `runAgentTurn` and abandons the rest of the run. An error lets the run
    // finish and say what it could not do — and `agent-run.ts` only appends its
    // own "stopped short of…" note on a pause, so the reason has to be in here.
    const out = await runToolTool.run(CALL, ctxWith({ routineRunId: "run-1" }));
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("nobody is watching");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses before the network when the account has no allowance left", async () => {
    // The check `guardQuota` cannot do for us: it lets an exhausted caller
    // through on their workspace's own OpenAI key, which pays for completions
    // and does not pay for this.
    entitlements.allowed = false;
    const out = await runToolTool.run(CALL, ctxWith({ approved: ["conn-1"] }));
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("allowance");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("hands the model a file's text rather than its base64", async () => {
    // Left encoded, the model decodes it in output tokens: 4,625 completion
    // tokens on one pass of message f5d874c6, whose visible text was "let me
    // decode it fully".
    const encoded = Buffer.from("# Covan\n\nA shared agent.", "utf8").toString("base64");
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          successful: true,
          data: { name: "README.md", content: encoded, encoding: "base64" },
        }),
        { status: 200 },
      ),
    );
    const out = await runToolTool.run(CALL, ctxWith({ approved: ["conn-1"] }));
    expect(out.kind === "ok" && out.content).toContain("A shared agent.");
    expect(out.kind === "ok" && out.content).not.toContain(encoded);
  });

  it("forwards the far end's own words on a failure", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":"unknown field `recipient`"}', { status: 400 }),
    );
    const out = await runToolTool.run(CALL, ctxWith({ approved: ["conn-1"] }));
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("unknown field");
  });

  it("says so rather than guessing when the row has lost its account", async () => {
    composioAccount.mockResolvedValue(null as never);
    const out = await runToolTool.run(CALL, ctxWith({ approved: ["conn-1"] }));
    expect(out.kind === "error" && out.message).toContain("reconnected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("charges for a call the far end refused, because they charge for it too", async () => {
    const recorded: number[] = [];
    recordSpy.mockImplementation(async (_user: string, tokens: number) => {
      recorded.push(tokens);
    });
    fetchMock.mockResolvedValue(new Response("bad request", { status: 400 }));
    await runToolTool.run(CALL, ctxWith({ approved: ["conn-1"] }));
    expect(recorded).toEqual([1000]);
  });

  it("charges nothing for a failure that never reached them", async () => {
    // A deployment misconfiguration is not the account's to pay for. The 501
    // is raised by the client before any request is made.
    const recorded: number[] = [];
    recordSpy.mockImplementation(async (_user: string, tokens: number) => {
      recorded.push(tokens);
    });
    const ctx = ctxWith({ approved: ["conn-1"] });
    await runToolTool.run(CALL, { ...ctx, env: { ...ctx.env, COMPOSIO_API_KEY: "" } as ToolEnv });
    expect(recorded).toEqual([]);
  });

  it("is not offered by a deployment with no key", () => {
    expect(runToolTool.isConfigured({} as ToolEnv)).toBe(false);
    expect(runToolTool.isConfigured({ COMPOSIO_API_KEY: "ck" } as ToolEnv)).toBe(true);
  });

  /**
   * Prose, pinned, because here the prose is the whole mechanism. Nothing in
   * this file breaks if somebody tidies the sentence away, and the cost of
   * losing it was measured: five calls on one question, four of them the model
   * discovering `MAX_TOOL_OUTPUT_CHARS` by hitting it. Reword freely; keep the
   * fact that the answer is trimmed and that the first call should be narrow.
   */
  it("warns the model the answer is trimmed, rather than letting it find out", () => {
    expect(runToolTool.description).toMatch(/trimmed/i);
    expect(runToolTool.description).toMatch(/narrow/i);
  });
});

/**
 * Checking the arguments before spending a call on them.
 *
 * Four guards stood between a model and somebody else's mailbox and none of them
 * read the arguments, so a malformed call was discovered by Composio and billed.
 * `wasBilled` returns true for everything but 501 and 502, so a
 * `400 Invalid request data provided` costs a full `COMPOSIO_CALL_TOKENS` — the
 * same as a call that worked.
 *
 * Measured on 2026-09-26: ten billed rejections across three sessions putting one
 * recurring meeting on a calendar, about fifteen times the correct cost, and the
 * result was still wrong. Every one of those 400s named the offending field and
 * the type it wanted, and every one was checkable here against the schema
 * `find_tool` had already fetched. #195.
 */
describe("checking the arguments against the schema", () => {
  const CREATE_EVENT_SCHEMA = {
    type: "object",
    required: ["start_datetime"],
    properties: {
      start_datetime: { type: "string" },
      timezone: { type: "string" },
      attendees: { type: "array", items: { type: "string" } },
      send_updates: { type: "boolean" },
    },
  };

  const schemas = () =>
    new Map<string, import("../../composio/client").ComposioTool>([
      [
        "GMAIL_SEND_EMAIL",
        {
          slug: "GMAIL_SEND_EMAIL",
          name: "Send email",
          description: "Send an email.",
          toolkit: "gmail",
          required: ["start_datetime"],
          inputSchema: CREATE_EVENT_SCHEMA,
          destructive: null,
        },
      ],
    ]);

  it("refuses an argument of the wrong type before spending a call", async () => {
    // The real one: Composio's `send_updates` is a boolean, and both the
    // published docs and the raw Google API call it a string enum — so it is
    // what a model sends.
    const out = await runToolTool.run(
      {
        connectionId: "conn-1",
        slug: "GMAIL_SEND_EMAIL",
        arguments: { start_datetime: "2026-09-28T22:00:00", send_updates: "all" },
      },
      ctxWith({ approved: ["conn-1"], offeredOperations: schemas() }),
    );

    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("send_updates");
    expect(out.kind === "error" && out.message).toContain("boolean");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an array whose items are the wrong shape", async () => {
    // The one that cost five separate 400s. Composio wants plain email strings;
    // the published docs and the raw Google API both take objects with an
    // `email` field, so objects are what a model sends.
    const out = await runToolTool.run(
      {
        connectionId: "conn-1",
        slug: "GMAIL_SEND_EMAIL",
        arguments: {
          start_datetime: "2026-09-28T22:00:00",
          attendees: [{ email: "emre@covan.app" }, "mirac@covan.app"],
        },
      },
      ctxWith({ approved: ["conn-1"], offeredOperations: schemas() }),
    );

    expect(out.kind).toBe("error");
    // Named by index, because one bad entry in a list of three is otherwise a
    // hunt — and the second entry here is fine.
    expect(out.kind === "error" && out.message).toContain("attendees[0]");
    expect(out.kind === "error" && out.message).not.toContain("attendees[1]");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a required argument that was not sent", async () => {
    const out = await runToolTool.run(
      {
        connectionId: "conn-1",
        slug: "GMAIL_SEND_EMAIL",
        arguments: { timezone: "Europe/Istanbul" },
      },
      ctxWith({ approved: ["conn-1"], offeredOperations: schemas() }),
    );

    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("start_datetime");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * A regression guard rather than a behaviour this drove out: the check is
   * skipped when there is no schema, and it has to stay skipped. A slug can
   * arrive from an earlier turn or a standing grant with no `find_tool` result
   * behind it, and refusing what cannot be verified would break working calls to
   * prevent a mistake that has not happened.
   */
  it("runs the call untouched when no schema was offered for it", async () => {
    const out = await runToolTool.run(
      {
        connectionId: "conn-1",
        slug: "GMAIL_SEND_EMAIL",
        arguments: { send_updates: "all", attendees: [{ email: "a@b.c" }] },
      },
      ctxWith({ approved: ["conn-1"] }),
    );

    expect(out.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalled();
  });
});

/**
 * A slug the catalogue advertises and the service does not have.
 *
 * Production, 2026-09-26: `find_tool` returned `GOOGLECALENDAR_BATCH_EVENTS` as
 * the top match, with a full four-thousand-character argument schema, so
 * `run_tool`'s offered-slugs guard passed it — correctly, it was offered.
 * Composio's execute endpoint then answered
 * `404 {"code":2401,"slug":"Tool_ToolNotFound"}`. `wasBilled` returns true for
 * everything but 501 and 502, so we paid for it.
 *
 * Nothing in the turn learned from that. The slug stayed in the offered set, so
 * the guard would have waved a retry through to another 404. See #172.
 */
describe("an operation the service does not have", () => {
  const NOT_FOUND = () =>
    new Response(
      JSON.stringify({
        error: {
          message: "Tool GMAIL_SEND_EMAIL not found",
          code: 2401,
          slug: "Tool_ToolNotFound",
          status: 404,
        },
      }),
      { status: 404 },
    );

  it("stops offering a slug the service says does not exist", async () => {
    const offeredSlugs = new Set(["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"]);
    fetchMock.mockResolvedValue(NOT_FOUND());

    const out = await runToolTool.run(CALL, ctxWith({ approved: ["conn-1"], offeredSlugs }));

    expect(out.kind).toBe("error");
    // Withdrawn, so the guard refuses the retry for free instead of buying a
    // second 404.
    expect(offeredSlugs.has("GMAIL_SEND_EMAIL")).toBe(false);
    // And the pivot is named, because the alternative is the model searching
    // again for what it already has.
    expect(out.kind === "error" && out.message).toContain("GMAIL_FETCH_EMAILS");
  });
});

/**
 * What the person is actually asked, on the one surface where it decides
 * everything.
 *
 * Production, 2026-09-26 21:46 UTC. Somebody asked the agent to delete a few
 * recurring events — "vazgeçtim sil dailyleleri". It chose
 * `GOOGLECALENDAR_CLEAR_CALENDAR`, whose own description reads "Clears a primary
 * calendar by deleting all events from it", and the card it put in front of them
 * said, in full:
 *
 *     Run GOOGLECALENDAR_CLEAR_CALENDAR on Google Calendar?
 *
 * Approved in 2.7 seconds, which is the right reading time for "yes, delete the
 * dailies". Their entire primary calendar went.
 *
 * The guard worked. The sentence was the defect: a slug nobody has read, a
 * connection label, and no statement of what was about to happen or that it could
 * not be undone — while `destructive` and the description saying "deleting all
 * events" were both in hand. #201.
 */
describe("what a confirmation actually says", () => {
  const CALENDAR = {
    ...CONNECTION,
    id: "conn-cal",
    label: "Google Calendar",
    toolkit_slug: "googlecalendar",
  };
  const CLEAR = {
    slug: "GOOGLECALENDAR_CLEAR_CALENDAR",
    name: "Clear calendar",
    description:
      "Clears a primary calendar by deleting all events from it. The calendar itself is " +
      "preserved; only its events are removed.",
    toolkit: "googlecalendar",
    required: ["calendar_id"],
    inputSchema: null,
    destructive: true,
  };

  it("names the act and warns it cannot be undone, not just the slug", async () => {
    const out = await runToolTool.run(
      {
        connectionId: "conn-cal",
        slug: "GOOGLECALENDAR_CLEAR_CALENDAR",
        arguments: { calendar_id: "primary" },
      },
      ctxWith({ row: CALENDAR, offeredOperations: new Map([[CLEAR.slug, CLEAR]]) }),
    );

    expect(out.kind).toBe("needs_confirmation");
    const summary = out.kind === "needs_confirmation" ? out.summary : "";
    // The sentence that would have stopped the click.
    expect(summary).toContain("deleting all events");
    expect(summary).toMatch(/cannot be undone/i);
  });
});

/**
 * How far one yes reaches, when the next call is destructive.
 *
 * `approvedConnections` scopes an approval to the connection for the rest of the
 * turn, and the reason is good: three clicks to answer "check my last three
 * threads and reply to Ana" trains people to approve without reading. But it
 * means any call after the first runs unasked — including one that empties the
 * account. A turn that creates an event and then clears the calendar asks once,
 * about the create.
 *
 * So the reach is narrowed at exactly one point: an operation Composio marks
 * `destructive` asks again unless that same operation has already been approved
 * this turn. Repeating the one that was approved stays free, which is what the
 * original reasoning was protecting. #201.
 */
describe("how far one approval reaches", () => {
  const CALENDAR = {
    ...CONNECTION,
    id: "conn-cal",
    label: "Google Calendar",
    toolkit_slug: "googlecalendar",
  };
  const op = (slug: string, destructive: boolean | null) => ({
    slug,
    name: slug,
    description: "Does a thing.",
    toolkit: "googlecalendar",
    required: [],
    inputSchema: null,
    destructive,
  });
  const known = new Map([
    ["GOOGLECALENDAR_CLEAR_CALENDAR", op("GOOGLECALENDAR_CLEAR_CALENDAR", true)],
    ["GOOGLECALENDAR_EVENTS_LIST", op("GOOGLECALENDAR_EVENTS_LIST", false)],
  ]);

  it("asks again for a destructive operation the turn has not already approved", async () => {
    const out = await runToolTool.run(
      { connectionId: "conn-cal", slug: "GOOGLECALENDAR_CLEAR_CALENDAR", arguments: {} },
      ctxWith({
        row: CALENDAR,
        // A create earlier in this turn already unlocked the connection.
        approved: ["conn-cal"],
        approvedSlugs: ["GOOGLECALENDAR_CREATE_EVENT"],
        offeredOperations: known,
      }),
    );

    expect(out.kind).toBe("needs_confirmation");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still lets a harmless operation through on the connection's approval", async () => {
    const out = await runToolTool.run(
      { connectionId: "conn-cal", slug: "GOOGLECALENDAR_EVENTS_LIST", arguments: {} },
      ctxWith({
        row: CALENDAR,
        approved: ["conn-cal"],
        approvedSlugs: ["GOOGLECALENDAR_CREATE_EVENT"],
        offeredOperations: known,
      }),
    );

    expect(out.kind).toBe("ok");
  });

  it("does not re-ask for the destructive operation it already approved", async () => {
    const out = await runToolTool.run(
      { connectionId: "conn-cal", slug: "GOOGLECALENDAR_CLEAR_CALENDAR", arguments: {} },
      ctxWith({
        row: CALENDAR,
        approved: ["conn-cal"],
        approvedSlugs: ["GOOGLECALENDAR_CLEAR_CALENDAR"],
        offeredOperations: known,
      }),
    );

    expect(out.kind).toBe("ok");
  });
});
