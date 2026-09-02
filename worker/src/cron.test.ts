// worker/src/cron.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const { runScheduledWork } = vi.hoisted(() => ({ runScheduledWork: vi.fn() }));
vi.mock("./lib/background", () => ({ runScheduledWork }));

import cron from "./cron";

const env = {
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  OPENAI_API_KEY: "sk-test",
  ROUTINE_SECRET_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Routines <routines@example.com>",
  ALLOWED_ORIGIN: "https://app.example.com",
} as const;

const ctx = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() });

describe("cron worker", () => {
  beforeEach(() => {
    runScheduledWork.mockReset();
  });

  it("runs a tick and hands the promise to waitUntil", async () => {
    runScheduledWork.mockResolvedValue(undefined);
    const c = ctx();

    cron.scheduled({} as ScheduledEvent, env, c as unknown as ExecutionContext);

    expect(runScheduledWork).toHaveBeenCalledWith(env);
    // Without waitUntil the runtime is free to kill the invocation the moment
    // scheduled() returns, which for an async tick means it never finishes.
    expect(c.waitUntil).toHaveBeenCalledTimes(1);
    await expect(c.waitUntil.mock.calls[0][0]).resolves.toBeUndefined();
  });

  it("lets a failed tick reject so Cloudflare records the invocation as failed", async () => {
    runScheduledWork.mockRejectedValue(new Error("claim_due_routines failed"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = ctx();

    cron.scheduled({} as ScheduledEvent, env, c as unknown as ExecutionContext);

    // A swallowed error would show up as a green invocation on the dashboard —
    // the engine could then be dead for days without anything looking wrong.
    await expect(c.waitUntil.mock.calls[0][0]).rejects.toThrow("claim_due_routines failed");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
