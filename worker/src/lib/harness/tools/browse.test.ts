import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";
import type { BrowserResult } from "../../browser/client";
import type { BrowserSessionRef } from "../../browser/sessions";
import type { CreditSnapshot } from "../../entitlements";
import { DEFAULT_MODEL, DEFAULT_REASONING, V4_BASE } from "../../browser/v4";
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
      credentialId?: string | null;
      thenStep?: string;
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
    _input: {
      browserSessionId: string;
      providerSessionId?: string;
      profileId?: string | null;
      providerBrowserId?: null;
    },
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
 * The browser's line (0080), mocked for `profileFor`'s reason: the real
 * functions build a service-role client, and `queue.test.ts` is where the
 * line itself is proved. Empty unless a test says otherwise.
 */
const waitingInLine = vi.fn(async (_env: unknown, _id: string): Promise<number | null> => 0);
const queueBrowserTask = vi.fn(
  async (_env: unknown, _input: Record<string, unknown>): Promise<string | null> => "bt-waiting",
);
vi.mock("../../browser/queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../browser/queue")>();
  return {
    ...actual,
    waitingInLine: (env: unknown, id: string) => waitingInLine(env, id),
    queueBrowserTask: (env: unknown, input: Record<string, unknown>) =>
      queueBrowserTask(env, input),
  };
});

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
/**
 * Ruling R44: whether the person has a browser of their own open (Task 3.1),
 * mocked for `profileFor`'s reason; what counts as open is proved in
 * `takeover.test.ts`. False by default — almost nobody has one open.
 */
const heldTakeover = vi.hoisted(() =>
  vi.fn(async (_env: unknown, _userId: string): Promise<boolean | null> => false),
);
vi.mock("../../browser/takeover", () => ({ profileFor, runProfile, heldTakeover }));

const affordable = vi.fn(async (_ctx: ToolContext): Promise<ToolResult | null> => null);
const spend = vi.fn(
  async (_ctx: ToolContext, _spent: unknown, _ref?: unknown): Promise<void> => {},
);
vi.mock("../spend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../spend")>();
  return {
    ...actual,
    affordable: (ctx: ToolContext) => affordable(ctx),
    spend: (...args: [ToolContext, unknown, unknown?]) => spend(...args),
  };
});

const snapshot = vi.fn(async (_workspaceId: string): Promise<CreditSnapshot> => ({
  metered: false,
}));
vi.mock("../../entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../entitlements")>();
  return {
    ...actual,
    entitlementsFor: () => ({ snapshot: (workspaceId: string) => snapshot(workspaceId) }),
  };
});

/**
 * The saved logins (Task 2.3), mocked for `profileFor`'s reason: the real
 * functions build a service-role client, and `credentials.test.ts` is where
 * which row is picked, and how it is decrypted, is proved. Everything else in
 * the module stays real — `siteHostOf` normalises the `site` argument and
 * `credentialAliases` names the aliases, and a test that faked either would be
 * checking the fake. Null by default: nobody has saved a login, and every
 * test that is not about one sees the run it always saw.
 */
type LoginArgs = { agentId: string; userId: string; host: string };
const credentialsFor = vi.hoisted(() =>
  vi.fn(
    async (
      _env: unknown,
      _args: { agentId: string; userId: string; host: string },
    ): Promise<import("../../browser/credentials").CredentialBinding | null> => null,
  ),
);
const savedLogin = vi.hoisted(() =>
  vi.fn(
    async (
      _env: unknown,
      _args: { agentId: string; userId: string; host: string },
    ): Promise<import("../../browser/credentials").SavedLogin | null> => null,
  ),
);
vi.mock("../../browser/credentials", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../browser/credentials")>();
  return {
    ...actual,
    credentialsFor: (env: unknown, args: LoginArgs) => credentialsFor(env, args),
    savedLogin: (env: unknown, args: LoginArgs) => savedLogin(env, args),
  };
});

import { credentialAliases, type CredentialBinding } from "../../browser/credentials";
import { browseTool, MAX_THEN_CHARS } from "./browse";
import { QUEUE_MAX } from "../../browser/queue";

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
  heldTakeover.mockReset();
  heldTakeover.mockResolvedValue(false);
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
  waitingInLine.mockReset();
  waitingInLine.mockResolvedValue(0);
  queueBrowserTask.mockReset();
  queueBrowserTask.mockResolvedValue("bt-waiting");
  fetchMock.mockReset();
  fetchMock.mockImplementation(async () =>
    json({ id: RUN_ID, sessionId: PROVIDER_SESSION, status: "queued" }, 202),
  );
  affordable.mockReset();
  affordable.mockResolvedValue(null);
  spend.mockReset();
  snapshot.mockReset();
  snapshot.mockResolvedValue({
    metered: true,
    balance: 412.5,
    granted: 500,
    spent: 87.5,
    unlimited: false,
    replies: 20,
  });
  credentialsFor.mockReset();
  credentialsFor.mockResolvedValue(null);
  savedLogin.mockReset();
  savedLogin.mockResolvedValue(null);
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

  it("tells the person the workspace's credit balance, and no per-task price", async () => {
    const result = await browseTool.run({ task: TASK }, ctxWith());
    const proposal = (result as { proposal: Record<string, string> }).proposal;
    expect(proposal.cost).toBe("uses credits; this workspace has 412 credits left");
  });

  it("says nothing about credits on a house workspace", async () => {
    snapshot.mockResolvedValue({
      metered: true,
      balance: 0,
      granted: 0,
      spent: 0,
      unlimited: true,
      replies: 0,
    });
    const result = await browseTool.run({ task: TASK }, ctxWith());
    const proposal = (result as { proposal: Record<string, unknown> }).proposal;
    expect(proposal.cost).toBeUndefined();
  });

  it("says nothing about credits on an unmetered deployment rather than inventing one", async () => {
    snapshot.mockResolvedValue({ metered: false });
    const result = await browseTool.run({ task: TASK }, ctxWith());
    const proposal = (result as { proposal: Record<string, unknown> }).proposal;
    expect(proposal.cost).toBeUndefined();
  });

  it("does not let a failed balance read stop a person being asked", async () => {
    snapshot.mockRejectedValue(new Error("ledger down"));
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
    expect(status.enum).toEqual(["done", "login_required", "partial", "blocked"]);

    const task = String(body.task);
    expect(task).toContain(
      "If a page requires signing in and you have no credential for it, stop and report " +
        "`login_required` with the site's host.",
    );
    // A run that did some of it says so, and "blocked" is kept for the site's refusal.
    expect(task).toContain("`partial` when you did only some of it");
    expect(task).toContain("`blocked` only when the site itself refused you");
    expect(task).toContain("do them one at a time and see each one go through");
    // The same constant, so the words and the schema cannot drift apart.
    expect(task).toContain(JSON.stringify(OUTCOME_SCHEMA));
    // The preamble comes first and the person's sentence is untouched after it.
    expect(task.indexOf("login_required")).toBeLessThan(task.indexOf(TASK));
  });

  it("puts no ceiling on a paid run, and names the model rather than taking the provider's", async () => {
    await browseTool.run({ task: TASK }, ctx());
    // A run at a ceiling ends with no answer; a paid run is charged what it cost instead.
    expect("maxCostUsd" in sentRun()).toBe(false);
    expect(String(sentRun().task)).not.toContain("Your budget is small");
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

  /** Left out, the provider reasons at `xhigh` on every step of `gpt-5.6-luna`. */
  it("names the reasoning level rather than taking the provider's", async () => {
    await browseTool.run({ task: TASK }, ctx());
    expect(sentRun().modelParams).toEqual({ reasoning: { effort: DEFAULT_REASONING } });
  });

  it("lets BROWSER_USE_REASONING choose the level, in the model family's shape", async () => {
    const env = {
      BROWSER_USE_API_KEY: "bu_test",
      BROWSER_USE_MODEL: "claude-sonnet-5",
      BROWSER_USE_REASONING: "low",
    } as ToolEnv;
    await browseTool.run({ task: TASK }, ctxWith({ confirmed: true, env }));
    expect(sentRun().modelParams).toEqual({ output_config: { effort: "low" } });
  });

  it("sends no modelParams when BROWSER_USE_REASONING is `provider`", async () => {
    const env = { BROWSER_USE_API_KEY: "bu_test", BROWSER_USE_REASONING: "provider" } as ToolEnv;
    await browseTool.run({ task: TASK }, ctxWith({ confirmed: true, env }));
    expect("modelParams" in sentRun()).toBe(false);
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

  it("records the step after the browser when the agent named one (0117)", async () => {
    await browseTool.run({ task: TASK, then: "  write the leads to a page in Qrucial  " }, ctx());
    expect(recordBrowserTask.mock.calls[0][1].thenStep).toBe(
      "write the leads to a page in Qrucial",
    );
  });

  it.each(["", "   ", "none", "N/A", "-"])("records no step for a `then` of %j", async (then) => {
    await browseTool.run({ task: TASK, then }, ctx());
    expect("thenStep" in recordBrowserTask.mock.calls[0][1]).toBe(false);
  });

  it("clips a step that runs past its bound rather than refusing the task", async () => {
    await browseTool.run({ task: TASK, then: "x".repeat(MAX_THEN_CHARS + 50) }, ctx());
    expect(recordBrowserTask.mock.calls[0][1].thenStep).toHaveLength(MAX_THEN_CHARS);
  });

  it("tells the agent the conversation carries on with `then` by itself", () => {
    expect(browseTool.description).toMatch(/put that next step in `then`/);
    const props = (browseTool.input as { properties: Record<string, unknown> }).properties;
    expect(props).toHaveProperty("then");
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

  it("holds credits once, after the provider accepted the task, against the recorded row", async () => {
    await browseTool.run({ task: TASK }, ctx());
    expect(spend).toHaveBeenCalledTimes(1);
    expect(spend).toHaveBeenCalledWith(
      expect.anything(),
      [
        {
          kind: "browser_task",
          stage: "started",
          browserTaskId: expect.any(String),
          costUsd: null,
        },
      ],
      { browserTaskId: expect.any(String) },
    );
  });

  it("refuses before the network when the credits are spent", async () => {
    affordable.mockResolvedValue({ kind: "error", message: "no credits left" });
    const result = await browseTool.run({ task: TASK }, ctx());
    expect(result).toEqual({ kind: "error", message: "no credits left" });
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
    expect(spend).toHaveBeenCalledWith(expect.anything(), [
      { kind: "browser_task", stage: "started", browserTaskId: null, costUsd: null },
    ]);
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
    expect(spend).toHaveBeenCalledWith(expect.anything(), [
      { kind: "browser_task", stage: "started", browserTaskId: null, costUsd: null },
    ]);
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

    /**
     * 0080: a browser mid-run takes the task at the end of its line instead of
     * refusing it. On 2026-10-11 the refusal is what left an agent saying three
     * tasks were running when one was. Nothing is spent until it starts.
     */
    describe("the line, while the browser is busy", () => {
      function busy(waiting = 0) {
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
        waitingInLine.mockResolvedValue(waiting);
      }

      it("queues the task behind a run that has not settled, and says where it is in line", async () => {
        busy();

        const result = await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

        expect(result.kind).toBe("ok");
        const content = (result as { content: string }).content;
        expect(content).toMatch(/^Queued: .*number 1 in line/);
        expect(content).toMatch(/Do not call browse again/);
        expect(queueBrowserTask).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            task: TASK,
            site: "linkedin.com",
            browserSessionId: "bs-1",
            sessionId: "sess-1",
          }),
        );
        refusedWithNothingSpent();
      });

      it("puts the step after the browser on a task that waits its turn", async () => {
        busy();
        await browseTool.run({ task: TASK, then: "write them to Qrucial" }, ctx());
        expect(queueBrowserTask.mock.calls[0][1]).toMatchObject({
          thenStep: "write them to Qrucial",
        });
      });

      // A task approved as a line on another task's card was shown as a
      // sentence and nothing else, so it must not pick up a saved login from
      // a host its text names.
      it("gives a task approved as a listed line no saved login its card never named", async () => {
        busy();
        savedLogin.mockResolvedValue({
          id: "cred-1",
          label: "Example — shared",
          scope: "agent",
          siteHost: "example.com",
        });

        await browseTool.run({ task: TASK }, { ...ctx(), confirmedAsListed: true });

        expect(queueBrowserTask).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ task: TASK, site: null }),
        );
        expect(savedLogin).not.toHaveBeenCalled();
      });

      it("queues behind tasks already waiting even when nothing runs, so the order holds", async () => {
        busy(2);
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

        const result = await browseTool.run({ task: TASK }, ctx());

        expect((result as { content: string }).content).toMatch(/number 3 in line/);
        refusedWithNothingSpent();
      });

      it("refuses when the line is full, and queues nothing", async () => {
        busy(QUEUE_MAX);

        const result = await browseTool.run({ task: TASK }, ctx());

        expect(result.kind).toBe("error");
        expect((result as { message: string }).message).toMatch(/already waiting/);
        expect(queueBrowserTask).not.toHaveBeenCalled();
        refusedWithNothingSpent();
      });

      it("says so, and starts nothing, when the line cannot be read or written", async () => {
        busy();
        waitingInLine.mockResolvedValueOnce(null);
        expect((await browseTool.run({ task: TASK }, ctx())).kind).toBe("error");
        queueBrowserTask.mockResolvedValueOnce(null);
        expect((await browseTool.run({ task: TASK }, ctx())).kind).toBe("error");
        refusedWithNothingSpent();
      });
    });

    /**
     * Ruling R44: the person has a browser of their own open, on the same
     * jar, to sign in ahead of time. A run now would put the jar in two live
     * browsers, and whichever stops last writes it — so the sign-in they are
     * making could be overwritten. Refused before the browser row is even
     * claimed, so there is nothing to hand back either.
     */
    it("refuses while the person has a browser of their own open, and says to press Done there first", async () => {
      heldTakeover.mockResolvedValue(true);

      const result = await browseTool.run({ task: TASK }, ctx());

      expect(result.kind).toBe("error");
      const message = (result as { message: string }).message;
      expect(message).toMatch(/press Done in the browser they opened/);
      expect(message).toMatch(/do not retry this turn/);
      expect(heldTakeover.mock.calls[0][1]).toBe("user-1");
      expect(ensureBrowserSession).not.toHaveBeenCalled();
      refusedWithNothingSpent();
    });

    it("refuses, spending nothing, when it cannot tell whether one is open", async () => {
      heldTakeover.mockResolvedValue(null);

      const result = await browseTool.run({ task: TASK }, ctx());

      expect(result.kind).toBe("error");
      expect(ensureBrowserSession).not.toHaveBeenCalled();
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

describe("several tasks on one card", () => {
  const together = browseTool.approvedTogether!;

  it("holds as many as the line does", () => {
    expect(together.max).toBe(QUEUE_MAX);
  });

  it("lists a task as one line, and leaves off what its own card has to name", () => {
    expect(together.line({ task: "  look at\n covan.app  and its pricing " })).toBe(
      "look at covan.app and its pricing",
    );
    expect(together.line({ task: "hi" })).toBeNull();
    expect(together.line({})).toBeNull();
    // A saved login is named on the card that uses it.
    expect(together.line({ task: TASK, site: "linkedin.com" })).toBeNull();
  });

  it("numbers the rest under the first, and reads them back", () => {
    const card = together.card(
      {
        summary: "Use a browser to do this?",
        proposal: {
          kind: "browse",
          task: "the repo on github",
          cost: "uses credits; this workspace has 40 credits left",
        },
      },
      ["look at covan.app", "look at tasklet.ai"],
    );
    expect(card.summary).toBe("Use a browser to do these 3 things?");
    expect(card.proposal).toEqual({
      kind: "browse",
      task: "the repo on github",
      thenInLine: "2. look at covan.app\n3. look at tasklet.ai",
      cost: "uses credits; this workspace has 40 credits left",
    });
    expect(together.listed(card.proposal)).toEqual(["look at covan.app", "look at tasklet.ai"]);
  });

  it("reads nothing back from a card that listed nothing", () => {
    expect(together.listed({ kind: "browse", task: TASK })).toEqual([]);
    expect(together.listed(null)).toEqual([]);
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

  it("tells the model what `site` is for, and no longer that the browser can never sign in", () => {
    const site = (browseTool.input as { properties: Record<string, { description?: string }> })
      .properties.site;
    expect(site).toBeDefined();
    expect(site.description).toMatch(/saved login/i);
    expect(browseTool.description).toMatch(/`site`/);
    expect(browseTool.description).toMatch(/never shown a password/i);
    expect(browseTool.description).not.toMatch(/can never be given a password/i);
    // Optional: a task with no sign-in in it names none.
    expect((browseTool.input as { required: string[] }).required).toEqual(["task"]);
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
    // No country on this context, so none to pin: the provider's default.
    expect(runProfile).toHaveBeenCalledWith(expect.anything(), "user-1", {}, null);
    expect(sentRun().browserSettings).toEqual({ profileId: "prov-new" });
    // The claim named no jar, because there was none yet; the run's start is
    // where the row learns it, so the sweep can refresh it after a stop.
    expect(recordRunStart.mock.calls[0][1]).toEqual({
      browserSessionId: "bs-1",
      providerSessionId: PROVIDER_SESSION,
      profileId: "prof-new",
    });
  });

  it("pins the new jar to the country the approving request came from", async () => {
    runProfile.mockResolvedValue(null);

    await browseTool.run({ task: TASK }, ctxWith({ confirmed: true, egressCountry: "tr" }));

    expect(runProfile).toHaveBeenCalledWith(expect.anything(), "user-1", {}, "tr");
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
      // Queued behind it (0080), not refused — and no jar until it starts.
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
  ])("is not given one when browse starts no run because %s", async (_label, arrange) => {
    arrange();

    await browseTool.run({ task: TASK }, ctx());

    expect(fetchMock).not.toHaveBeenCalled();
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

/**
 * Task 2.3: the login you save, carried by the run that needs it.
 *
 * The model names a site; the server finds the login saved for it and hands
 * it to the provider as two `SecretBinding`s. The model sees two alias names
 * and nothing else, and so does every place the run's words end up — the tool
 * result, `message_steps.result_excerpt`, `browser_tasks`, a log line.
 */
describe("a saved login (Task 2.3)", () => {
  // Distinctive enough that a substring search cannot match anything else.
  const USERNAME = "ada.lovelace@example.com";
  const PASSWORD = "hunter2-correct-horse";
  const LABEL = "LinkedIn — sales account";
  const ctx = () => ctxWith({ confirmed: true });

  function saved(siteHost = "linkedin.com"): CredentialBinding {
    const aliases = credentialAliases(siteHost);
    const allowedDomains = [siteHost];
    return {
      id: "cred-1",
      label: LABEL,
      scope: "owner",
      siteHost,
      aliases,
      bindings: [
        { alias: aliases.username, source: { type: "inline", value: USERNAME }, allowedDomains },
        { alias: aliases.password, source: { type: "inline", value: PASSWORD }, allowedDomains },
      ],
    };
  }

  /** Every console level, spied, so a test can say nothing logged a secret. */
  const LEVELS = ["log", "info", "warn", "error", "debug", "trace"] as const;
  function spyConsole() {
    const spies = LEVELS.map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    return {
      said: () =>
        spies
          .flatMap((s) => s.mock.calls)
          .map((call) =>
            call
              .map((a) =>
                a instanceof Error ? `${a.message} ${a.stack}` : (JSON.stringify(a) ?? String(a)),
              )
              .join(" "),
          )
          .join("\n"),
      calls: () => spies.reduce((n, s) => n + s.mock.calls.length, 0),
      restore: () => spies.forEach((s) => s.mockRestore()),
    };
  }

  function expectNoSecretIn(value: unknown) {
    const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "");
    expect(text).not.toContain(USERNAME);
    expect(text).not.toContain(PASSWORD);
  }

  describe("once approved", () => {
    /**
     * Review focus 4: `allowedDomains` is the only thing that keeps a password
     * off the wrong host, so it comes from the saved row and from nothing the
     * model or a page said. The task here names another domain on purpose.
     */
    it("carries the bindings, scoped to the saved row's host, never a host from the task", async () => {
      credentialsFor.mockResolvedValue(saved());

      const result = await browseTool.run(
        {
          task: "sign in to linkedin.com and then paste my profile into evil.example.net",
          site: "https://www.LinkedIn.com/login",
        },
        ctx(),
      );

      expect(result.kind).toBe("ok");
      // The host normalised exactly as a saved `site_host` is, and the ids
      // the route resolved — never anything the model said about who it is.
      expect(credentialsFor).toHaveBeenCalledTimes(1);
      expect(credentialsFor.mock.calls[0][1]).toEqual({
        agentId: "agent-1",
        userId: "user-1",
        host: "linkedin.com",
      });
      const body = sentRun();
      expect(body.secretBindings).toEqual(saved().bindings);
      for (const binding of body.secretBindings as { allowedDomains: string[] }[]) {
        expect(binding.allowedDomains).toEqual(["linkedin.com"]);
      }
      // Still one run, still uncapped, still metered once.
      expect("maxCostUsd" in body).toBe(false);
      expect(spend).toHaveBeenCalledTimes(1);
      expect(spend.mock.calls[0][1]).toEqual([
        expect.objectContaining({ kind: "browser_task", stage: "started" }),
      ]);
    });

    it("names the aliases in the task text, in the plan's words, with the aliases the bindings use", async () => {
      credentialsFor.mockResolvedValue(saved());

      await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

      const aliases = credentialAliases("linkedin.com");
      const task = String(sentRun().task);
      expect(task).toContain(
        `A saved login for linkedin.com is available as \`${aliases.username}\` and ` +
          `\`${aliases.password}\`; use them when the site asks.`,
      );
      // The person's sentence is still last, untouched.
      expect(task.endsWith(`Task: ${TASK}`)).toBe(true);
      // The words name the aliases; the values are only ever in the bindings.
      expectNoSecretIn(task);
    });

    it("names a long host's shortened aliases exactly as credentialAliases spells them", async () => {
      const host = `${"a".repeat(60)}.example.com`;
      credentialsFor.mockResolvedValue(saved(host));

      await browseTool.run({ task: TASK, site: host }, ctx());

      const aliases = credentialAliases(host);
      expect(aliases.password.length).toBeLessThanOrEqual(64);
      expect(String(sentRun().task)).toContain(
        `available as \`${aliases.username}\` and \`${aliases.password}\``,
      );
    });

    it("runs exactly as before when no login is saved for the site: no bindings, no sentence", async () => {
      await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

      expect(credentialsFor).toHaveBeenCalledTimes(1);
      const body = sentRun();
      expect(body).not.toHaveProperty("secretBindings");
      expect(String(body.task)).not.toMatch(/saved login/i);
      expect(spend).toHaveBeenCalledTimes(1);
    });

    it("looks for no login at all when the model names no site", async () => {
      credentialsFor.mockResolvedValue(saved());

      await browseTool.run({ task: TASK }, ctx());

      expect(credentialsFor).not.toHaveBeenCalled();
      expect(sentRun()).not.toHaveProperty("secretBindings");
      expect(String(sentRun().task)).not.toMatch(/saved login/i);
    });

    /**
     * Ruling R32: the row says which saved login the run carried, so that a
     * login wall afterwards can be blamed on that login — and only then.
     */
    it("records on the task which saved login the run carried", async () => {
      credentialsFor.mockResolvedValue(saved());

      await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

      expect(recordBrowserTask.mock.calls[0][1].credentialId).toBe("cred-1");
    });

    /**
     * Ruling R38 (operator): a shared login is never written into a person's
     * jar. The sign-in it performs would otherwise be saved into the profile
     * of whoever happened to run the task, and Forget — or the saver leaving
     * (R29) — would not stop the agent acting as that account. Personal
     * logins keep the person's own jar.
     */
    describe("a shared login (R38)", () => {
      const JAR = { id: "prof-1", providerProfileId: "prov-1", proxyCountryCode: "de" };
      const shared = (): CredentialBinding => ({ ...saved(), scope: "agent" });
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

      it("opens the browser without the person's jar, and the row records none", async () => {
        profileFor.mockResolvedValue(JAR);
        credentialsFor.mockResolvedValue(shared());

        await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

        const body = sentRun();
        expect(body).not.toHaveProperty("sessionId");
        // Explicit, not absent (R40): the claim may have raced a provisioning.
        expect(body.browserSettings).toEqual({ profileId: null });
        expect(body.secretBindings).toEqual(shared().bindings);
        // The claim was taken before the login was known; the run's start
        // takes the jar back off the row, so R23 keeps follow-ups jar-less.
        expect(recordRunStart.mock.calls[0][1]).toMatchObject({
          providerSessionId: PROVIDER_SESSION,
          profileId: null,
        });
      });

      it("declines a browser opened with the person's jar: an explicit null, and the row lets go of it", async () => {
        profileFor.mockResolvedValue(JAR);
        follow("prof-1");
        credentialsFor.mockResolvedValue(shared());

        await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

        const body = sentRun();
        expect(body.sessionId).toBe(PROVIDER_SESSION);
        expect(body.browserSettings).toEqual({ profileId: null });
        expect(recordRunStart.mock.calls[0][1]).toMatchObject({ profileId: null });
      });

      it("opens the browser with an explicit null profile even when the person has no jar", async () => {
        credentialsFor.mockResolvedValue(shared());

        await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

        expect(sentRun().browserSettings).toEqual({ profileId: null });
      });

      it("reuses a browser opened without a jar as it is: the same explicit null, which matches it (R40)", async () => {
        profileFor.mockResolvedValue(JAR);
        follow(null);
        credentialsFor.mockResolvedValue(shared());

        await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

        expect(sentRun().browserSettings).toEqual({ profileId: null });
      });

      /**
       * Ruling R41: the profiled browser the provider declined is stopped
       * (which saves the person's jar), and the same write that takes the jar
       * off the row forgets it, so the live view, take-over and settle
       * converge on the new browser.
       */
      describe("declining a profiled browser (R41)", () => {
        const followWithBrowser = (profileId: string | null, providerBrowserId: string | null) =>
          ensureBrowserSession.mockResolvedValue({
            kind: "ok",
            value: {
              id: "bs-1",
              providerSessionId: PROVIDER_SESSION,
              liveState: "none",
              runInFlight: false,
              profileId,
              providerBrowserId,
            },
          });
        const stops = () =>
          fetchMock.mock.calls.filter(
            ([url, init]) => url.startsWith(`${V4_BASE}/browsers/`) && init?.method === "PATCH",
          );

        it("stops the stored browser and nulls the id in the write that clears the jar", async () => {
          profileFor.mockResolvedValue(JAR);
          followWithBrowser("prof-1", "br-old");
          credentialsFor.mockResolvedValue(shared());
          fetchMock.mockImplementation(async (url: string, init: RequestInit) =>
            url === `${V4_BASE}/runs`
              ? json({ id: RUN_ID, sessionId: PROVIDER_SESSION, status: "queued" }, 202)
              : json({ id: "br-old", status: "stopped" }),
          );

          await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

          expect(stops().map(([url]) => url)).toEqual([`${V4_BASE}/browsers/br-old`]);
          expect(JSON.parse(String(stops()[0][1].body))).toEqual({ action: "stop" });
          expect(recordRunStart.mock.calls[0][1]).toMatchObject({
            profileId: null,
            providerBrowserId: null,
          });
        });

        it("does not fail the run when the stop is refused, and logs a status only", async () => {
          const console_ = spyConsole();
          profileFor.mockResolvedValue(JAR);
          followWithBrowser("prof-1", "br-old");
          credentialsFor.mockResolvedValue(shared());
          fetchMock.mockImplementation(async (url: string) =>
            url === `${V4_BASE}/runs`
              ? json({ id: RUN_ID, sessionId: PROVIDER_SESSION, status: "queued" }, 202)
              : json({ detail: "refused br-old" }, 500),
          );

          const result = await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

          const said = console_.said();
          console_.restore();
          expect(result.kind).toBe("ok");
          expect(spend).toHaveBeenCalledTimes(1);
          expect(recordRunStart.mock.calls[0][1]).toMatchObject({ providerBrowserId: null });
          expect(said).toContain("500");
          expect(said).not.toContain("br-old");
        });

        it.each([
          ["a browser opened without a jar", () => followWithBrowser(null, "br-old"), "shared"],
          ["the run that opens the browser", () => {}, "shared"],
          ["a personal login", () => followWithBrowser("prof-1", "br-old"), "personal"],
          ["no login at all", () => followWithBrowser("prof-1", "br-old"), "none"],
        ] as const)("stops nothing and keeps the id for %s", async (_label, arrange, kind) => {
          profileFor.mockResolvedValue(JAR);
          arrange();
          credentialsFor.mockResolvedValue(
            kind === "shared" ? shared() : kind === "personal" ? saved() : null,
          );

          await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

          expect(stops()).toHaveLength(0);
          expect(recordRunStart.mock.calls[0][1]).not.toHaveProperty("providerBrowserId");
        });

        it("has nothing to stop when the row names no browser yet, but still lets go of the jar", async () => {
          profileFor.mockResolvedValue(JAR);
          followWithBrowser("prof-1", null);
          credentialsFor.mockResolvedValue(shared());

          await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

          expect(stops()).toHaveLength(0);
          expect(recordRunStart.mock.calls[0][1]).toMatchObject({
            profileId: null,
            providerBrowserId: null,
          });
        });
      });

      it("leaves a personal login in the person's own jar, as before", async () => {
        profileFor.mockResolvedValue(JAR);
        follow("prof-1");
        credentialsFor.mockResolvedValue(saved());

        await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

        expect(sentRun().browserSettings).toEqual({ profileId: "prov-1", proxyCountryCode: "de" });
        expect(recordRunStart.mock.calls[0][1]).not.toHaveProperty("profileId");
      });
    });

    it.each([
      ["no site was named", { task: TASK }, () => {}],
      ["no login is saved for the site", { task: TASK, site: "linkedin.com" }, () => {}],
      [
        "the saved logins could not be read",
        { task: TASK, site: "linkedin.com" },
        () =>
          credentialsFor.mockRejectedValue(new Error("browser_credentials: read failed (57014)")),
      ],
    ])("records no saved login when %s", async (_label, args, arrange) => {
      const console_ = spyConsole();
      arrange();

      await browseTool.run(args, ctx());

      console_.restore();
      expect(recordBrowserTask).toHaveBeenCalledTimes(1);
      expect(recordBrowserTask.mock.calls[0][1].credentialId ?? null).toBeNull();
    });

    it("treats a blank site as no site, rather than refusing a task that needs no sign-in", async () => {
      await browseTool.run({ task: TASK, site: "  " }, ctx());
      expect(credentialsFor).not.toHaveBeenCalled();
      expect(runCalls()).toHaveLength(1);
    });

    /**
     * A database that cannot be read is a run without the login, not a run
     * that does not start: the run meets the login wall and says so, which
     * the person can fix in the panel. The log line says that it happened and
     * nothing of what was being read.
     */
    it("runs without the binding, and logs a status only, when the saved logins cannot be read", async () => {
      const console_ = spyConsole();
      credentialsFor.mockRejectedValue(new Error("browser_credentials: read failed (57014)"));

      const result = await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

      const said = console_.said();
      const logged = console_.calls();
      console_.restore();
      expect(result.kind).toBe("ok");
      expect(runCalls()).toHaveLength(1);
      expect(sentRun()).not.toHaveProperty("secretBindings");
      expect(String(sentRun().task)).not.toMatch(/saved login/i);
      expect(spend).toHaveBeenCalledTimes(1);
      expect(logged).toBeGreaterThan(0);
      expect(said).not.toContain("57014");
    });

    it("looks the login up after the refusals, so a refused browse decrypts nothing", async () => {
      credentialsFor.mockResolvedValue(saved());
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

      const result = await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

      expect(result.kind).toBe("error");
      expect(credentialsFor).not.toHaveBeenCalled();
    });

    /**
     * The provider validates the body and, on a refusal, may echo it — and
     * this body carries the password. `send` withholds every v4 error body
     * (`redactBody: true`); this pins it for the one request where that is
     * the difference between an error message and a leaked login, because
     * the message becomes `message_steps.result_excerpt`, which every member
     * of a shared session can read.
     */
    it.each([400, 422, 500, 503])(
      "carries neither half of the login out of a provider %i that echoes the request",
      async (status) => {
        const console_ = spyConsole();
        credentialsFor.mockResolvedValue(saved());
        fetchMock.mockImplementation(async (_url, init) =>
          json(
            {
              detail: "invalid request",
              echoed: JSON.parse(String(init.body)),
              raw: String(init.body),
            },
            status,
          ),
        );

        const result = await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

        const said = console_.said();
        console_.restore();
        expect(result.kind).toBe("error");
        // The request did carry them: this is the case the redaction is for.
        expect(String(runCalls()[0][1].body)).toContain(PASSWORD);
        expectNoSecretIn(result);
        expectNoSecretIn((result as { message: string }).message);
        expectNoSecretIn(said);
        expect(recordBrowserTask).not.toHaveBeenCalled();
      },
    );

    it("carries neither half of the login into the tool result, the task row or a log line", async () => {
      const console_ = spyConsole();
      credentialsFor.mockResolvedValue(saved());

      const result = await browseTool.run({ task: TASK, site: "linkedin.com" }, ctx());

      const said = console_.said();
      console_.restore();
      expect(result.kind).toBe("ok");
      expectNoSecretIn(result);
      expectNoSecretIn(recordBrowserTask.mock.calls);
      expectNoSecretIn(recordRunStart.mock.calls);
      expectNoSecretIn(said);
    });
  });

  /**
   * Found in the 2026-10-11 e2e: gpt-4.1-mini never filled `site`, not even
   * for "try again with my saved login", so a saved login could not be used
   * in a new conversation. A host the task itself names stands in for it —
   * shown on the card, and never deciding where the password may be typed.
   */
  describe("a site the task names, when the model names none", () => {
    const QUOTES =
      "Sign in at https://quotes.toscrape.com/login and report whether a Logout link is shown";
    const quotesLogin = {
      id: "cred-q",
      label: "quotes — e2e",
      scope: "owner" as const,
      siteHost: "toscrape.com",
    };

    it("shows the login on the card, found from the task's URL", async () => {
      savedLogin.mockImplementation(async (_env, args) =>
        args.host === "quotes.toscrape.com" ? quotesLogin : null,
      );

      const result = await browseTool.run({ task: QUOTES }, ctxWith());

      expect(result.kind).toBe("needs_confirmation");
      const proposal = (result as { proposal: Record<string, unknown> }).proposal;
      expect(proposal.signsInAs).toBe("toscrape.com (saved login: quotes — e2e)");
      expect(credentialsFor).not.toHaveBeenCalled();
    });

    it("carries it once approved, typed only on the saved row's own host", async () => {
      savedLogin.mockImplementation(async (_env, args) =>
        args.host === "quotes.toscrape.com" ? quotesLogin : null,
      );
      credentialsFor.mockResolvedValue(saved("toscrape.com"));

      await browseTool.run({ task: QUOTES }, ctx());

      // Asked by the task's host, as a model's `site` would be; the pick walks
      // up to the saved row, and the row's host is what the bindings allow.
      expect(credentialsFor.mock.calls[0][1]).toEqual({
        agentId: "agent-1",
        userId: "user-1",
        host: "quotes.toscrape.com",
      });
      for (const binding of sentRun().secretBindings as { allowedDomains: string[] }[]) {
        expect(binding.allowedDomains).toEqual(["toscrape.com"]);
      }
      expect(recordBrowserTask.mock.calls[0][1].credentialId).toBe("cred-1");
    });

    it("takes the first named host that has a login, and asks about three at most", async () => {
      savedLogin.mockImplementation(async (_env, args) =>
        args.host === "c.example" ? { ...quotesLogin, siteHost: "c.example" } : null,
      );

      const result = await browseTool.run(
        { task: "compare a.example, https://www.b.example/x, c.example and d.example prices" },
        ctxWith(),
      );

      const asked = savedLogin.mock.calls.map((call) => call[1].host);
      expect(asked.slice(0, 3)).toEqual(["a.example", "b.example", "c.example"]);
      expect(asked).not.toContain("d.example");
      expect((result as { proposal: Record<string, unknown> }).proposal.signsInAs).toBe(
        "c.example (saved login: quotes — e2e)",
      );
    });

    it("lets the model's own site win, and asks nothing about the task's hosts", async () => {
      credentialsFor.mockResolvedValue(saved());

      await browseTool.run({ task: QUOTES, site: "linkedin.com" }, ctx());

      expect(savedLogin).not.toHaveBeenCalled();
      expect(credentialsFor.mock.calls[0][1].host).toBe("linkedin.com");
    });

    it("runs without a login, as before, when the saved logins cannot be read", async () => {
      const console_ = spyConsole();
      savedLogin.mockRejectedValue(new Error("browser_credentials: read failed (57014)"));

      const result = await browseTool.run({ task: QUOTES }, ctx());
      console_.restore();

      expect(result.kind).toBe("ok");
      expect(credentialsFor).not.toHaveBeenCalled();
      expect(sentRun()).not.toHaveProperty("secretBindings");
    });
  });

  describe("an invalid site", () => {
    it.each([
      ["not a host", "not a host"],
      ["a dotless name", "localhost"],
      ["an address with a user in it", "ada@linkedin.com"],
      ["a number", 42],
    ])("is refused, before the card and before anything is spent: %s", async (_label, site) => {
      for (const confirmed of [false, true]) {
        const result = await browseTool.run({ task: TASK, site }, ctxWith({ confirmed }));
        expect(result.kind).toBe("error");
        expect((result as { message: string }).message).toMatch(/site/i);
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(affordable).not.toHaveBeenCalled();
      expect(ensureBrowserSession).not.toHaveBeenCalled();
      expect(spend).not.toHaveBeenCalled();
      expect(credentialsFor).not.toHaveBeenCalled();
      expect(savedLogin).not.toHaveBeenCalled();
    });
  });

  describe("on the approval card", () => {
    it("says which saved login the browser signs in with — by its label, never its username", async () => {
      savedLogin.mockResolvedValue({
        id: "cred-1",
        label: LABEL,
        scope: "owner",
        siteHost: "linkedin.com",
      });

      const result = await browseTool.run(
        { task: TASK, site: "https://www.linkedin.com/feed" },
        ctxWith(),
      );

      expect(result.kind).toBe("needs_confirmation");
      const proposal = (result as { proposal: Record<string, unknown> }).proposal;
      expect(proposal.signsInAs).toBe(`linkedin.com (saved login: ${LABEL})`);
      expect(savedLogin.mock.calls[0][1]).toEqual({
        agentId: "agent-1",
        userId: "user-1",
        host: "linkedin.com",
      });
      // A card somebody may decline decrypts nothing.
      expect(credentialsFor).not.toHaveBeenCalled();
      expectNoSecretIn(result);
    });

    it("adds signsInAs to the card's rows and nothing else", async () => {
      profileFor.mockResolvedValue({
        id: "prof-1",
        providerProfileId: "prov-1",
        proxyCountryCode: null,
      });
      savedLogin.mockResolvedValue({
        id: "cred-1",
        label: LABEL,
        scope: "agent",
        siteHost: "linkedin.com",
      });

      const result = await browseTool.run(
        { task: TASK, site: "linkedin.com" },
        ctxWith({ db: refusingDb(["portal.example.com"]) }),
      );

      const proposal = (result as { proposal: Record<string, unknown> }).proposal;
      expect(Object.keys(proposal).sort()).toEqual([
        "cookies",
        "cost",
        "kind",
        "signsInAs",
        "task",
      ]);
    });

    // A colleague's shared login typed into the person's own browser,
    // where they are already signed in to that site, replaced their session
    // with the shared account's.
    it("keeps a shared login out of a jar that already has the site", async () => {
      profileFor.mockResolvedValue({
        id: "prof-1",
        providerProfileId: "prov-1",
        proxyCountryCode: null,
      });
      savedLogin.mockResolvedValue({
        id: "cred-1",
        label: LABEL,
        scope: "agent",
        siteHost: "linkedin.com",
      });

      const result = await browseTool.run(
        { task: TASK, site: "linkedin.com" },
        ctxWith({ db: refusingDb(["www.linkedin.com", "google.com"]) }),
      );

      expect((result as { proposal: Record<string, unknown> }).proposal.signsInAs).toBeUndefined();
    });

    it("still uses the person's own saved login in their own jar", async () => {
      profileFor.mockResolvedValue({
        id: "prof-1",
        providerProfileId: "prov-1",
        proxyCountryCode: null,
      });
      savedLogin.mockResolvedValue({
        id: "cred-1",
        label: LABEL,
        scope: "owner",
        siteHost: "linkedin.com",
      });

      const result = await browseTool.run(
        { task: TASK, site: "linkedin.com" },
        ctxWith({ db: refusingDb(["linkedin.com"]) }),
      );

      expect((result as { proposal: Record<string, unknown> }).proposal.signsInAs).toBe(
        `linkedin.com (saved login: ${LABEL})`,
      );
    });

    it("says nothing about a saved login when there is none for the site", async () => {
      const result = await browseTool.run({ task: TASK, site: "linkedin.com" }, ctxWith());
      const proposal = (result as { proposal: Record<string, unknown> }).proposal;
      expect(proposal.signsInAs).toBeUndefined();
    });

    it("still asks the question when the saved logins cannot be read", async () => {
      const console_ = spyConsole();
      savedLogin.mockRejectedValue(new Error("browser_credentials: read failed (57014)"));
      const result = await browseTool.run({ task: TASK, site: "linkedin.com" }, ctxWith());
      console_.restore();
      expect(result.kind).toBe("needs_confirmation");
      expect((result as { proposal: Record<string, unknown> }).proposal.signsInAs).toBeUndefined();
    });
  });
});

/**
 * A routine whose owner allowed the browser (0100).
 *
 * `routineBrowser` is the approval — given once on the routine — so these runs
 * never show a card, report into the routine's own conversation, and tell the
 * engine which tasks its report has to wait for.
 */
describe("a routine's run, allowed the browser", () => {
  const conversation = vi.fn(async (): Promise<string | null> => "routine-conv-1");
  const routineCtx = (
    access: "all" | "site",
    site: string | null = null,
    over: Partial<ToolContext> = {},
  ): ToolContext & { routineBrowser: NonNullable<ToolContext["routineBrowser"]> } => {
    const ctx = ctxWith({
      sessionId: undefined,
      routineRunId: "run-1",
      routineBrowser: { access, site, conversation, started: [] },
      ...over,
    });
    return ctx as ToolContext & { routineBrowser: NonNullable<ToolContext["routineBrowser"]> };
  };

  beforeEach(() => {
    conversation.mockReset();
    conversation.mockResolvedValue("routine-conv-1");
  });

  it("starts without a card, in the routine's conversation, and says the report waits", async () => {
    const ctx = routineCtx("all");
    const result = await browseTool.run({ task: TASK }, ctx);

    expect(result.kind).toBe("ok");
    expect((result as { content: string }).content).toMatch(/report is held/i);
    expect(conversation).toHaveBeenCalledOnce();
    expect(ensureBrowserSession.mock.calls[0][1].chatSessionId).toBe("routine-conv-1");
    expect(recordBrowserTask.mock.calls[0][1]).toMatchObject({
      sessionId: "routine-conv-1",
      routineRunId: "run-1",
      jarless: false,
    });
    expect(ctx.routineBrowser.started).toEqual(["bt-1"]);
  });

  it("keeps no step after the browser for a routine, which has no conversation to carry on in", async () => {
    await browseTool.run({ task: TASK, then: "write it to Qrucial" }, routineCtx("all"));
    expect("thenStep" in recordBrowserTask.mock.calls[0][1]).toBe(false);
  });

  it("carries the owner's jar with `all`, as a conversation's browser would", async () => {
    const JAR = { id: "prof-1", providerProfileId: "prov-1", proxyCountryCode: "de" };
    profileFor.mockResolvedValue(JAR);

    await browseTool.run({ task: TASK }, routineCtx("all"));

    expect(heldTakeover).toHaveBeenCalled();
    expect(sentRun().browserSettings).toMatchObject({ profileId: "prov-1" });
  });

  it("carries no jar with `site`, and only that site's saved login", async () => {
    const JAR = { id: "prof-1", providerProfileId: "prov-1", proxyCountryCode: "de" };
    profileFor.mockResolvedValue(JAR);
    const aliases = credentialAliases("linkedin.com");
    const login: CredentialBinding = {
      id: "cred-1",
      label: "LinkedIn",
      scope: "owner",
      siteHost: "linkedin.com",
      aliases,
      bindings: [
        {
          alias: aliases.username,
          source: { type: "inline", value: "u" },
          allowedDomains: ["linkedin.com"],
        },
      ],
    };
    credentialsFor.mockResolvedValue(login);

    await browseTool.run({ task: TASK }, routineCtx("site", "linkedin.com"));

    // No jar read, none made, and the person's own browser is no reason to wait.
    expect(profileFor).not.toHaveBeenCalled();
    expect(runProfile).not.toHaveBeenCalled();
    expect(heldTakeover).not.toHaveBeenCalled();
    const body = sentRun();
    expect(body.browserSettings).toEqual({ profileId: null });
    expect(body.secretBindings).toEqual(login.bindings);
    expect(credentialsFor.mock.calls[0][1].host).toBe("linkedin.com");
    expect(recordBrowserTask.mock.calls[0][1]).toMatchObject({ jarless: true });
  });

  it("refuses, before anything is spent, a sign-in somewhere `site` does not allow", async () => {
    const result = await browseTool.run(
      { task: TASK, site: "facebook.com" },
      routineCtx("site", "linkedin.com"),
    );

    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toContain("linkedin.com");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(conversation).not.toHaveBeenCalled();
  });

  it("allows a subdomain of the one site", async () => {
    const result = await browseTool.run(
      { task: TASK, site: "www.linkedin.com" },
      routineCtx("site", "linkedin.com"),
    );
    expect(result.kind).toBe("ok");
  });

  it("starts nothing when the routine's conversation cannot be opened", async () => {
    conversation.mockResolvedValue(null);
    const result = await browseTool.run({ task: TASK }, routineCtx("all"));

    expect(result.kind).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(ensureBrowserSession).not.toHaveBeenCalled();
  });

  it("puts a task in line with what it answers, and the report waits for that one too", async () => {
    ensureBrowserSession.mockResolvedValue({
      kind: "ok",
      value: {
        id: "bs-1",
        providerSessionId: PROVIDER_SESSION,
        liveState: "none",
        runInFlight: true,
        profileId: null,
      },
    });
    const ctx = routineCtx("site", "linkedin.com");
    const result = await browseTool.run({ task: TASK }, ctx);

    expect(result.kind).toBe("ok");
    expect((result as { content: string }).content).toMatch(/^Queued/);
    expect(queueBrowserTask.mock.calls[0][1]).toMatchObject({
      sessionId: "routine-conv-1",
      routineRunId: "run-1",
      jarless: true,
      site: "linkedin.com",
    });
    expect(ctx.routineBrowser.started).toEqual(["bt-waiting"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still refuses a scheduled run whose routine did not allow it", async () => {
    const result = await browseTool.run(
      { task: TASK },
      ctxWith({ sessionId: undefined, routineRunId: "run-1" }),
    );
    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toMatch(/allows the browser/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
