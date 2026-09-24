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
    confirmed?: boolean;
    routineRunId?: string;
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
    env: {
      ALLOWED_ORIGIN: "https://app.covan.test",
      ROUTINE_SECRET_KEY: "k",
      COMPOSIO_API_KEY: "ck_test",
    } as ToolEnv,
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    ...(over.approved ? { approvedConnections: over.approved } : {}),
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
});
