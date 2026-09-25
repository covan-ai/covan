import { describe, it, expect } from "vitest";
import { isRuntimeLimit, runtimeLimitFlag } from "./runtime-limit";

/**
 * The one thing this heuristic must get right, in both directions.
 *
 * A false positive tells somebody to narrow a question when the network
 * blipped, which sends them chasing the wrong fix. A false negative is
 * today's behaviour — "The assistant hit an error" — which is what this
 * exists to replace. The first is worse, so the signatures stay literal
 * rather than clever.
 */
describe("isRuntimeLimit", () => {
  it("knows Cloudflare's own words for running out of subrequests", () => {
    expect(
      isRuntimeLimit(
        new Error(
          "Too many subrequests by single Worker invocation. To configure this limit, " +
            "refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits",
        ),
      ),
    ).toBe(true);
  });

  it("sees through a wrapper, which is how it actually arrives", () => {
    // The real one, from production on 2026-09-24: the entitlements layer
    // catches the platform error and rethrows it with its own prefix.
    expect(
      isRuntimeLimit(
        new Error(
          "user_usage read failed: Error: Too many subrequests by single Worker invocation.",
        ),
      ),
    ).toBe(true);
  });

  it("does not claim a genuinely failed connection", () => {
    // The OpenAI SDK's word for any failed fetch. It is what a subrequest
    // exhaustion looks like from one layer up — which is exactly why this
    // must NOT match it. Guessing from here is what produced two wrong
    // diagnoses in one evening; the flag carries the fact instead.
    expect(isRuntimeLimit(new Error("Connection error."))).toBe(false);
  });

  it("does not claim an ordinary failure", () => {
    expect(isRuntimeLimit(new Error("relation does not exist"))).toBe(false);
    expect(isRuntimeLimit(new Error("fetch failed"))).toBe(false);
    expect(isRuntimeLimit(null)).toBe(false);
    expect(isRuntimeLimit(undefined)).toBe(false);
    expect(isRuntimeLimit({})).toBe(false);
  });

  it("reads a bare string, since not everything thrown is an Error", () => {
    expect(isRuntimeLimit("Too many subrequests")).toBe(true);
    expect(isRuntimeLimit("something else")).toBe(false);
  });

  it("does not care how the platform capitalises it", () => {
    expect(isRuntimeLimit(new Error("TOO MANY SUBREQUESTS"))).toBe(true);
  });
});

describe("runtimeLimitFlag", () => {
  it("starts down, and is its own object per turn", () => {
    const a = runtimeLimitFlag();
    const b = runtimeLimitFlag();
    expect(a.hit).toBe(false);
    a.hit = true;
    expect(b.hit).toBe(false);
  });
});
