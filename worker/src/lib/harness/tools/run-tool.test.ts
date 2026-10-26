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
// Every 404 for a slug the account does not have is now written back to the
// connection, so the next search stops offering it. Spied rather than stubbed
// away: two tests below assert it was called with the slug that failed.
const recordUnavailable = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../secrets", () => ({
  composioAccount: () => composioAccount(),
  recordUnavailableTool: (...args: unknown[]) => recordUnavailable(...args),
}));

const entitlements = { allowed: true as boolean };
const recordSpy = vi.fn(async (_workspaceId: string, _spent: unknown[]) => {});
vi.mock("../../entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../entitlements")>();
  return {
    ...actual,
    entitlementsFor: () => ({
      check: async () =>
        entitlements.allowed ? { allowed: true } : { allowed: false, balance: 0 },
      record: (workspaceId: string, spent: unknown[]) => recordSpy(workspaceId, spent),
      snapshot: async () => ({ metered: false }),
    }),
  };
});

// The catalogue lookup an undescribed slug gets before the gate decides. By
// default the catalogue cannot describe it, which the gate reads as a change;
// the tests about a recalled read say what it answers. Mocked apart from
// `fetch` so the calls a test counts are the calls made on somebody's behalf.
const getToolMock = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({
  kind: "error",
  status: 404,
  message: "not described",
}));
vi.mock("../../composio/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../composio/client")>();
  return { ...actual, getTool: (...args: unknown[]) => getToolMock(...args) };
});

const fetchMock = vi.fn();
vi.stubGlobal("fetch", (...args: unknown[]) => fetchMock(...args));

// The small model that reads pages for a `question`. `read-pages.test.ts` has
// the paging itself; here it only has to answer.
const completeMock = vi.fn(async () => ({
  text: "- m1: late delivery",
  usage: { promptTokens: 100, completionTokens: 10, cachedTokens: null },
  finishReason: "stop",
}));
vi.mock("../../completion", () => ({ complete: () => completeMock() }));

const CONNECTION = {
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

/**
 * A context whose chain mirrors what the tool actually calls: `loadConnection`
 * is `select().eq().eq().or().maybeSingle()`, and the standing permission is
 * `select().eq().eq().maybeSingle()`. Told apart by table, because getting
 * them the wrong way round is how a test proves the wrong thing.
 */
function ctxWith(
  over: {
    row?: Record<string, unknown> | null;
    /** Whether this agent may change things in the connection without asking. */
    grant?: boolean;
    approvedSlugs?: string[];
    confirmed?: boolean;
    routineRunId?: string;
    /** The caller's role in the workspace; a member unless a test says. */
    role?: "admin" | "member" | "viewer" | null;
    offeredSlugs?: Set<string>;
    offeredOperations?: Map<string, import("../../composio/client").ComposioTool>;
  } = {},
): ToolContext {
  const row = over.row === undefined ? CONNECTION : over.row;
  return {
    db: {
      from: (table: string) =>
        table === "workspace_members"
          ? {
              select: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: over.role === null ? null : { role: over.role ?? "member" },
                      error: null,
                    }),
                  }),
                }),
              }),
            }
          : table === "tool_connection_grants"
            ? {
                select: () => ({
                  eq: () => ({
                    eq: () => ({
                      maybeSingle: async () => ({
                        data: over.grant ? { agent_id: "agent-1" } : null,
                        error: null,
                      }),
                    }),
                  }),
                }),
              }
            : {
                select: () => ({
                  eq: () => ({
                    eq: () => ({
                      or: () => ({ maybeSingle: async () => ({ data: row, error: null }) }),
                    }),
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

/**
 * The one operation `find_tool` described this turn, in the map `run_tool` reads.
 *
 * A connection's approval now reaches an operation only if this turn actually
 * described it, so a test about that reach has to say what was described. The
 * tests that are about something else say `grant: true` instead —
 * a standing per-slug grant, which is the shape a slug with no `find_tool`
 * result behind it really arrives in.
 */
function describing(
  slug: string,
  toolkit = "gmail",
  destructive: boolean | null = false,
): Map<string, import("../../composio/client").ComposioTool> {
  return new Map([
    [
      slug,
      {
        slug,
        name: slug,
        description: "Does a thing.",
        toolkit,
        required: [],
        inputSchema: null,
        destructive,
      },
    ],
  ]);
}

beforeEach(() => {
  getToolMock.mockReset();
  getToolMock.mockResolvedValue({ kind: "error", status: 404, message: "not described" });
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
      ctxWith({ grant: true }),
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
      ctxWith({
        offeredOperations: describing(CALL.slug),
        offeredSlugs: new Set(["GMAIL_SEND_EMAIL"]),
      }),
    );
    expect(out.kind).toBe("ok");
  });

  it("refuses nothing when find_tool has not answered this turn", async () => {
    // An empty set is not "nothing was offered", it is "nobody searched". The
    // slug can have come from an earlier turn still in the transcript or from
    // a standing grant, and refusing those would break working behaviour to
    // prevent a mistake that has not happened.
    const out = await runToolTool.run(CALL, ctxWith({ grant: true, offeredSlugs: new Set() }));
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
    const out = await runToolTool.run({ ...CALL, slug: "SLACK_SEND_MESSAGE" }, ctxWith());
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("not an operation of gmail");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * An application whose slug has an underscore, which is a quarter of them.
   *
   * These three exist because this file's fixtures are the reason covan#261
   * survived eleven days in production: every one of them is `gmail` or
   * `googlecalendar`, and the guard above derived a toolkit with
   * `slug.split("_")[0]`. That is strictly shorter than any slug containing an
   * underscore, so the comparison could never be equal and **336 of the 1,402
   * connectable applications** — Microsoft Teams, Google Analytics, OneDrive,
   * SharePoint, every Zoho app — had every operation refused here, locally,
   * with no request made and nothing recorded to stop the model trying again.
   *
   * One case per path through the new check, because they fail differently: the
   * catalogue's own `toolkit` field when `find_tool` answered this turn, the
   * spelling when it did not.
   */
  const TEAMS = {
    ...CONNECTION,
    id: "conn-1",
    label: "Work Teams",
    toolkit_slug: "microsoft_teams",
  };
  const TEAMS_CALL = { ...CALL, slug: "MICROSOFT_TEAMS_SEND_MESSAGE" };

  it("runs an operation of an application whose slug has an underscore", async () => {
    // The authoritative path: `find_tool` answered, so the catalogue's own
    // `toolkit` is in hand and the spelling is never consulted.
    const out = await runToolTool.run(
      TEAMS_CALL,
      ctxWith({
        row: TEAMS,
        offeredOperations: new Map([
          [
            TEAMS_CALL.slug,
            {
              slug: TEAMS_CALL.slug,
              name: "Send message",
              description: "Send a message.",
              toolkit: "microsoft_teams",
              required: [],
              inputSchema: null,
              destructive: false,
            },
          ],
        ]),
      }),
    );
    expect(out.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("falls back to the spelling, with the underscore boundary kept", async () => {
    // No `offeredOperations` — the slug came from an earlier turn or a standing
    // grant. The convention is all there is, and it has to be read as a prefix
    // ending at a `_` rather than as everything before the first one.
    const out = await runToolTool.run(TEAMS_CALL, ctxWith({ row: TEAMS, grant: true }));
    expect(out.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("still refuses a foreign slug that shares a prefix with the connection", async () => {
    // The mistake guard 2 exists for, in the shape the fallback could plausibly
    // let through: `microsoft` is a prefix of `microsoft_teams` by spelling and
    // is a different application. Neither path may accept it.
    const out = await runToolTool.run(
      { ...CALL, slug: "MICROSOFT_OUTLOOK_SEND_MAIL" },
      ctxWith({ row: TEAMS }),
    );
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("not an operation of microsoft_teams");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("believes the catalogue over the spelling when the two disagree", async () => {
    // The authoritative read is not a shortcut to the same answer, it is a
    // different and better answer — so it must also be able to REFUSE a slug
    // the spelling would have waved through. Without this, dropping the
    // `operation?.toolkit` read would leave every test above still green.
    const out = await runToolTool.run(
      TEAMS_CALL,
      ctxWith({
        row: TEAMS,
        offeredOperations: new Map([
          [
            TEAMS_CALL.slug,
            {
              slug: TEAMS_CALL.slug,
              name: "Send message",
              description: "Send a message.",
              toolkit: "microsoft_outlook",
              required: [],
              inputSchema: null,
              destructive: null,
            },
          ],
        ]),
      }),
    );
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("not an operation of microsoft_teams");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs an operation of an application that needs no credential", async () => {
    // covan#253, the far end of it. `composioAccount` answers with an empty
    // account id and a real identifier for a `composio_no_auth` row, and the
    // request must then carry `user_id` and no account key at all.
    composioAccount.mockResolvedValue({ connectedAccountId: "", composioUserId: "cu_open" });
    const out = await runToolTool.run(
      { ...CALL, slug: "HACKERNEWS_GET_LATEST_POSTS", arguments: {} },
      ctxWith({
        row: {
          ...CONNECTION,
          label: "Hacker News",
          auth_kind: "composio_no_auth",
          toolkit_slug: "hackernews",
        },
        grant: true,
      }),
    );
    expect(out.kind).toBe("ok");
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(Object.keys(body)).not.toContain("connected_account_id");
    expect(body.user_id).toBe("cu_open");
  });

  it("runs an operation named exactly after its own application", async () => {
    // `COMPOSIO_SEARCH` on `composio_search` is not hypothetical — a toolkit
    // whose whole purpose is one operation often names it after itself, and the
    // old prefix split could not express "equal to" at all.
    const out = await runToolTool.run(
      { ...CALL, slug: "COMPOSIO_SEARCH" },
      ctxWith({
        row: { ...CONNECTION, label: "Web search", toolkit_slug: "composio_search" },
        grant: true,
      }),
    );
    expect(out.kind).toBe("ok");
  });

  it("refuses a connection that has not finished connecting", async () => {
    const out = await runToolTool.run(CALL, ctxWith({ row: { ...CONNECTION, status: "pending" } }));
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

  it("runs a read without asking, in chat", async () => {
    const out = await runToolTool.run(
      CALL,
      ctxWith({ offeredOperations: describing(CALL.slug, "gmail", false) }),
    );
    expect(out).toMatchObject({ kind: "ok", approval: "read" });
  });

  it("asks for a change, and not again for the same operation on the same connection this reply", async () => {
    const asked = await runToolTool.run(CALL, ctxWith());
    expect(asked.kind).toBe("needs_confirmation");
    expect(asked.kind === "needs_confirmation" && asked.summary).toContain("GMAIL_SEND_EMAIL");
    expect(fetchMock).not.toHaveBeenCalled();

    // A yes earlier in the reply. `loop.ts` derives this set from the steps;
    // here it is handed over directly.
    const again = await runToolTool.run(
      CALL,
      ctxWith({ approvedSlugs: ["conn-1:GMAIL_SEND_EMAIL"] }),
    );
    expect(again).toMatchObject({ kind: "ok", approval: "person" });
  });

  it("a yes on one connection does not cover the same operation on another", async () => {
    const out = await runToolTool.run(
      CALL,
      ctxWith({ approvedSlugs: ["conn-other:GMAIL_SEND_EMAIL"] }),
    );
    expect(out.kind).toBe("needs_confirmation");
  });

  it("does not ask when the agent may change things in this app", async () => {
    const out = await runToolTool.run(CALL, ctxWith({ grant: true }));
    expect(out).toMatchObject({ kind: "ok", approval: "grant" });
  });

  it("asks for a change when there is no row", async () => {
    const out = await runToolTool.run(CALL, ctxWith({ grant: false }));
    expect(out.kind).toBe("needs_confirmation");
  });

  it("returns an error rather than a pause for a change when nobody is watching", async () => {
    // A `needs_confirmation` in a scheduled run returns `paused` from
    // `runAgentTurn` and abandons the rest of the run. An error lets the run
    // finish and say what it could not do — and `agent-run.ts` only appends its
    // own "stopped short of…" note on a pause, so the reason has to be in here.
    const out = await runToolTool.run(CALL, ctxWith({ routineRunId: "run-1" }));
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("nobody is watching");
    expect(out.kind === "error" && out.message).toContain("changes something in Ana's Gmail");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs a read on a scheduled run without asking anyone (covan#410)", async () => {
    // The routine the mail scan turns on: no person, no grant, nothing
    // described this run but what find_tool returned. Every read was refused
    // here before, listing labels included, and the digest said so.
    const out = await runToolTool.run(
      { ...CALL, slug: "GMAIL_FETCH_EMAILS", arguments: {} },
      ctxWith({
        routineRunId: "run-1",
        offeredOperations: describing("GMAIL_FETCH_EMAILS", "gmail", false),
      }),
    );
    expect(out).toMatchObject({ kind: "ok", approval: "read" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("runs a change on a scheduled run with the standing permission", async () => {
    const out = await runToolTool.run(CALL, ctxWith({ routineRunId: "run-1", grant: true }));
    expect(out).toMatchObject({ kind: "ok", approval: "grant" });
  });

  it("refuses before the network when the workspace has no credits left", async () => {
    entitlements.allowed = false;
    const out = await runToolTool.run(CALL, ctxWith({ grant: true }));
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("no credits left");
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
    const out = await runToolTool.run(CALL, ctxWith({ grant: true }));
    expect(out.kind === "ok" && out.content).toContain("A shared agent.");
    expect(out.kind === "ok" && out.content).not.toContain(encoded);
  });

  it("forwards the far end's own words on a failure", async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":"unknown field `recipient`"}', { status: 400 }),
    );
    const out = await runToolTool.run(CALL, ctxWith({ grant: true }));
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("unknown field");
  });

  it("says so rather than guessing when the row has lost its account", async () => {
    composioAccount.mockResolvedValue(null as never);
    const out = await runToolTool.run(CALL, ctxWith({ grant: true }));
    expect(out.kind === "error" && out.message).toContain("reconnected");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("charges for a call the far end refused, because they charge for it too", async () => {
    const recorded: unknown[] = [];
    recordSpy.mockImplementation(async (_workspace: string, spent: unknown[]) => {
      recorded.push(...spent);
    });
    fetchMock.mockResolvedValue(new Response("bad request", { status: 400 }));
    await runToolTool.run(CALL, ctxWith({ grant: true }));
    expect(recorded).toEqual([expect.objectContaining({ kind: "composio_call" })]);
  });

  it("charges nothing for a failure that never reached them", async () => {
    // A deployment misconfiguration is not the account's to pay for. The 501
    // is raised by the client before any request is made.
    const recorded: unknown[] = [];
    recordSpy.mockImplementation(async (_workspace: string, spent: unknown[]) => {
      recorded.push(...spent);
    });
    const ctx = ctxWith({ grant: true });
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
 * `400 Invalid request data provided` costs a full call — the
 * same as a call that worked.
 *
 * Measured on 2026-09-26: ten billed rejections across three sessions putting one
 * recurring meeting on a calendar, about fifteen times the correct cost, and the
 * result was still wrong. Every one of those 400s named the offending field and
 * the type it wanted, and every one was checkable here against the schema
 * `find_tool` had already fetched. #195.
 */
/**
 * A viewer reads and changes nothing. They can chat, and an agent's tools ran
 * for them as for anybody — so a viewer could send mail through a connected
 * account and approve the card themselves.
 */
describe("a viewer", () => {
  it("cannot run an operation that changes something, even with their own yes", async () => {
    const out = await runToolTool.run(
      CALL,
      ctxWith({
        role: "viewer",
        confirmed: true,
        offeredOperations: describing("GMAIL_SEND_EMAIL", "gmail", null),
      }),
    );
    expect(out).toMatchObject({ kind: "error", message: expect.stringMatching(/viewer/) });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cannot run one nothing has described, which is not known to be a read", async () => {
    const out = await runToolTool.run(CALL, ctxWith({ role: "viewer", grant: true }));
    expect(out).toMatchObject({ kind: "error", message: expect.stringMatching(/viewer/) });
  });

  it("can run one the catalogue marks as only reading", async () => {
    const out = await runToolTool.run(
      { ...CALL, slug: "GMAIL_FETCH_EMAILS" },
      ctxWith({
        role: "viewer",
        confirmed: true,
        offeredOperations: describing("GMAIL_FETCH_EMAILS", "gmail", false),
      }),
    );
    expect(out.kind).toBe("ok");
  });

  it("is refused when their membership cannot be read, rather than let through", async () => {
    const out = await runToolTool.run(
      CALL,
      ctxWith({
        role: null,
        confirmed: true,
        offeredOperations: describing("GMAIL_SEND_EMAIL", "gmail", null),
      }),
    );
    expect(out).toMatchObject({ kind: "error" });
  });
});

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
      ctxWith({ offeredOperations: schemas() }),
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
      ctxWith({ offeredOperations: schemas() }),
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
      ctxWith({ offeredOperations: schemas() }),
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
      ctxWith({ grant: true }),
    );

    expect(out.kind).toBe("ok");
    expect(fetchMock).toHaveBeenCalled();
  });

  /**
   * The narrowing argument that narrows nothing.
   *
   * Measured on 2026-09-28, and it is the most expensive turn on record. Asked to
   * list a repository's open pull requests, the model ran
   * `GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS` three times: once plain, once with
   * `fields: [...]`, once with `response_detail: "minimal"`. Neither of those is
   * in that operation's schema. Nothing complained, both went to Composio, and
   * all three answers came back **byte-identical** at the 12,000-character cap —
   * so the transcript carried the same oversized result three times, and the
   * second and third copies alone were about 120,000 re-sent tokens, 27% of the
   * turn.
   *
   * `run_tool`'s own description is what asks for this ("name only the fields you
   * need"), so the model was following instructions into a wall. Refusing locally
   * is strictly cheaper than letting Composio ignore it: Composio validates
   * against this same schema — the same turn got "Following fields are missing:
   * {'query'}" back from it — so a property the schema does not name was never
   * going to do anything.
   */
  it("refuses an argument the schema does not name, and says what it does take", async () => {
    const out = await runToolTool.run(
      {
        connectionId: "conn-1",
        slug: "GMAIL_SEND_EMAIL",
        arguments: { start_datetime: "2026-09-28T22:00:00", response_detail: "minimal" },
      },
      ctxWith({ offeredOperations: schemas() }),
    );

    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("response_detail");
    // The list of what it does take, so the next call is a fixed call rather
    // than another guess.
    expect(out.kind === "error" && out.message).toContain("start_datetime");
    expect(out.kind === "error" && out.message).toContain("send_updates");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  /**
   * The gate, and the only real risk in refusing unknown properties.
   *
   * A Composio schema need not carry `properties` at all — `client.ts` reads
   * `required` from a separate key, and search rows shaped `{required: [...]}`
   * with nothing else are common enough that this repo's own fixtures are mostly
   * that shape. With no `properties` to check against, EVERY argument looks
   * unknown, and a validator that refused them would block every call to an
   * operation whose publisher simply did not describe its arguments.
   */
  it("refuses nothing for a schema that names no properties at all", async () => {
    const out = await runToolTool.run(
      { connectionId: "conn-1", slug: "GMAIL_SEND_EMAIL", arguments: { anything: 1, at: "all" } },
      ctxWith({
        offeredOperations: new Map([
          [
            "GMAIL_SEND_EMAIL",
            {
              slug: "GMAIL_SEND_EMAIL",
              name: "Send email",
              description: "Send an email.",
              toolkit: "gmail",
              required: [],
              inputSchema: { type: "object", required: [] },
              destructive: false,
            },
          ],
        ]) as Map<string, import("../../composio/client").ComposioTool>,
      }),
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

    const out = await runToolTool.run(CALL, ctxWith({ grant: true, offeredSlugs }));

    expect(out.kind).toBe("error");
    // Withdrawn, so the guard refuses the retry for free instead of buying a
    // second 404.
    expect(offeredSlugs.has("GMAIL_SEND_EMAIL")).toBe(false);
    // And the pivot is named, because the alternative is the model searching
    // again for what it already has.
    expect(out.kind === "error" && out.message).toContain("GMAIL_FETCH_EMAILS");
  });

  it("writes the slug back to the connection, so the withdrawal outlives the turn", async () => {
    // Withdrawing it from the per-turn set was never enough. Measured on
    // 2026-09-28: one conversation bought GITHUB_GET_PULL_REQUESTS three times —
    // the next find_tool re-offered it two steps later, because the catalogue
    // still lists it, and the turn after started over.
    recordUnavailable.mockClear();
    fetchMock.mockResolvedValue(NOT_FOUND());

    await runToolTool.run(CALL, ctxWith({ grant: true }));

    expect(recordUnavailable).toHaveBeenCalledTimes(1);
    const [, connection, slug] = recordUnavailable.mock.calls[0];
    expect(slug).toBe("GMAIL_SEND_EMAIL");
    expect((connection as { id: string }).id).toBe("conn-1");
  });

  it("refuses a slug the connection already proved it cannot run, without spending a call", async () => {
    // The case the per-turn set could never catch: the slug came from the
    // transcript of an earlier turn, so nothing this turn offered it and the
    // offered-slugs guard has nothing to say.
    fetchMock.mockClear();
    const out = await runToolTool.run(
      CALL,
      ctxWith({
        row: {
          ...CONNECTION,
          config: { unavailable_tools: { GMAIL_SEND_EMAIL: new Date().toISOString() } },
        },
      }),
    );

    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("does not have it");
    // The whole point: nothing left the building.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tries again once the record has aged out", async () => {
    // It has to expire, because re-authorising an app with broader scopes can
    // add operations the account did not have. A permanent exclusion would hide
    // one forever with nothing saying why.
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue(NOT_FOUND());

    await runToolTool.run(
      CALL,
      ctxWith({
        grant: true,
        row: { ...CONNECTION, config: { unavailable_tools: { GMAIL_SEND_EMAIL: old } } },
      }),
    );

    expect(fetchMock).toHaveBeenCalled();
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

  /**
   * The proposal is also the resume payload.
   *
   * A resumed turn is built with an empty `offeredOperations` — only
   * `find_tool` fills it and the second half of the turn has no reason to
   * search again — so everything the first half knew about the operation is
   * gone by the time the approved call runs: its schema (guard 1), the
   * catalogue's own `toolkit` (guard 2) and `destructive`. The call a person
   * actually said yes to was the one call in the product running with the least
   * checked. `paused_turns.proposal` is written verbatim, so the row travels in
   * it; `routes/chat.ts` puts it back.
   */
  it("carries the operation it described, so the approved call is still checked", async () => {
    const out = await runToolTool.run(
      { connectionId: "conn-cal", slug: CLEAR.slug, arguments: { calendar_id: "primary" } },
      ctxWith({ row: CALENDAR, offeredOperations: new Map([[CLEAR.slug, CLEAR]]) }),
    );

    expect(out.kind).toBe("needs_confirmation");
    const proposal =
      out.kind === "needs_confirmation" ? (out.proposal as Record<string, unknown>) : {};
    expect(proposal.operation).toEqual(CLEAR);
  });

  it("proposes nothing about an operation it was never told about", async () => {
    // Undefined rather than a half-filled row: a resume that rebuilt an
    // operation from guesses would be checking the approved call against
    // fiction, and the card would say what it does not know.
    const out = await runToolTool.run(
      { connectionId: "conn-cal", slug: CLEAR.slug, arguments: {} },
      ctxWith({ row: CALENDAR }),
    );

    expect(out.kind).toBe("needs_confirmation");
    const proposal =
      out.kind === "needs_confirmation" ? (out.proposal as Record<string, unknown>) : {};
    expect(proposal.operation).toBeUndefined();
  });
});

/**
 * What a yes reaches, and what a read needs.
 *
 * A read needs nobody. A change needs a yes, and a yes covers the operation it
 * was given for on the connection it was given on, for the rest of the reply.
 * On 2026-09-26 a calendar was cleared by an operation the person had never
 * approved, riding on an approval of another one on the same connection. #201.
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

  it("asks again for a destructive operation the reply has not already approved", async () => {
    const out = await runToolTool.run(
      { connectionId: "conn-cal", slug: "GOOGLECALENDAR_CLEAR_CALENDAR", arguments: {} },
      ctxWith({
        row: CALENDAR,
        // A create earlier in this reply was approved.
        approvedSlugs: ["conn-cal:GOOGLECALENDAR_CREATE_EVENT"],
        offeredOperations: known,
      }),
    );

    expect(out.kind).toBe("needs_confirmation");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a read needs no approval at all", async () => {
    const out = await runToolTool.run(
      { connectionId: "conn-cal", slug: "GOOGLECALENDAR_EVENTS_LIST", arguments: {} },
      ctxWith({ row: CALENDAR, offeredOperations: known }),
    );

    expect(out).toMatchObject({ kind: "ok", approval: "read" });
  });

  it("does not re-ask for the destructive operation it already approved", async () => {
    const out = await runToolTool.run(
      { connectionId: "conn-cal", slug: "GOOGLECALENDAR_CLEAR_CALENDAR", arguments: {} },
      ctxWith({
        row: CALENDAR,
        approvedSlugs: ["conn-cal:GOOGLECALENDAR_CLEAR_CALENDAR"],
        offeredOperations: known,
      }),
    );

    expect(out).toMatchObject({ kind: "ok", approval: "person" });
  });

  /**
   * An operation this turn never described: a resumed turn, a scheduled run, a
   * slug recalled from an earlier turn. It is described from the catalogue
   * before anything is decided, and treated as a change when it cannot be.
   */
  it("describes an undescribed operation from the catalogue before deciding", async () => {
    getToolMock.mockResolvedValueOnce({
      kind: "ok",
      tool: op("GOOGLECALENDAR_EVENTS_LIST", false),
    });
    const ctx = ctxWith({ row: CALENDAR, offeredOperations: new Map() });
    const out = await runToolTool.run(
      { connectionId: "conn-cal", slug: "GOOGLECALENDAR_EVENTS_LIST", arguments: {} },
      ctx,
    );

    expect(getToolMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ kind: "ok", approval: "read" });
    // Kept for the rest of the turn, so the next call does not look it up again.
    expect(ctx.offeredOperations?.has("GOOGLECALENDAR_EVENTS_LIST")).toBe(true);
  });

  it("asks when the catalogue cannot describe the operation", async () => {
    const out = await runToolTool.run(
      { connectionId: "conn-cal", slug: "GOOGLECALENDAR_EVENTS_LIST", arguments: {} },
      ctxWith({ row: CALENDAR }),
    );

    expect(out.kind).toBe("needs_confirmation");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not look up an operation somebody already said yes to", async () => {
    const out = await runToolTool.run(
      { connectionId: "conn-cal", slug: "GOOGLECALENDAR_CLEAR_CALENDAR", arguments: {} },
      ctxWith({ row: CALENDAR, confirmed: true }),
    );

    expect(getToolMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ kind: "ok", approval: "person" });
  });

  it("refuses an undescribed operation on a scheduled run rather than running it", async () => {
    // Where nobody can answer the question, the refusal reaches the run
    // report rather than becoming a call.
    const out = await runToolTool.run(
      { connectionId: "conn-cal", slug: "GOOGLECALENDAR_CLEAR_CALENDAR", arguments: {} },
      ctxWith({
        row: CALENDAR,
        approvedSlugs: ["conn-cal:GOOGLECALENDAR_EVENTS_LIST"],
        routineRunId: "run-1",
      }),
    );

    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toContain("nobody is watching");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * An operation Composio annotates with no hint — `destructive: null`, which is
 * how it marks `GMAIL_SEND_EMAIL` — is a change. Text in an email the agent
 * was reading must not be able to have it send one.
 */
describe("what counts as a read", () => {
  const described = (destructive: boolean | null) =>
    new Map([
      [
        "GMAIL_SEND_EMAIL",
        {
          slug: "GMAIL_SEND_EMAIL",
          name: "Send email",
          description: "Send an email.",
          toolkit: "gmail",
          required: [],
          inputSchema: null,
          destructive,
        },
      ],
    ]) as Map<string, import("../../composio/client").ComposioTool>;
  const SEND = { connectionId: "conn-1", slug: "GMAIL_SEND_EMAIL", arguments: {} };

  it("treats null as a change", async () => {
    const out = await runToolTool.run(SEND, ctxWith({ offeredOperations: described(null) }));
    expect(out.kind).toBe("needs_confirmation");
    expect(out.kind === "needs_confirmation" && out.summary).toContain("may change data there");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a read as read", async () => {
    const out = await runToolTool.run(SEND, ctxWith({ offeredOperations: described(false) }));
    expect(out).toMatchObject({ kind: "ok", approval: "read" });
  });

  // The loop counts only a person's yes as covering the operation for the
  // rest of the reply (`approvedSlugsFrom`), so the result says whose it is.
  it("reports a person's yes as the person's", async () => {
    expect(await runToolTool.run(SEND, ctxWith({ confirmed: true }))).toMatchObject({
      kind: "ok",
      approval: "person",
    });
  });

  it("reports a standing grant as a grant", async () => {
    expect(await runToolTool.run(SEND, ctxWith({ grant: true }))).toMatchObject({
      kind: "ok",
      approval: "grant",
    });
  });
});

describe("reading many results for a question", () => {
  const FETCH = {
    slug: "GMAIL_FETCH_EMAILS",
    name: "Fetch emails",
    description: "Fetches a list of email messages.",
    toolkit: "gmail",
    required: [],
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, page_token: { type: "string" } },
    },
    destructive: false,
  };
  const ASK = {
    connectionId: "conn-1",
    slug: "GMAIL_FETCH_EMAILS",
    arguments: { query: "newer_than:14d" },
    question: "complaints about late delivery",
  };
  const reading = (destructive: boolean | null = false) =>
    new Map([[FETCH.slug, { ...FETCH, destructive }]]) as Map<
      string,
      import("../../composio/client").ComposioTool
    >;
  const mail = (next: string | null) =>
    new Response(
      JSON.stringify({
        successful: true,
        data: { messages: [{ messageId: "m1" }], ...(next ? { nextPageToken: next } : {}) },
      }),
      { status: 200 },
    );

  it("refuses a question on an operation not known to only read, before asking anyone", async () => {
    const out = await runToolTool.run(
      { ...ASK, slug: "GMAIL_SEND_EMAIL" },
      ctxWith({ offeredOperations: describing("GMAIL_SEND_EMAIL", "gmail", null) }),
    );
    expect(out.kind).toBe("error");
    expect(out.kind === "error" && out.message).toMatch(/only done for one known to just read/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a question on an operation the catalogue cannot describe", async () => {
    const out = await runToolTool.run(ASK, ctxWith({ grant: true }));
    expect(out.kind === "error" && out.message).toMatch(/find it with find_tool first/);
  });

  it("follows the page token and hands back the findings, not the pages", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(mail("t2")).mockResolvedValueOnce(mail(null));
    const out = await runToolTool.run(ASK, ctxWith({ offeredOperations: reading() }));
    expect(out).toMatchObject({ kind: "ok", approval: "read" });
    expect(out.kind === "ok" && out.content).toMatch(/^Read 2 pages of GMAIL_FETCH_EMAILS/);
    expect(out.kind === "ok" && out.content).toContain("m1: late delivery");
    const second = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(second.arguments).toEqual({ query: "newer_than:14d", page_token: "t2" });
  });

  it("is given longer than an ordinary call, and only when it asks a question", () => {
    expect(runToolTool.timeoutFor?.(ASK)).toBeGreaterThan(20_000);
    expect(runToolTool.timeoutFor?.({ ...ASK, question: undefined })).toBeUndefined();
  });

  it("says in words that there is another page, and which argument takes it", async () => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(mail("t2"));
    const out = await runToolTool.run(
      { ...ASK, question: undefined },
      ctxWith({ offeredOperations: reading() }),
    );
    expect(out.kind === "ok" && out.content).toMatch(
      /\[more results: send page_token: "t2" for the next page/,
    );
  });
});
