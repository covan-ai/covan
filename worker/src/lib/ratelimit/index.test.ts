import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Bindings } from "../../types";
import {
  configuredLimit,
  getRateLimiter,
  resetRateLimiters,
  resetRateLimitWarnings,
  unlimitedRateLimiter,
  DEFAULT_LIMITS,
} from "./index";

const base = {} as Bindings;
const env = (over: Partial<Bindings> = {}): Bindings => ({ ...base, ...over }) as Bindings;

beforeEach(() => {
  resetRateLimiters();
  resetRateLimitWarnings();
});

describe("configuredLimit", () => {
  it("falls back to the default when nothing is set, so an unconfigured stack is still bounded", () => {
    expect(configuredLimit(env(), "standard")).toBe(DEFAULT_LIMITS.standard);
    expect(configuredLimit(env(), "expensive")).toBe(DEFAULT_LIMITS.expensive);
  });

  it("takes the operator's number", () => {
    expect(configuredLimit(env({ RATE_LIMIT_EXPENSIVE_PER_MINUTE: "5" }), "expensive")).toBe(5);
  });

  it("treats an empty string as unset, because that is what a blank .env line gives", () => {
    expect(configuredLimit(env({ RATE_LIMIT_STANDARD_PER_MINUTE: "  " }), "standard")).toBe(
      DEFAULT_LIMITS.standard,
    );
  });

  it("ignores a value that is not a non-negative number rather than removing the limit", () => {
    // A typo must not be the way a limit disappears. `0` is how you turn it off,
    // and `0` is a number.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(configuredLimit(env({ RATE_LIMIT_EXPENSIVE_PER_MINUTE: "twenty" }), "expensive")).toBe(
      DEFAULT_LIMITS.expensive,
    );
    expect(configuredLimit(env({ RATE_LIMIT_EXPENSIVE_PER_MINUTE: "-1" }), "expensive")).toBe(
      DEFAULT_LIMITS.expensive,
    );
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });
});

describe("getRateLimiter", () => {
  it("uses the binding when there is one", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const limiter = getRateLimiter(
      env({ RATE_LIMIT_EXPENSIVE: { limit } as unknown as RateLimit }),
      "expensive",
    );

    await limiter.check("someone");

    expect(limit).toHaveBeenCalledOnce();
  });

  it("does not use one tier's binding for the other tier", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const limiter = getRateLimiter(
      env({ RATE_LIMIT_EXPENSIVE: { limit } as unknown as RateLimit }),
      "standard",
    );

    await limiter.check("someone");

    expect(limit).not.toHaveBeenCalled();
  });

  it("returns the same in-process limiter across calls, or nothing is ever limited", async () => {
    // The counter lives inside the closure, so a fresh limiter per request would
    // count every request as the first one. That bug passes every test of the
    // limiter itself and shows up only as a limit that never trips.
    const e = env({ RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1" });

    expect((await getRateLimiter(e, "expensive").check("someone")).allowed).toBe(true);
    expect((await getRateLimiter(e, "expensive").check("someone")).allowed).toBe(false);
  });

  it("keeps the tiers' counters apart", async () => {
    const e = env({ RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1", RATE_LIMIT_STANDARD_PER_MINUTE: "1" });

    expect((await getRateLimiter(e, "expensive").check("someone")).allowed).toBe(true);
    expect((await getRateLimiter(e, "standard").check("someone")).allowed).toBe(true);
  });

  it("shouts when it is on Cloudflare with no binding, because the fallback there limits nothing", async () => {
    // Isolates are many and short-lived, so a per-isolate counter is close to no
    // limit at all. A deploy that forgot the [[ratelimits]] block still boots
    // and still serves — exactly the silent failure this seam exists to prevent.
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    getRateLimiter(env({ DOCS: {} as unknown as R2Bucket }), "expensive");

    expect(error).toHaveBeenCalledOnce();
    expect(error.mock.calls[0][0]).toContain("RATE_LIMIT_EXPENSIVE");
    error.mockRestore();
  });

  it("says it once per tier rather than on every request", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const e = env({ DOCS: {} as unknown as R2Bucket });

    getRateLimiter(e, "expensive");
    getRateLimiter(e, "expensive");
    getRateLimiter(e, "standard");

    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it("stays quiet on Node, where the in-process counter is the right answer", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    getRateLimiter(env({ DOCS_DIR: "/data/docs" }), "expensive");

    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("allows everything at a limit of 0, which is how an operator defers to their own proxy", async () => {
    const limiter = getRateLimiter(env({ RATE_LIMIT_STANDARD_PER_MINUTE: "0" }), "standard");
    expect(limiter).toBe(unlimitedRateLimiter);
    for (let i = 0; i < 50; i++) {
      expect((await limiter.check("someone")).allowed).toBe(true);
    }
  });
});
