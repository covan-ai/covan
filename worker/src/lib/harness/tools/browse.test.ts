import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";
import type { BrowserResult } from "../../browser/client";
import type { BrowserSessionRef } from "../../browser/sessions";
import type { QuotaSnapshot } from "../../entitlements";
import { DEFAULT_MODEL, RUN_COST_CAP_USD, V4_BASE } from "../../browser/v4";
import { OUTCOME_SCHEMA } from "../../browser/outcome";

/**
 * The provider, at the `fetch` level rather than at `createRun`.
 *
 * Deliberately one floor lower than the other doubles here: what this tool
 * promises the operator is a request BODY — the preamble in the task text, the
 * schema beside it, the cost ceiling, the session it continues — and a mock of
 * `createRun` would check the arguments and trust the mapping. `v4.ts` is real
 * here, and the body asserted on is the one that would leave the Worker.
 */
const RUN_ID = "11111111-1111-4111-8111-111111111111";
const PROVIDER_SESSION = "22222222-2222-4222-8222-222222222222";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const fetchMock = vi.fn(async (_url: string, _init: RequestInit): Promise<Response> =>
  json({ id: RUN_ID, sessionId: PROVIDER_SESSION, status: "queued" }, 202),
);
vi.stubGlobal("fetch", (url: string, init: RequestInit) => fetchMock(url, init));

/** The calls that created a run, which is every call this tool makes to the provider. */
function runCalls() {
  return fetchMock.mock.calls.filter(([url]) => url === `${V4_BASE}/runs`);
}

function sentRun(): Record<string, unknown> {
  const call = runCalls()[0];
  expect(call, "browse never created a run").toBeDefined();
  return JSON.parse(String(call[1].body));
}

/**
 * Each mock is declared with the real signature and forwarded by name, which
 * is the shape `http-request.test.ts` established: a `vi.fn()` with no
 * parameters infers a no-argument procedure, and then every spread into it is
 * a type error and every `mockResolvedValue` is checked against the wrong
 * return type.
 */
const recordBrowserTask = vi.fn(
  async (
    _env: unknown,
    _input: {
      workspaceId: string;
      agentId: string;
      userId: string;
      sessionId: string;
      task: string;
      providerRunId?: string;
      browserSessionId?: string;
    },
  ): Promise<string | null> => "bt-1",
);
vi.mock("../../browser/tasks", () => ({
  recordBrowserTask: (env: unknown, input: Parameters<typeof recordBrowserTask>[1]) =>
    recordBrowserTask(env, input),
}));

/**
 * The browser beside this conversation, mocked for `profileFor`'s reason: the
 * real functions build a service-role client, and `sessions.test.ts` is where
 * their insert-first order is proved. Here the question is only what the tool
 * does with each answer.
 */
type SessionInput = {
  workspaceId: string;
  agentId: string;
  userId: string;
  chatSessionId: string;
  profileId: string | null;
};
const ensureBrowserSession = vi.fn(
  async (_env: unknown, _input: SessionInput): Promise<BrowserResult<BrowserSessionRef>> => ({
    kind: "ok",
    value: {
      id: "bs-1",
      providerSessionId: null,
      liveState: "none",
      runInFlight: false,
      profileId: null,
    },
  }),
);
const recordRunStart = vi.fn(
  async (
    _env: unknown,
    _input: { browserSessionId: string; providerSessionId?: string },
  ): Promise<void> => {},
);
const releaseBrowserSession = vi.fn(async (_env: unknown, _id: string): Promise<void> => {});
vi.mock("../../browser/sessions", () => ({
  ensureBrowserSession: (env: unknown, input: SessionInput) => ensureBrowserSession(env, input),
  recordRunStart: (env: unknown, input: Parameters<typeof recordRunStart>[1]) =>
    recordRunStart(env, input),
  releaseBrowserSession: (env: unknown, id: string) => releaseBrowserSession(env, id),
}));

/**
 * Mocked because the real one builds a service-role client, and the point of
 * these tests is the tool's own decisions rather than Supabase's constructor.
 * Null is the ordinary case — somebody who has never taken over a browser has
 * no cookie jar — and it is also the case that must stay byte-identical to the
 * request this tool made before takeovers existed.
 */
const profileFor = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{
      id: string;
      providerProfileId: string;
      proxyCountryCode: string | null;
    } | null> => null,
  ),
);
/**
 * Ruling R19's provisioning, mocked for `profileFor`'s reason; its claim-first
 * order (one profile however many first runs race) is proved in
 * `takeover.test.ts`. Null by default — the provider would not make one — so
 * every test that is not about provisioning sees the run it always saw.
 */
const runProfile = vi.hoisted(() =>
  vi.fn(
    async (
      _env: unknown,
      _userId: string,
    ): Promise<{
      id: string;
      providerProfileId: string;
      proxyCountryCode: string | null;
    } | null> => null,
  ),
);
vi.mock("../../browser/takeover", () => ({ profileFor, runProfile }));

const affordable = vi.fn(async (_ctx: ToolContext): Promise<ToolResult | null> => null);
const spend = vi.fn(async (_ctx: ToolContext, _tokens: number): Promise<void> => {});
vi.mock("../spend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spend")>();
  return {
    ...actual,
    affordable: (ctx: ToolContext) => affordable(ctx),
    spend: (ctx: ToolContext, tokens: number) => spend(ctx, tokens),
  };
});

const snapshot = vi.fn(async (_userId: string): Promise<QuotaSnapshot> => ({
  used: 0,
  limit: 1_000_000,
  resetsAt: "2026-11-01T00:00:00Z",
}));
vi.mock("../../entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../entitlements")>();
  return { ...actual, entitlementsFor: () => ({ snapshot: (userId: string) => snapshot(userId) }) };
});

import { browseTool, BROWSER_TASK_TOKENS } from "./browse";

/**
 * `ctx.db` is a TRIPWIRE, and it is the guard for the defect of 2026-10-09.
 *
 * `browse` wrote its row through the caller's own client. `0073` gives
 * `browser_tasks` no write grant to any client role, so production answered
 * `42501 permission denied` — after the task had already been created at
 * browser-use, so the money was spent on an answer that could never arrive.
 *
 * The unit tests did not catch it because `ctx.db` was a mock, and a mock has
 * no grants with which to refuse anything. So the mock now refuses on
 * principle: any touch of it from this tool fails the test by name. The write
 * goes through `lib/browser/tasks.ts` and the service role.
 */
/**
 * @param cookieDomains what `browser_profiles` answers with, for the one read
 * this tool is allowed to make through the caller's own client.
 */
function refusingDb(cookieDomains: string[] | null = null): ToolContext["db"] {
  return {
    from(table: string) {
      // The one legitimate read: 0077 grants `authenticated` a select on
      // `cookie_domains` and withholds `provider_profile_id`, so the card's
      // "signed in to…" row comes through the policy that permits it rather
      // than past it.
      if (table === "browser_profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: cookieDomains === null ? null : { cookie_domains: cookieDomains },
                  error: null,
                }),
            }),
          }),
        };
      }
      throw new Error(
        `browse must not reach ${table} through ctx.db — browser_tasks refuses every ` +
          "client write (0073). Use recordBrowserTask.",
      );
    },
  } as unknown as ToolContext["db"];
}

function ctxWith(over: Partial<ToolContext> = {}): ToolContext {
  return {
    db: refusingDb(),
    env: { BROWSER_USE_API_KEY: "bu_test" } as ToolEnv,
    workspaceId: "ws-1",
    agentId: "agent-1",
    userId: "user-1",
    sessionId: "sess-1",
    ...over,
  };
}

beforeEach(() => {
  // Reset to the ordinary case — no jar — so a test that sets one cannot leak
  // it into the next.
  profileFor.mockReset();
  profileFor.mockResolvedValue(null);
  runProfile.mockReset();
  runProfile.mockResolvedValue(null);
  recordBrowserTask.mockReset();
  recordBrowserTask.mockResolvedValue("bt-1");
  ensureBrowserSession.mockReset();
  ensureBrowserSession.mockResolvedValue({
    kind: "ok",
    value: {
      id: "bs-1",
      providerSessionId: null,
      liveState: "none",
      runInFlight: false,
      profileId: null,
    },
  });
  recordRunStart.mockReset();
  recordRunStart.mockResolvedValue(undefined);
  releaseBrowserSession.mockReset();
  releaseBrowserSession.mockResolvedValue(undefined);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    json({ id: RUN_ID, sessionId: PROVIDER_SESSION, status: "queued" }, 202),
  );
  affordable.mockReset();
  affordable.mockResolvedValue(null);
  spend.mockReset();
  snapshot.mockReset();
  snapshot.mockResolvedValue({ used: 0, limit: 1_000_000, resetsAt: "2026-11-01T00:00:00Z" });
});

/** The provider answering `status` to the run's creation. */
function providerAnswers(status: number) {
  fetchMock.mockImplementation(async () => json({ detail: "refused" }, status));
}

/** A follow-up: this conversation's browser already exists at the provider. */
function inAnOpenBrowser() {
  ensureBrowserSession.mockResolvedValue({
    kind: "ok",
    value: {
      id: "bs-1",
      providerSessionId: PROVIDER_SESSION,
      liveState: "none",
      runInFlight: false,
      profileId: null,
    },
  });
}

const TASK = "read the pricing table on example.com and list the tiers";

describe("asking first", () => {
  it("asks for confirmation before it spends anything", async () => {
    const result = await browseTool.run({ task: TASK }, ctxWith());
    expect(result.kind).toBe("needs_confirmation");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
    // Nor a browser row: a proposal somebody declines must leave nothing behind.
    expect(ensureBrowserSession).not.toHaveBeenCalled();
  });

  /**
   * The browser panel is the new place to show what is happening; the card
   * stays the consent screen it was and grows nothing.
   */
  it("shows the task, its cost and the jar on the card, and nothing else", async () => {
    profileFor.mockResolvedValue({
      id: "prof-1",
      providerProfileId: "prov-1",
      proxyCountryCode: null,
    });
    const result = await browseTool.run(
      { task: TASK },
      ctxWith({ db: refusingDb(["portal.example.com"]) }),
    );
    const proposal = (result as { proposal: Record<string, unknown> }).proposal;
    expect(Object.keys(proposal).sort()).toEqual(["cookies", "cost", "kind", "task"]);
  });

  /**
   * §4: the card shows the task sentence verbatim. It is the entire blast
   * radius — no endpoint to inspect, no method to check, no origin to lock —
   * so a truncated or summarised version would be an approval screen lying
   * about what it is approving. `ProposalRows` prints proposal fields
   * untruncated, so putting the whole sentence in the proposal is the whole
   * of the requirement.
   */
  it("puts the task sentence in the proposal verbatim", async () => {
    const long = `${TASK} ${"and also ".repeat(60)}`;
    const result = await browseTool.run({ task: long }, ctxWith());
    const proposal = (result as { proposal: Record<string, unknown> }).proposal;
    expect(proposal.task).toBe(long.trim());
  });

  it("tells the person what the task costs against their allowance", async () => {
    snapshot.mockResolvedValue({
      used: 300_000,
      limit: 1_000_000,
      resetsAt: "2026-11-01T00:00:00Z",
    });
    const result = await browseTool.run({ task: TASK }, ctxWith());
    const proposal = (result as { proposal: Record<string, string> }).proposal;
    // 137,000 of 1,000,000 is ~14%; 700,000 left is 5 more whole tasks.
    expect(proposal.cost).toContain("14%");
    expect(proposal.cost).toContain("5");
  });

  it("says nothing about cost on an unmetered deployment rather than inventing a share", async () => {
    snapshot.mockResolvedValue({ used: 0, limit: null, resetsAt: null });
    const result = await browseTool.run({ task: TASK }, ctxWith());
    const proposal = (result as { proposal: Record<string, unknown> }).proposal;
    expect(proposal.cost).toBeUndefined();
  });

  it("does not let a failed allowance read stop a person being asked", async () => {
    snapshot.mockRejectedValue(new Error("quota backend down"));
    const result = await browseTool.run({ task: TASK }, ctxWith());
    expect(result.kind).toBe("needs_confirmation");
  });
});

describe("once approved", () => {
  const ctx = () => ctxWith({ confirmed: true });

  it("hands the task over as one v4 run and says it started rather than answering", async () => {
    const result = await browseTool.run({ task: TASK }, ctx());
    expect(result.kind).toBe("ok");
    expect(runCalls()).toHaveLength(1);
    expect(sentRun().task).toEqual(expect.stringMatching(new RegExp(`${TASK}$`)));
    // The turn ends here. The content must not read as an answer.
    expect((result as { content: string }).content).toMatch(/started|few minutes/i);
  });

  it("opens a browser for the conversation's first browse, and remembers the session it got", async () => {
    await browseTool.run({ task: TASK }, ctx());

    // No session to continue, so none is named and the provider opens one.
    expect(sentRun()).not.toHaveProperty("sessionId");
    expect(recordRunStart).toHaveBeenCalledTimes(1);
    expect(recordRunStart.mock.calls[0][1]).toEqual({
      browserSessionId: "bs-1",
      providerSessionId: PROVIDER_SESSION,
    });
  });

  it("continues in the conversation's own browser on a follow-up", async () => {
    inAnOpenBrowser();

    await browseTool.run({ task: TASK }, ctx());

    expect(sentRun().sessionId).toBe(PROVIDER_SESSION);
    // The row already names it; the run only takes the controls.
    expect(recordRunStart.mock.calls[0][1]).toEqual({ browserSessionId: "bs-1" });
  });

  it("finds this conversation's browser by the ids the route resolved, never by anything the model said", async () => {
    await browseTool.run({ task: TASK }, ctx());
    expect(ensureBrowserSession.mock.calls[0][1]).toEqual({
      workspaceId: "ws-1",
      agentId: "agent-1",
      userId: "user-1",
      chatSessionId: "sess-1",
      profileId: null,
    });
  });

  /**
   * The structured outcome, asked for both ways (ruling R8): the provider's
   * OpenAPI accepts `outputSchema`, its docs say v4 does not, and the
   * operator's end-to-end run decides which to keep. Until then the schema
   * rides beside the task AND the preamble asks for the same JSON, so neither
   * answer is wasted.
   */
  it("asks for a structured outcome with login_required in it, in the schema and in the words", async () => {
    await browseTool.run({ task: TASK }, ctx());
    const body = sentRun();

    expect(body.outputSchema).toEqual(OUTCOME_SCHEMA);
    const status = (body.outputSchema as { properties: { status: { enum: string[] } } }).properties
      .status;
    expect(status.enum).toEqual(["done", "login_required", "blocked"]);

    const task = String(body.task);
    expect(task).toContain(
      "If a page requires signing in and you have no credential for it, stop and report " +
        "`login_required` with the site's host.",
    );
    // The same constant, so the words and the schema cannot drift apart.
    expect(task).toContain(JSON.stringify(OUTCOME_SCHEMA));
    // The preamble comes first and the person's sentence is untouched after it.
    expect(task.indexOf("login_required")).toBeLessThan(task.indexOf(TASK));
  });

  it("caps what one run may spend, and names the model rather than taking the provider's", async () => {
    await browseTool.run({ task: TASK }, ctx());
    expect(sentRun().maxCostUsd).toBe(RUN_COST_CAP_USD);
    expect(sentRun().model).toBe(DEFAULT_MODEL);
  });

  it("lets BROWSER_USE_MODEL choose the model", async () => {
    const env = { BROWSER_USE_API_KEY: "bu_test", BROWSER_USE_MODEL: "gpt-6-sol" } as ToolEnv;
    await browseTool.run({ task: TASK }, ctxWith({ confirmed: true, env }));
    expect(sentRun().model).toBe("gpt-6-sol");
  });

  /** `docker-compose.yml` hands the container an empty string when the operator set nothing. */
  it("treats an empty BROWSER_USE_MODEL as no override", async () => {
    const env = { BROWSER_USE_API_KEY: "bu_test", BROWSER_USE_MODEL: "" } as ToolEnv;
    await browseTool.run({ task: TASK }, ctxWith({ confirmed: true, env }));
    expect(sentRun().model).toBe(DEFAULT_MODEL);
  });

  it("records the handoff as a v4 run, with the session the answer has to go back to", async () => {
    await browseTool.run({ task: TASK }, ctx());
    expect(recordBrowserTask).toHaveBeenCalledTimes(1);
    expect(recordBrowserTask.mock.calls[0][1]).toEqual({
      workspaceId: "ws-1",
      agentId: "agent-1",
      userId: "user-1",
      sessionId: "sess-1",
      // The person's sentence, not the preamble: this is what the answer is
      // delivered against and what a take-over re-runs.
      task: TASK,
      providerRunId: RUN_ID,
      browserSessionId: "bs-1",
    });
  });

  /**
   * The 2026-10-09 defect, pinned. Writing through the caller's client is a
   * `42501` in production and a silent pass against a mock, so the mock
   * refuses and this says why.
   */
  it("does not write through the caller's own client, which browser_tasks refuses", async () => {
    const result = await browseTool.run({ task: TASK }, ctx());
    expect(result.kind).toBe("ok");
  });

  it("charges the allowance once, after the provider accepted the task", async () => {
    await browseTool.run({ task: TASK }, ctx());
    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledWith(expect.anything(), BROWSER_TASK_TOKENS);
  });

  it("refuses before the network when the allowance is spent", async () => {
    affordable.mockResolvedValue({ kind: "error", message: "no allowance left" });
    const result = await browseTool.run({ task: TASK }, ctx());
    expect(result).toEqual({ kind: "error", message: "no allowance left" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ensureBrowserSession).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  /**
   * The concurrency pool is account-wide and shared across every tenant — ten
   * sessions at $0 lifetime spend. A refused creation cost nothing, so it
   * must charge nothing.
   */
  it("does not charge for a task the concurrency pool refused", async () => {
    providerAnswers(429);
    const result = await browseTool.run({ task: TASK }, ctx());
    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toMatch(/busy|again/i);
    expect(spend).not.toHaveBeenCalled();
    expect(recordBrowserTask).not.toHaveBeenCalled();
  });

  it("does not charge when the provider could not be reached at all", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    await browseTool.run({ task: TASK }, ctx());
    expect(spend).not.toHaveBeenCalled();
  });

  /**
   * A 500 means they took the request. `wasBilled` is the existing rule for
   * which failures are somebody's money and which are not.
   */
  it("charges for a failure the provider is nonetheless responsible for", async () => {
    providerAnswers(500);
    await browseTool.run({ task: TASK }, ctx());
    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledWith(expect.anything(), BROWSER_TASK_TOKENS);
  });

  /**
   * Ruling R12. One v4 session runs one run at a time and answers 409 to a
   * second ("A busy V4 session returns 409"). That is a provider error like
   * any other, metered as every other one is today — `wasBilled` counts a 409
   * as taken — and the model is told why, so it waits for the answer instead
   * of asking again. Not retried, and never a second browser: a second
   * session would be a browser this conversation's row does not name.
   */
  it("fails a follow-up into a busy browser like any provider error, saying a task is still running", async () => {
    inAnOpenBrowser();
    providerAnswers(409);

    const result = await browseTool.run({ task: TASK }, ctx());

    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toMatch(
      /a browser task is still running in this conversation/i,
    );
    expect(runCalls()).toHaveLength(1);
    expect(ensureBrowserSession).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledWith(expect.anything(), BROWSER_TASK_TOKENS);
    expect(recordBrowserTask).not.toHaveBeenCalled();
    expect(recordRunStart).not.toHaveBeenCalled();
    // The row names a live browser; handing it back would orphan it.
    expect(releaseBrowserSession).not.toHaveBeenCalled();
  });

  /**
   * Ruling R13. Two states in which a run must not be created at all, read
   * off this conversation's browser row before the provider is called — and
   * so before the meter, which only ever charges after the provider answered.
   * The R12 409 above stays as the backstop for a race between this read and
   * the run.
   */
  describe("refusals read off the browser before anything is spent", () => {
    function refusedWithNothingSpent() {
      expect(fetchMock).not.toHaveBeenCalled();
      expect(spend).not.toHaveBeenCalled();
      expect(recordBrowserTask).not.toHaveBeenCalled();
      expect(recordRunStart).not.toHaveBeenCalled();
      // The row names a live browser; it is not ours to hand back.
      expect(releaseBrowserSession).not.toHaveBeenCalled();
    }

    it("refuses while the person is driving the browser, and says the agent continues on Done", async () => {
      ensureBrowserSession.mockResolvedValue({
        kind: "ok",
        value: {
          id: "bs-1",
          providerSessionId: PROVIDER_SESSION,
          liveState: "human",
          runInFlight: false,
          profileId: null,
        },
      });

      const result = await browseTool.run({ task: TASK }, ctx());

      expect(result.kind).toBe("error");
      const message = (result as { message: string }).message;
      expect(message).toMatch(/the person is using the browser right now/i);
      expect(message).toMatch(/press Done/);
      refusedWithNothingSpent();
    });

    it("refuses while a run of this browser has not settled, in the 409's words", async () => {
      ensureBrowserSession.mockResolvedValue({
        kind: "ok",
        value: {
          id: "bs-1",
          providerSessionId: PROVIDER_SESSION,
          liveState: "agent",
          runInFlight: true,
          profileId: null,
        },
      });

      const result = await browseTool.run({ task: TASK }, ctx());

      expect(result.kind).toBe("error");
      expect((result as { message: string }).message).toMatch(
        /a browser task is still running in this conversation/i,
      );
      refusedWithNothingSpent();
    });
  });

  /**
   * The same conversation's browser, still being opened by another request —
   * a double-click, or two tabs. Nothing reached the provider, so nothing is
   * charged.
   */
  it("refuses without calling the provider while another request is opening this conversation's browser", async () => {
    ensureBrowserSession.mockResolvedValue({
      kind: "error",
      status: 409,
      message: "being opened",
    });

    const result = await browseTool.run({ task: TASK }, ctx());

    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toMatch(
      /a browser task is still running in this conversation/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  it("refuses without calling the provider when the browser row cannot be written", async () => {
    ensureBrowserSession.mockResolvedValue({ kind: "error", status: 500, message: "db down" });

    const result = await browseTool.run({ task: TASK }, ctx());

    expect(result.kind).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  it("hands back its claim when the first run could not start, so the next browse is not told to wait", async () => {
    providerAnswers(429);
    await browseTool.run({ task: TASK }, ctx());
    expect(releaseBrowserSession).toHaveBeenCalledWith(expect.anything(), "bs-1");
  });

  it("does not charge when the handoff could not be recorded, because nothing will ever poll it", async () => {
    recordBrowserTask.mockResolvedValue(null);
    const result = await browseTool.run({ task: TASK }, ctx());
    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toMatch(/could not be recorded/i);
    expect(spend).not.toHaveBeenCalled();
  });
});

describe("arguments", () => {
  it("requires a task", async () => {
    const result = await browseTool.run({}, ctxWith({ confirmed: true }));
    expect(result).toEqual({ kind: "error", message: "task is required" });
  });

  it("refuses a task too short to be a task", async () => {
    const result = await browseTool.run({ task: "hi" }, ctxWith({ confirmed: true }));
    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toContain("one sentence");
  });

  it("cannot be run by a scheduled turn, because there is nobody to deliver to", async () => {
    const result = await browseTool.run(
      { task: TASK },
      ctxWith({ confirmed: true, sessionId: undefined, routineRunId: "run-1" }),
    );
    expect(result.kind).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ensureBrowserSession).not.toHaveBeenCalled();
  });
});

describe("availability", () => {
  it("is not offered on a deployment with no browser-use key", () => {
    expect(browseTool.isConfigured({} as ToolEnv)).toBe(false);
    expect(browseTool.isConfigured({ BROWSER_USE_API_KEY: "bu_x" } as ToolEnv)).toBe(true);
  });

  it("tells the model the browser opens beside the conversation and the person can take over", () => {
    expect(browseTool.description).toMatch(/beside the conversation/i);
    expect(browseTool.description).toMatch(/take over at any time/i);
  });

  it("needs nothing from the workspace, because it points at the public web", () => {
    expect(browseTool.needs).toBeUndefined();
  });

  it("is destructive, because it acts in the world under instruction", () => {
    expect(browseTool.destructive).toBe(true);
  });
});

/**
 * The with-a-jar path, which shipped with no coverage at all.
 *
 * `profileFor` was mocked to answer null always, so neither the forwarding of
 * the profile to the provider nor the cookie row on the approval card was ever
 * exercised — and that row is the consent affordance for the biggest risk
 * this feature adds. Somebody approving "check the FT front page" needs to see
 * that the browser is signed in to their mail.
 */
describe("a person who has taken over a browser before", () => {
  const JAR = { id: "prof-1", providerProfileId: "prov-1", proxyCountryCode: "de" };

  it("tells them which sites the browser is signed in to, before they approve", async () => {
    profileFor.mockResolvedValue(JAR);
    const ctx = ctxWith({ db: refusingDb(["mail.google.com", "portal.example.com"]) });

    const result = await browseTool.run({ task: "read my invoices on the portal" }, ctx);

    expect(result.kind).toBe("needs_confirmation");
    const proposal = (result as { proposal: Record<string, unknown> }).proposal;
    // `ProposalRows` iterates Object.entries and skips only `kind`, so this
    // renders with no frontend change — the same free ride `cost` takes.
    expect(String(proposal.cookies)).toContain("mail.google.com");
    expect(String(proposal.cookies)).toContain("portal.example.com");
  });

  it("says nothing about sign-ins when the jar is empty", async () => {
    profileFor.mockResolvedValue(JAR);
    const ctx = ctxWith({ db: refusingDb([]) });

    const result = await browseTool.run({ task: "read a public page please" }, ctx);

    // An empty jar is a row, not a fact worth a line on the card.
    expect((result as { proposal: Record<string, unknown> }).proposal.cookies).toBeUndefined();
  });

  it("attaches the jar and its pinned egress to the provider request", async () => {
    profileFor.mockResolvedValue(JAR);
    const ctx = ctxWith({ confirmed: true, db: refusingDb(["mail.google.com"]) });

    await browseTool.run({ task: "read my invoices on the portal" }, ctx);

    const body = sentRun();
    expect(body.browserSettings).toEqual({ profileId: "prov-1", proxyCountryCode: "de" });
    // Permanent, and the reason the jar can be a credential at all: Covan
    // never receives one, so it has none to send.
    expect(body).not.toHaveProperty("secretBindings");
    expect(body).not.toHaveProperty("secrets");
    expect(body).not.toHaveProperty("opVaultId");
    // And the session row remembers which jar it was opened with.
    expect(ensureBrowserSession.mock.calls[0][1].profileId).toBe("prof-1");
  });

  it("omits the country for a jar pinned to none, so the provider's default egress applies", async () => {
    profileFor.mockResolvedValue({ ...JAR, proxyCountryCode: null });

    await browseTool.run({ task: "read my invoices on the portal" }, ctxWith({ confirmed: true }));

    // An explicit `proxyCountryCode: null` is the provider's "no proxy"; a
    // person who had no jar used to get the default (US) proxy, and a jar made
    // by R19 pins no country, so the key must be absent rather than null.
    const settings = sentRun().browserSettings as Record<string, unknown>;
    expect(settings).toEqual({ profileId: "prov-1" });
    expect("proxyCountryCode" in settings).toBe(false);
  });

  /**
   * The provider's contract on `profileId`: an explicit value mismatching the
   * live browser's profile declines reuse and provisions a fresh browser, and a
   * different profile on a session is a 400 (charged). So a follow-up names the
   * jar only when it is the one the session was opened with.
   */
  describe("a follow-up in a conversation's existing browser", () => {
    const follow = (profileId: string | null) =>
      ensureBrowserSession.mockResolvedValue({
        kind: "ok",
        value: {
          id: "bs-1",
          providerSessionId: PROVIDER_SESSION,
          liveState: "none",
          runInFlight: false,
          profileId,
        },
      });

    it("sends the jar when the browser was opened with it", async () => {
      profileFor.mockResolvedValue(JAR);
      follow("prof-1");

      await browseTool.run({ task: TASK }, ctxWith({ confirmed: true }));

      const body = sentRun();
      expect(body.sessionId).toBe(PROVIDER_SESSION);
      expect(body.browserSettings).toEqual({ profileId: "prov-1", proxyCountryCode: "de" });
    });

    it("sends no jar when the browser was opened without one, so it is reused rather than replaced", async () => {
      profileFor.mockResolvedValue(JAR);
      follow(null);

      const result = await browseTool.run({ task: TASK }, ctxWith({ confirmed: true }));

      expect(result.kind).toBe("ok");
      const body = sentRun();
      expect(body.sessionId).toBe(PROVIDER_SESSION);
      expect(body).not.toHaveProperty("browserSettings");
      // And the row is not told it carries a jar its browser never had.
      expect(recordRunStart.mock.calls[0][1]).not.toHaveProperty("profileId");
    });

    it("sends no jar when the browser was opened with a different one", async () => {
      profileFor.mockResolvedValue(JAR);
      follow("prof-other");

      await browseTool.run({ task: TASK }, ctxWith({ confirmed: true }));

      expect(sentRun()).not.toHaveProperty("browserSettings");
    });

    it("sends no jar to a browser opened without one, even when this run just provisioned one", async () => {
      runProfile.mockResolvedValue({
        id: "prof-new",
        providerProfileId: "prov-new",
        proxyCountryCode: null,
      });
      follow(null);

      await browseTool.run({ task: TASK }, ctxWith({ confirmed: true }));

      expect(sentRun()).not.toHaveProperty("browserSettings");
    });
  });

  it("sends the jar on the run that opens the browser", async () => {
    profileFor.mockResolvedValue(JAR);

    await browseTool.run({ task: TASK }, ctxWith({ confirmed: true }));

    expect(sentRun()).not.toHaveProperty("sessionId");
    expect(sentRun().browserSettings).toEqual({ profileId: "prov-1", proxyCountryCode: "de" });
  });

  it("sends no browser settings at all when there is no jar", async () => {
    await browseTool.run({ task: TASK }, ctxWith({ confirmed: true }));
    expect(sentRun()).not.toHaveProperty("browserSettings");
  });

  it("does not provision a jar the person already has", async () => {
    profileFor.mockResolvedValue(JAR);

    await browseTool.run({ task: TASK }, ctxWith({ confirmed: true }));

    expect(runProfile).not.toHaveBeenCalled();
    expect(recordRunStart.mock.calls[0][1]).toMatchObject({ profileId: "prof-1" });
  });
});

/**
 * Ruling R19: a sign-in the person performs in the panel is saved into their
 * profile when the browser stops — so a browser opened with no profile had
 * nowhere to save it, and "your sign-ins are saved" was untrue for everybody
 * who had never used the old takeover. The first `browse` provisions the jar.
 */
describe("a person with no jar yet", () => {
  const NEW_JAR = { id: "prof-new", providerProfileId: "prov-new", proxyCountryCode: null };
  const ctx = () => ctxWith({ confirmed: true });

  it("is given one on their first browse, after the refusals and before the run, which carries it", async () => {
    const order: string[] = [];
    ensureBrowserSession.mockImplementation(async () => {
      order.push("session");
      return {
        kind: "ok",
        value: {
          id: "bs-1",
          providerSessionId: null,
          liveState: "none",
          runInFlight: false,
          profileId: null,
        },
      };
    });
    runProfile.mockImplementation(async () => {
      order.push("provision");
      return NEW_JAR;
    });
    fetchMock.mockImplementation(async () => {
      order.push("run");
      return json({ id: RUN_ID, sessionId: PROVIDER_SESSION, status: "queued" }, 202);
    });

    const result = await browseTool.run({ task: TASK }, ctx());

    expect(result.kind).toBe("ok");
    expect(order).toEqual(["session", "provision", "run"]);
    expect(runProfile).toHaveBeenCalledWith(expect.anything(), "user-1");
    expect(sentRun().browserSettings).toEqual({ profileId: "prov-new" });
    // The claim named no jar, because there was none yet; the run's start is
    // where the row learns it, so the sweep can refresh it after a stop.
    expect(recordRunStart.mock.calls[0][1]).toEqual({
      browserSessionId: "bs-1",
      providerSessionId: PROVIDER_SESSION,
      profileId: "prof-new",
    });
  });

  it("still runs, with no jar, when one cannot be provisioned", async () => {
    runProfile.mockResolvedValue(null);

    const result = await browseTool.run({ task: TASK }, ctx());

    expect(result.kind).toBe("ok");
    expect(runProfile).toHaveBeenCalledTimes(1);
    expect(sentRun()).not.toHaveProperty("browserSettings");
    expect(spend).toHaveBeenCalledTimes(1);
  });

  it("is not given one by a proposal nobody has approved yet", async () => {
    await browseTool.run({ task: TASK }, ctxWith());
    expect(runProfile).not.toHaveBeenCalled();
  });

  it.each([
    [
      "the allowance is spent",
      () => affordable.mockResolvedValue({ kind: "error", message: "no" }),
    ],
    [
      "the person is driving",
      () =>
        ensureBrowserSession.mockResolvedValue({
          kind: "ok",
          value: {
            id: "bs-1",
            providerSessionId: PROVIDER_SESSION,
            liveState: "human",
            runInFlight: false,
            profileId: null,
          },
        }),
    ],
    [
      "a run has not settled",
      () =>
        ensureBrowserSession.mockResolvedValue({
          kind: "ok",
          value: {
            id: "bs-1",
            providerSessionId: PROVIDER_SESSION,
            liveState: "agent",
            runInFlight: true,
            profileId: null,
          },
        }),
    ],
    [
      "the browser is being opened by another request",
      () => ensureBrowserSession.mockResolvedValue({ kind: "error", status: 409, message: "busy" }),
    ],
  ])("is not given one when browse refuses because %s", async (_label, arrange) => {
    arrange();

    const result = await browseTool.run({ task: TASK }, ctx());

    expect(result.kind).toBe("error");
    expect(runProfile).not.toHaveBeenCalled();
  });
});

/**
 * The row must not claim a sign-in it cannot know about.
 *
 * The first real run returned seven domains for ONE hand-performed LinkedIn
 * login: `linkedin.com`, `linkedin-ei.com`, and then `facebook.com`,
 * `google.com`, `demdex.net`, `33across.com`, `protechts.net` — ad-tech
 * cookies the page dropped while loading. The card said "this browser is
 * signed in to facebook.com, protechts.net, google.com, 33across.com and 3
 * more", which was false, alarming, and truncated away the only domain the
 * person had actually signed into.
 */

/**
 * The row must not claim a sign-in it cannot know about.
 *
 * The first real run returned SEVEN domains for ONE hand-performed LinkedIn
 * login: `linkedin.com`, `linkedin-ei.com`, and then `facebook.com`,
 * `google.com`, `demdex.net`, `33across.com`, `protechts.net` — ad-tech
 * cookies the page dropped while loading. The card said *"this browser is
 * signed in to facebook.com, protechts.net, google.com, 33across.com and 3
 * more"*: false, alarming in a way the truth is not, and truncated away the
 * one domain the person had actually signed into.
 */
describe("what the approval card claims about the jar", () => {
  const JAR = { id: "prof-1", providerProfileId: "prov-1", proxyCountryCode: "de" };

  it("never says signed in, because it cannot know which of them is one", async () => {
    profileFor.mockResolvedValue(JAR);
    const ctx = ctxWith({
      db: refusingDb([
        "linkedin.com",
        "linkedin-ei.com",
        "facebook.com",
        "google.com",
        "demdex.net",
        "33across.com",
        "protechts.net",
      ]),
    });

    const result = await browseTool.run({ task: "read my linkedin notifications" }, ctx);
    const row = String((result as { proposal: Record<string, unknown> }).proposal.cookies ?? "");

    expect(row).not.toMatch(/signed in/i);
    // The count leads, so the truncation can no longer hide the one that matters.
    expect(row).toMatch(/^7 sites/);
  });

  it("names them all when there are few enough to name", async () => {
    profileFor.mockResolvedValue(JAR);
    const ctx = ctxWith({ db: refusingDb(["portal.example.com"]) });

    const result = await browseTool.run({ task: "read my invoices on the portal" }, ctx);
    const row = String((result as { proposal: Record<string, unknown> }).proposal.cookies ?? "");

    expect(row).toBe("1 site: portal.example.com");
  });
});
