import { describe, it, expect, vi } from "vitest";
import { cloudflareRateLimiter } from "./cloudflare";
import { describeRateLimiterContract } from "./contract";

/**
 * A stand-in for the binding, counting the way Cloudflare's does: per key,
 * within one window. The contract test never advances time, so the window never
 * rolls over here — which is exactly the behaviour the contract asks about.
 */
function fakeBinding(limit: number): RateLimit {
  const counts = new Map<string, number>();
  return {
    async limit({ key }: { key: string }) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return { success: next <= limit };
    },
  };
}

describeRateLimiterContract("cloudflare", async (limit) =>
  cloudflareRateLimiter(fakeBinding(limit)),
);

describe("the Cloudflare limiter", () => {
  it("passes the key through to the binding untouched", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const limiter = cloudflareRateLimiter({ limit } as unknown as RateLimit);

    await limiter.check("expensive:user:abc");

    expect(limit).toHaveBeenCalledWith({ key: "expensive:user:abc" });
  });

  it("reports the configured window as the wait, since the binding does not say", async () => {
    const limiter = cloudflareRateLimiter(fakeBinding(0), 60);

    const verdict = await limiter.check("someone");
    if (verdict.allowed) throw new Error("expected a refusal");
    expect(verdict.retryAfterSeconds).toBe(60);
  });

  it("fails open when the binding throws, and says so", async () => {
    // This limiter guards a bill, not a door — every route behind it has already
    // checked a bearer token. Refusing everything because the limiter is
    // unavailable would turn someone else's outage into ours.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const limiter = cloudflareRateLimiter({
      limit: async () => {
        throw new Error("binding unavailable");
      },
    } as unknown as RateLimit);

    expect(await limiter.check("someone")).toEqual({ allowed: true });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
