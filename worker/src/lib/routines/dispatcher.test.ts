// worker/src/lib/routines/dispatcher.test.ts
import { describe, it, expect, vi } from "vitest";
import { runDueRoutines, runOneRoutine } from "./dispatcher";

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
      in: async () => ({ data: connected.map((workspace_id) => ({ workspace_id })), error: null }),
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
    const db = { rpc, from: () => ({ select: () => ({ in: inFilter }) }) };

    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 0 });
    await runDueRoutines(env, { db: db as any, runRoutine });

    expect(inFilter).toHaveBeenCalledTimes(1);
  });

  it("runs the tick as it always did when that read fails", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1")], error: null });
    const db = {
      rpc,
      from: () => ({
        select: () => ({ in: async () => ({ data: null, error: { message: "gone" } }) }),
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
