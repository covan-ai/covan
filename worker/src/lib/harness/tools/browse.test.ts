import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTool, ToolContext, ToolEnv, ToolResult } from "../registry";
import type { BrowserResult, CreatedTask } from "../../browser/client";
import type { QuotaSnapshot } from "../../entitlements";

/**
 * Each mock is declared with the real signature and forwarded by name, which
 * is the shape `http-request.test.ts` established: a `vi.fn()` with no
 * parameters infers a no-argument procedure, and then every spread into it is
 * a type error and every `mockResolvedValue` is checked against the wrong
 * return type.
 */
const createTask = vi.fn(
  async (
    _env: unknown,
    _input: { task: string },
    _opts?: { signal?: AbortSignal },
  ): Promise<BrowserResult<CreatedTask>> => ({
    kind: "ok",
    value: { id: "bu-1", sessionId: "bus-1" },
  }),
);
vi.mock("../../browser/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../browser/client")>();
  return {
    ...actual,
    createTask: (env: unknown, input: { task: string }, opts?: { signal?: AbortSignal }) =>
      createTask(env, input, opts),
  };
});

const recordBrowserTask = vi.fn(
  async (
    _env: unknown,
    _input: {
      workspaceId: string;
      agentId: string;
      userId: string;
      sessionId: string;
      providerTaskId: string;
      task: string;
    },
  ): Promise<string | null> => "bt-1",
);
vi.mock("../../browser/tasks", () => ({
  recordBrowserTask: (env: unknown, input: Parameters<typeof recordBrowserTask>[1]) =>
    recordBrowserTask(env, input),
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
vi.mock("../../browser/takeover", () => ({ profileFor }));

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
  recordBrowserTask.mockReset();
  recordBrowserTask.mockResolvedValue("bt-1");
  createTask.mockReset();
  affordable.mockReset();
  affordable.mockResolvedValue(null);
  spend.mockReset();
  snapshot.mockReset();
  snapshot.mockResolvedValue({ used: 0, limit: 1_000_000, resetsAt: "2026-11-01T00:00:00Z" });
  createTask.mockResolvedValue({ kind: "ok", value: { id: "bu-1", sessionId: "bus-1" } });
});

const TASK = "read the pricing table on example.com and list the tiers";

describe("asking first", () => {
  it("asks for confirmation before it spends anything", async () => {
    const result = await browseTool.run({ task: TASK }, ctxWith());
    expect(result.kind).toBe("needs_confirmation");
    expect(createTask).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
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

  it("hands the task over and returns the id rather than the answer", async () => {
    const result = await browseTool.run({ task: TASK }, ctx());
    expect(result.kind).toBe("ok");
    expect(createTask).toHaveBeenCalledWith(
      expect.anything(),
      { task: TASK },
      expect.objectContaining({ signal: undefined }),
    );
    // The turn ends here. The content must not read as an answer.
    expect((result as { content: string }).content).toMatch(/started|few minutes/i);
  });

  it("records the handoff with the session the answer has to go back to", async () => {
    await browseTool.run({ task: TASK }, ctx());
    expect(recordBrowserTask).toHaveBeenCalledTimes(1);
    expect(recordBrowserTask.mock.calls[0][1]).toEqual({
      workspaceId: "ws-1",
      agentId: "agent-1",
      userId: "user-1",
      sessionId: "sess-1",
      providerTaskId: "bu-1",
      task: TASK,
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
    expect(createTask).not.toHaveBeenCalled();
    expect(spend).not.toHaveBeenCalled();
  });

  /**
   * The concurrency pool is account-wide and shared across every tenant — ten
   * sessions at $0 lifetime spend. A refused creation cost nothing, so it
   * must charge nothing.
   */
  it("does not charge for a task the concurrency pool refused", async () => {
    createTask.mockResolvedValue({
      kind: "error",
      status: 429,
      message: "Too many concurrent active sessions",
    });
    const result = await browseTool.run({ task: TASK }, ctx());
    expect(result.kind).toBe("error");
    expect((result as { message: string }).message).toMatch(/busy|again/i);
    expect(spend).not.toHaveBeenCalled();
    expect(recordBrowserTask).not.toHaveBeenCalled();
  });

  it("does not charge when the provider could not be reached at all", async () => {
    createTask.mockResolvedValue({ kind: "error", status: 0, message: "network down" });
    await browseTool.run({ task: TASK }, ctx());
    expect(spend).not.toHaveBeenCalled();
  });

  /**
   * A 500 means they took the request. `wasBilled` is the existing rule for
   * which failures are somebody's money and which are not.
   */
  it("charges for a failure the provider is nonetheless responsible for", async () => {
    createTask.mockResolvedValue({ kind: "error", status: 500, message: "internal error" });
    await browseTool.run({ task: TASK }, ctx());
    expect(spend).toHaveBeenCalledWith(expect.anything(), BROWSER_TASK_TOKENS);
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
    expect(createTask).not.toHaveBeenCalled();
  });
});

describe("availability", () => {
  it("is not offered on a deployment with no browser-use key", () => {
    expect(browseTool.isConfigured({} as ToolEnv)).toBe(false);
    expect(browseTool.isConfigured({ BROWSER_USE_API_KEY: "bu_x" } as ToolEnv)).toBe(true);
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
    createTask.mockResolvedValue({ kind: "ok", value: { id: "t-1", sessionId: "s-1" } });
    const ctx = ctxWith({ confirmed: true, db: refusingDb(["mail.google.com"]) });

    await browseTool.run({ task: "read my invoices on the portal" }, ctx);

    const input = createTask.mock.calls[0][1];
    expect(input).toMatchObject({ profileId: "prov-1", proxyCountryCode: "de" });
    // Permanent, and the reason the jar can be a credential at all: Covan
    // never receives one, so it has none to send.
    expect(input).not.toHaveProperty("secrets");
    expect(input).not.toHaveProperty("opVaultId");
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
