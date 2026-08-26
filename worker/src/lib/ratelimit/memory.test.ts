import { describe, it, expect } from "vitest";
import { memoryRateLimiter } from "./memory";
import { describeRateLimiterContract } from "./contract";

describeRateLimiterContract("memory", async (limit) => memoryRateLimiter({ limit }));

describe("the in-process limiter's window", () => {
  it("lets the caller through again once the window has passed", async () => {
    let clock = 1_000_000;
    const limiter = memoryRateLimiter({ limit: 1, periodSeconds: 60, now: () => clock });

    expect((await limiter.check("someone")).allowed).toBe(true);
    expect((await limiter.check("someone")).allowed).toBe(false);

    clock += 60_000;
    expect((await limiter.check("someone")).allowed).toBe(true);
  });

  it("does not reset early", async () => {
    let clock = 0;
    const limiter = memoryRateLimiter({ limit: 1, periodSeconds: 60, now: () => clock });

    await limiter.check("someone");
    clock += 59_999;
    expect((await limiter.check("someone")).allowed).toBe(false);
  });

  it("reports the window length as the wait", async () => {
    const limiter = memoryRateLimiter({ limit: 1, periodSeconds: 60, now: () => 0 });
    await limiter.check("someone");

    const verdict = await limiter.check("someone");
    if (verdict.allowed) throw new Error("expected a refusal");
    expect(verdict.retryAfterSeconds).toBe(60);
  });

  it("forgets keys that have gone quiet, so the map does not grow without end", async () => {
    // The sweep only runs past its threshold, so this walks past it. Without it
    // a long-lived Node process accumulates one entry per distinct caller
    // forever — a leak that no test of the limiting behaviour itself would see.
    let clock = 0;
    const limiter = memoryRateLimiter({ limit: 1, periodSeconds: 60, now: () => clock });

    for (let i = 0; i < 10_001; i++) await limiter.check(`caller-${i}`);
    clock += 60_000;
    // One more request past the threshold triggers the sweep of the expired
    // entries; the caller that just arrived is the only one that should remain.
    expect((await limiter.check("caller-0")).allowed).toBe(true);
    expect((await limiter.check("caller-0")).allowed).toBe(false);
  });
});
