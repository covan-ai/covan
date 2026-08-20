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

const dueRow = (id: string) => ({ id, schedule_cron: "*/15 * * * *", timezone: "UTC" });

describe("runDueRoutines", () => {
  it("claims a bounded batch and runs each claimed routine", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1"), dueRow("r2")], error: null });
    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 1 });

    const out = await runDueRoutines(env, { db: { rpc } as any, runRoutine });

    expect(rpc).toHaveBeenCalledWith("claim_due_routines", { p_limit: 4 });
    expect(runRoutine).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ claimed: 2, ok: 2, failed: 0 });
  });

  it("keeps the batch inside the Workers Free subrequest budget", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });

    await runDueRoutines(env, { db: { rpc } as any, runRoutine: vi.fn() });

    // A tick spends 1 subrequest on the claim RPC and up to 12 per routine.
    // Workers Free allows 50 per invocation, so raising the batch without
    // moving to Workers Paid must fail here rather than in production.
    const [, args] = rpc.mock.calls[0];
    expect(1 + args.p_limit * 12).toBeLessThanOrEqual(50);
  });

  it("does nothing when nothing is due", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    const runRoutine = vi.fn();

    const out = await runDueRoutines(env, { db: { rpc } as any, runRoutine });

    expect(runRoutine).not.toHaveBeenCalled();
    expect(out).toEqual({ claimed: 0, ok: 0, failed: 0 });
  });

  it("keeps going when one routine throws, so a bad row cannot stall the tick", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1"), dueRow("r2")], error: null });
    const runRoutine = vi
      .fn()
      .mockRejectedValueOnce(new Error("kaboom"))
      .mockResolvedValueOnce({ status: "ok", itemsNew: 1 });

    const out = await runDueRoutines(env, { db: { rpc } as any, runRoutine });

    expect(out).toEqual({ claimed: 2, ok: 1, failed: 1 });
  });

  it("throws when the claim itself fails", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "no such function" } });
    await expect(runDueRoutines(env, { db: { rpc } as any, runRoutine: vi.fn() })).rejects.toThrow(
      /no such function/,
    );
  });

  it("hands down a bound fetch rather than the bare global", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1")], error: null });
    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 0 });

    await runDueRoutines(env, { db: { rpc } as any, runRoutine });

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

    await runDueRoutines(envWithWorkerHost, { db: { rpc } as any, runRoutine });

    const deps = runRoutine.mock.calls[0][1];
    expect(deps.fetchDeps.ownHosts).toEqual(["app.example.com", "api.example.com"]);
  });

  it("drops a malformed ownHosts entry instead of throwing", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [dueRow("r1")], error: null });
    const runRoutine = vi.fn().mockResolvedValue({ status: "ok", itemsNew: 0 });
    const envWithBadHost = { ...env, WORKER_HOST: "not a valid host :://" };

    const out = await runDueRoutines(envWithBadHost, { db: { rpc } as any, runRoutine });

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

    const out = await runOneRoutine(env, dueRow("r1") as any, { db: { rpc } as any, runRoutine });

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
