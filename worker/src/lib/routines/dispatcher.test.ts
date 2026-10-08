// worker/src/lib/routines/dispatcher.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runDueRoutines, runOneRoutine, clusterQuestions, coverageDeps } from "./dispatcher";
import { parseClusters } from "./coverage-source";

const createMock = vi.fn();
// What each `new OpenAI(...)` construction was handed — specifically its
// `apiKey` — so item B7's test can tell the house env and a run's resolved
// env apart without a mock that merely records the completion call shape.
const openAIConstructions: Array<{ apiKey?: string }> = [];

// Stub the OpenAI SDK, the same way `summarise.test.ts` does, and for the
// same reason: `clusterQuestions` below is the one place on this branch that
// spends money on this feature's behalf, so the call shape — and the reply
// shape coming back — matter more than they would on an ordinary unit test.
// vi.mock is hoisted above imports by vitest, so this applies before
// `lib/completion` constructs its `new OpenAI(...)` client.
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createMock } };
    constructor(opts: { apiKey?: string }) {
      openAIConstructions.push(opts);
    }
  },
}));

const env = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  ALLOWED_ORIGIN: "https://app.example.com",
  OPENAI_API_KEY: "sk-test",
  ROUTINE_SECRET_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Routines <routines@example.com>",
} as any;

const dueRow = (id: string) => ({
  id,
  schedule_cron: "*/15 * * * *",
  timezone: "UTC",
  workspace_id: "ws-1",
});

/**
 * A client that answers the one read a tick makes for itself: which of the
 * claimed routines' workspaces have a connected service.
 *
 * It is a read the dispatcher does once rather than once per routine, which
 * is the whole reason it lives up there — so the fake has to be here, at the
 * level that models the tick.
 */
const dbWith = (rpc: unknown, connected: string[] = []) => ({
  rpc,
  from: () => ({
    select: () => ({
      // Filtered on status before the workspace list, because a connection is
      // a row from the moment somebody is sent to a consent screen and a
      // half-made one must not put a workspace on the expensive path (0063).
      eq: () => ({
        in: async () => ({
          data: connected.map((workspace_id) => ({ workspace_id })),
          error: null,
        }),
      }),
    }),
  }),
});

describe("runDueRoutines", () => {
  it("claims a bounded batch and runs each claimed routine", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1"), dueRow("r2")], error: null });
    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 1 });

    const out = await runDueRoutines(env, { db: dbWith(rpc) as any, runRoutine });

    expect(rpc).toHaveBeenCalledWith("claim_due_routines", { p_limit: 3 });
    expect(runRoutine).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ claimed: 2, ok: 2, failed: 0 });
  });

  it("keeps the batch inside the Workers Free subrequest budget", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    await runDueRoutines(env, { db: dbWith(rpc) as any, runRoutine: vi.fn() });

    // A tick spends 2 subrequests of its own — the claim RPC, and the one
    // read asking which of the claimed workspaces have a connected service —
    // and up to 12 per routine. Workers Free allows 50 per invocation, so
    // raising the batch without moving to Workers Paid must fail here rather
    // than in production.
    //
    // Strictly under 50 rather than at it: a tick that lands exactly on the
    // ceiling has no room for the next subrequest anybody adds, and the
    // symptom is the last routine of a busy tick failing for a reason its run
    // log cannot explain.
    const [, args] = rpc.mock.calls[0];
    expect(2 + args.p_limit * 12).toBeLessThan(50);
  });

  /**
   * The read that replaced up to three identical ones.
   *
   * On the cron Worker a database read is a subrequest, and a per-routine
   * lookup would have asked the same question once per routine to be told
   * "no" every time — which is the answer on every deployment that has
   * connected nothing, i.e. almost all of them.
   */
  it("asks once per tick which workspaces have a connected service", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1"), dueRow("r2")], error: null });
    const inFilter = vi.fn(async () => ({ data: [], error: null }));
    const db = { rpc, from: () => ({ select: () => ({ eq: () => ({ in: inFilter }) }) }) };

    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 0 });
    await runDueRoutines(env, { db: db as any, runRoutine });

    expect(inFilter).toHaveBeenCalledTimes(1);
  });

  it("runs the tick as it always did when that read fails", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1")], error: null });
    const db = {
      rpc,
      from: () => ({
        select: () => ({
          eq: () => ({ in: async () => ({ data: null, error: { message: "gone" } }) }),
        }),
      }),
    };
    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 1 });

    const out = await runDueRoutines(env, { db: db as any, runRoutine });

    // An empty answer is the same thing as "nothing is connected", which is
    // exactly how every routine ran before any of this existed.
    expect(out).toEqual({ claimed: 1, ok: 1, failed: 0 });
  });

  it("does nothing when nothing is due", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const runRoutine = vi.fn();

    const out = await runDueRoutines(env, { db: dbWith(rpc) as any, runRoutine });

    expect(runRoutine).not.toHaveBeenCalled();
    expect(out).toEqual({ claimed: 0, ok: 0, failed: 0 });
  });

  it("keeps going when one routine throws, so a bad row cannot stall the tick", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1"), dueRow("r2")], error: null });
    const runRoutine = vi
      .fn()
      .mockRejectedValueOnce(new Error("kaboom"))
      .mockResolvedValueOnce({ status: "ok", itemsNew: 1 });

    const out = await runDueRoutines(env, { db: dbWith(rpc) as any, runRoutine });

    expect(out).toEqual({ claimed: 2, ok: 1, failed: 1 });
  });

  it("throws when the claim itself fails", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "no such function" } });
    await expect(
      runDueRoutines(env, { db: dbWith(rpc) as any, runRoutine: vi.fn() }),
    ).rejects.toThrow(/no such function/);
  });

  it("hands down a bound fetch rather than the bare global", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1")], error: null });
    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 0 });

    await runDueRoutines(env, { db: dbWith(rpc) as any, runRoutine });

    // The Workers runtime rejects global fetch called with a `this` that isn't
    // the global scope ("Illegal invocation"), and Node's fetch does not care —
    // so a test that actually calls fetch can never catch this. Pinning the
    // identity is the only check that fails here instead of on a live delivery.
    const deps = runRoutine.mock.calls[0][1];
    expect(deps.fetchDeps.fetchImpl).not.toBe(globalThis.fetch);
    expect(deps.deliveryDeps.fetchImpl).not.toBe(globalThis.fetch);
    expect(typeof deps.fetchDeps.fetchImpl).toBe("function");
  });

  it("includes WORKER_HOST in ownHosts, alongside the ALLOWED_ORIGIN hosts", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1")], error: null });
    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 0 });
    const envWithWorkerHost = { ...env, WORKER_HOST: "api.example.com" };

    await runDueRoutines(envWithWorkerHost, { db: dbWith(rpc) as any, runRoutine });

    const deps = runRoutine.mock.calls[0][1];
    expect(deps.fetchDeps.ownHosts).toEqual(["app.example.com", "api.example.com"]);
  });

  it("drops a malformed ownHosts entry instead of throwing", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1")], error: null });
    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 0 });
    const envWithBadHost = { ...env, WORKER_HOST: "not a valid host :://" };

    const out = await runDueRoutines(envWithBadHost, { db: dbWith(rpc) as any, runRoutine });

    expect(out).toEqual({ claimed: 1, ok: 1, failed: 0 });
    const deps = runRoutine.mock.calls[0][1];
    expect(deps.fetchDeps.ownHosts).toEqual(["app.example.com"]);
  });
});

describe("runOneRoutine", () => {
  // The point is to run a routine that is *not* due. Going through
  // claim_due_routines would find nothing and do nothing.
  it("runs the given routine without claiming anything", async () => {
    const rpc = vi.fn();
    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 2 });

    const out = await runOneRoutine(env, dueRow("r1") as any, {
      db: dbWith(rpc) as any,
      runRoutine,
    });

    expect(rpc).not.toHaveBeenCalled();
    expect(runRoutine).toHaveBeenCalledTimes(1);
    expect(runRoutine.mock.calls[0][0].id).toBe("r1");
    expect(out).toEqual({ status: "ok", itemsNew: 2 });
  });

  it("builds the same executor dependencies a scheduled run gets", async () => {
    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 0 });

    await runOneRoutine(env, dueRow("r1") as any, { db: {} as any, runRoutine });

    const deps = runRoutine.mock.calls[0][1];
    expect(deps.fetchDeps.ownHosts).toEqual(["app.example.com"]);
    expect(deps.deliveryDeps.resendApiKey).toBe("re_test");
    expect(deps.deliveryDeps.secretKey).toBe(env.ROUTINE_SECRET_KEY);
  });
});

/**
 * The guard that keeps an optional extra from pausing a working routine.
 *
 * Asserted here rather than in the executor because this is where the decision
 * is made: the dispatcher hands the executor a filing function or it does not,
 * and a deployment with no document store gets the second. The executor then
 * has nothing that could throw, which is the whole point — see
 * `canFileDocuments`.
 */
describe("filing is wired only where it can work", () => {
  async function depsFor(envOver: Record<string, unknown>) {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1")], error: null });
    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 0 });
    await runDueRoutines({ ...env, ...envOver } as any, { db: dbWith(rpc) as any, runRoutine });
    return runRoutine.mock.calls[0][1];
  }

  it("hands over no filing function when nothing is bound", async () => {
    // The ordinary state of the cron Worker on Cloudflare: an R2 bucket cannot
    // be shared across accounts, and `wrangler.cron.toml.example` says so.
    expect((await depsFor({})).file).toBeUndefined();
  });

  it("hands one over on the Node runtime, which has a filesystem root", async () => {
    expect(typeof (await depsFor({ DOCS_DIR: "/tmp/docs" })).file).toBe("function");
  });

  it("hands one over on Cloudflare once the bucket is bound", async () => {
    const DOCS = { put: vi.fn(), get: vi.fn(), delete: vi.fn() };
    expect(typeof (await depsFor({ DOCS })).file).toBe("function");
  });
});

describe("a workspace routine gets the gap report bound to its real dependencies", () => {
  it("hands the executor a coverage dependency", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1")], error: null });
    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 0 });

    await runDueRoutines(env, { db: dbWith(rpc) as any, runRoutine });

    const deps = runRoutine.mock.calls[0][1];
    expect(typeof deps.coverage).toBe("function");
  });

  /**
   * Fix round 1, finding B7. `coverage`'s second argument is the run's
   * resolved env — the one that may carry an owner's own key — not the
   * dispatcher's own `env` closed over at construction. `expect.anything()`
   * on the second argument (as the test above uses) passes whichever one
   * reaches `coverageDeps`, so it cannot catch a regression that swaps
   * `runEnv` for `env` in the one-line closure in `executorDeps`. BYOK
   * billing is the entire reason that second argument exists, so this pins
   * it on a key that actually distinguishes the two: the `OPENAI_API_KEY`
   * the clustering call's OpenAI client is constructed with.
   *
   * Drives the real `coverageDeps`/`runCoverageReport` pipeline far enough to
   * reach the one model call — `readWorkspace` reporting the report on and
   * the caller an admin, `readGaps` returning three distinct askers (the
   * floor for a 3-member workspace) — and lets the model's reply fail the
   * floor (`{clusters: []}`), so `readTotals` is never needed.
   */
  it("pays the clustering call with the run's resolved env, not the dispatcher's own", async () => {
    openAIConstructions.length = 0;
    createMock.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ clusters: [] }) } }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    });
    const db = {
      rpc: vi.fn(async (name: string) => {
        if (name === "workspace_coverage_gaps") {
          return {
            data: [
              { question: "Q1", asker_key: 0 },
              { question: "Q2", asker_key: 1 },
              { question: "Q3", asker_key: 2 },
            ],
            error: null,
          };
        }
        return { data: [], error: null };
      }),
      from: (table: string) =>
        table === "workspaces"
          ? {
              select: () => ({
                eq: () => ({
                  single: async () => ({ data: { gap_report_enabled: true }, error: null }),
                }),
              }),
            }
          : {
              select: () => ({
                eq: async () => ({
                  data: [
                    { user_id: "owner-1", role: "admin" },
                    { user_id: "m2", role: "member" },
                    { user_id: "m3", role: "member" },
                  ],
                  error: null,
                }),
              }),
            },
    };
    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 0 });

    await runOneRoutine(env, dueRow("r1") as any, { db: db as any, runRoutine });

    const deps = runRoutine.mock.calls[0][1];
    const runEnv = { ...env, OPENAI_API_KEY: "sk-run-env-key" };

    await deps.coverage({ workspaceId: "ws-1", ownerId: "owner-1", days: 7 }, runEnv);

    expect(openAIConstructions.at(-1)).toMatchObject({ apiKey: "sk-run-env-key" });
  });
});

/**
 * `coverageDeps`'s two RPC reads, in isolation from the executor that calls
 * them — see the export's own comment in `dispatcher.ts` for why.
 *
 * This is the regression that reading 0075's migration caught and the brief
 * did not: its illustrative `readTotals` called `workspace_coverage` (0053)
 * with just `p_workspace_id`/`p_days`. That function asks `is_workspace_admin`,
 * which reads `auth.uid()` — null for every service-role caller, always — so
 * every scheduled run would have raised 42501 on its first read, forever.
 * 0075 exists because of exactly that dead end: `workspace_coverage_totals`
 * and `workspace_coverage_gaps` take `p_user_id` explicitly instead, and are
 * granted to `service_role` only. Both assertions below are pinned on the
 * function NAME as well as the params, so a reviewer who only diffs the
 * params would still see the regression this guards.
 */
describe("coverageDeps", () => {
  it("asks workspace_coverage_totals and workspace_coverage_gaps for the owner by id", async () => {
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ answers: 10, covered: 7, fallback: 1, ungrounded: 1, unrecorded: 1 }],
        error: null,
      })
      .mockResolvedValueOnce({
        data: [{ question: "Can I expense a conference?", asker_key: 0 }],
        error: null,
      });
    const deps = coverageDeps({ rpc } as any, "owner-1", { OPENAI_API_KEY: "sk-test" } as any);

    const totals = await deps.readTotals("ws-1", 7);
    const gaps = await deps.readGaps("ws-1", 7);

    expect(rpc).toHaveBeenNthCalledWith(1, "workspace_coverage_totals", {
      p_workspace_id: "ws-1",
      p_user_id: "owner-1",
      p_days: 7,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "workspace_coverage_gaps", {
      p_workspace_id: "ws-1",
      p_user_id: "owner-1",
      p_days: 7,
    });
    expect(totals).toEqual({
      days: 7,
      answers: 10,
      covered: 7,
      fallback: 1,
      ungrounded: 1,
      unrecorded: 1,
    });
    expect(gaps).toEqual([{ question: "Can I expense a conference?", asker_key: 0 }]);
  });

  it("reads an admin-check refusal from workspace_coverage_gaps as an empty list, not a thrown error", async () => {
    // `readGaps` logs this refusal on purpose (it is the one error this
    // function is designed to swallow) — fix round 1, finding B5: silence it
    // the way the rest of the repo does, and prove it still happened.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    // One call, one mocked resolution: `readGaps` alone makes exactly one rpc
    // call. A second queued `mockResolvedValueOnce` here (meant for a
    // `readTotals` call this test never makes) would silently absorb this
    // one, leaving the refusal never reached — the bug the `error` spy above
    // exists to catch, which is why this test is pinned to call only
    // `readGaps`.
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code: "42501", message: "not an admin" } });
    const deps = coverageDeps({ rpc } as any, "owner-1", { OPENAI_API_KEY: "sk-test" } as any);

    const gaps = await deps.readGaps("ws-1", 7);

    expect(gaps).toEqual([]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  /**
   * Fix round 1, finding A1. `readWorkspace` used to destructure neither
   * read's `error`, so a failed one left `gapReportEnabled`/`ownerIsAdmin`
   * false by default — a transient database error read as "the report is
   * turned off" or "the owner is no longer an admin", and the routine paused
   * on that false premise with nothing logged, forever (`claim_due_routines`
   * only selects `status = 'active'`, 0055:77). A thrown error here becomes a
   * failed run instead — recorded, backed off, retried next tick.
   */
  describe("readWorkspace", () => {
    function dbFor(opts: {
      workspace?: { gap_report_enabled: boolean } | null;
      workspaceError?: { message: string };
      members?: Array<{ user_id: string; role: string }>;
      membersError?: { message: string };
    }) {
      return {
        from: (table: string) =>
          table === "workspaces"
            ? {
                select: () => ({
                  eq: () => ({
                    single: async () => ({
                      data: opts.workspace ?? null,
                      error: opts.workspaceError ?? null,
                    }),
                  }),
                }),
              }
            : {
                select: () => ({
                  eq: async () => ({
                    data: opts.members ?? [],
                    error: opts.membersError ?? null,
                  }),
                }),
              },
      };
    }

    it("throws on a failed workspace read, rather than reading it as 'turned off'", async () => {
      const db = dbFor({ workspaceError: { message: "connection reset" } });
      const deps = coverageDeps(db as any, "owner-1", { OPENAI_API_KEY: "sk-test" } as any);

      await expect(deps.readWorkspace("ws-1", "owner-1")).rejects.toThrow(/connection reset/);
    });

    it("throws on a failed membership read, rather than reading it as 'no longer an admin'", async () => {
      const db = dbFor({
        workspace: { gap_report_enabled: true },
        membersError: { message: "statement timeout" },
      });
      const deps = coverageDeps(db as any, "owner-1", { OPENAI_API_KEY: "sk-test" } as any);

      await expect(deps.readWorkspace("ws-1", "owner-1")).rejects.toThrow(/statement timeout/);
    });
  });

  /**
   * Fix round 1, finding A2. `readTotals` only ever runs on the report path,
   * after the clustering call already spent money. A swallowed error used to
   * fall through to every count reading zero, which `renderCoverageReport`
   * turns into "no answer recorded what grounded it, so there is no coverage
   * to report" — printed directly above the real gap topics `readGaps` found
   * moments earlier. A thrown error is a failed run instead of a report that
   * contradicts itself.
   */
  it("throws on a failed workspace_coverage_totals read, rather than reporting zero answers", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: null, error: { message: "db timeout" } });
    const deps = coverageDeps({ rpc } as any, "owner-1", { OPENAI_API_KEY: "sk-test" } as any);

    await expect(deps.readTotals("ws-1", 7)).rejects.toThrow(/db timeout/);
  });
});

/**
 * The prompt-to-parser contract, end to end — the gap Task 12's review found:
 * the brief's own prompt asked for a bare JSON array, which neither provider
 * this build talks to can ever send back. OpenAI's `response_format:
 * {type:"json_object"}` guarantees a top-level object every time, so a prompt
 * that asked for an array would have every reply parse to nothing, forever,
 * with no error anywhere to say so — the clustering call would still be paid
 * for every week.
 *
 * `parseClusters` is imported unmocked from `coverage-source.ts`: the point is
 * that the REAL prompt and the REAL parser agree, not that each independently
 * does what it claims to.
 */
describe("clusterQuestions", () => {
  beforeEach(() => createMock.mockReset());

  it("asks for an object keyed `clusters`, and the realistic reply survives parseClusters", async () => {
    // A realistic reply body: this is exactly the string shape
    // `response_format: {type:"json_object"}` guarantees OpenAI will send —
    // a top-level object, never a bare array.
    createMock.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              clusters: [
                { label: "Expense policy", members: [0, 2] },
                { label: "PTO rollover", members: [1] },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 120, completion_tokens: 40 },
    });

    const result = await clusterQuestions(
      ["Can I expense a conference?", "Does PTO roll over to next year?", "What's the per-diem?"],
      { OPENAI_API_KEY: "sk-test" } as any,
    );

    const sent = createMock.mock.calls[0][0];
    expect(sent.response_format).toEqual({ type: "json_object" });
    const systemMessage = sent.messages.find((m: any) => m.role === "system").content;
    // Names the exact key `parseClusters` reads — the fix for the brief's own
    // bug, which asked for a bare array instead.
    expect(systemMessage).toContain('"clusters"');
    const userMessage = sent.messages.find((m: any) => m.role === "user").content;
    // Third-party text rides in the user message, never the system one.
    expect(userMessage).toContain("Can I expense a conference?");
    expect(userMessage).toContain("Does PTO roll over to next year?");

    // And the parser half — Task 12's own code, unmocked — reads it back.
    const clusters = parseClusters(result.raw);
    expect(clusters).toEqual([
      { label: "Expense policy", members: [0, 2] },
      { label: "PTO rollover", members: [1] },
    ]);
    expect(result.model).toBe("gpt-4.1-mini");
    expect(result.tokens).toBe(160);
    // Fix round 1, finding B2/B3. 120 prompt + 40 completion, weighted via
    // `weighTokens`: 120 fresh (×1) + 40 completion (×5) = 320 — not 160,
    // which is what the unweighted figure used to be charged as.
    expect(result.weightedTokens).toBe(320);
  });

  // Fix round 1, finding B6. This test's old name — "would have parsed to
  // nothing had the prompt asked for a bare array, as the brief's did" —
  // claimed a counterfactual about the *prompt* that nothing here checks: the
  // prompt sent is not inspected, and no change to `CLUSTER_INSTRUCTION`
  // could make this test fail. What it actually pins is the parser half of
  // the old bug's failure mode — a JSON object that is not keyed `clusters`
  // parses to nothing, silently, and the tokens are still spent.
  it("parses to nothing, silently, when the reply is a JSON object not keyed `clusters`", async () => {
    // What `response_format: {type:"json_object"}` actually forces a model to
    // send when its instruction says "array": some object, not necessarily
    // one with a `clusters` key at all. This is the reply shape the bug would
    // have produced — unpredictable, and never the bare array the old prompt
    // asked for.
    createMock.mockResolvedValue({
      choices: [
        { message: { content: JSON.stringify({ result: [{ label: "x", members: [0] }] }) } },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 10 },
    });

    const result = await clusterQuestions(["one question"], { OPENAI_API_KEY: "sk-test" } as any);

    // Paid for and silently empty — exactly the failure mode the review
    // flagged: no error anywhere, and no gaps ever reported again.
    expect(parseClusters(result.raw)).toEqual([]);
    expect(result.tokens).toBe(60);
  });

  it("does not throw when the reply is not JSON at all", async () => {
    // Fix round 1, finding B5: this path logs on purpose
    // (`console.error("coverage clustering reply was not JSON", ...)`) —
    // silence it the repo's own way, and prove it still happened.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    createMock.mockResolvedValue({
      choices: [{ message: { content: "sorry, I can't do that" } }],
      usage: { prompt_tokens: 20, completion_tokens: 8 },
    });

    const result = await clusterQuestions(["one question"], { OPENAI_API_KEY: "sk-test" } as any);

    expect(parseClusters(result.raw)).toEqual([]);
    expect(result.tokens).toBe(28);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
