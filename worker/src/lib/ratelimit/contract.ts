import { describe, it, expect } from "vitest";
import type { RateLimiter } from "./types";

/**
 * The behaviour every RateLimiter owes its callers. Both cloudflare.test.ts and
 * memory.test.ts call this, so the two implementations cannot drift apart —
 * which is the whole risk of running one codebase on two runtimes, and a worse
 * risk here than for documents: a limiter that behaves differently under Docker
 * than on Cloudflare is a limit the operator thinks they have.
 *
 * `make` is given the limit so each implementation can be built the way its own
 * runtime configures one — from a binding, or from a number.
 */
export function describeRateLimiterContract(
  name: string,
  make: (limit: number) => Promise<RateLimiter>,
) {
  describe(`RateLimiter contract: ${name}`, () => {
    it("allows requests up to the limit", async () => {
      const limiter = await make(3);
      for (let i = 0; i < 3; i++) {
        expect(await limiter.check("someone")).toEqual({ allowed: true });
      }
    });

    it("refuses the one after, and says how long to wait", async () => {
      const limiter = await make(2);
      await limiter.check("someone");
      await limiter.check("someone");

      const verdict = await limiter.check("someone");
      expect(verdict.allowed).toBe(false);
      if (verdict.allowed) throw new Error("unreachable");
      expect(verdict.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("counts each key separately, so one caller cannot exhaust another's allowance", async () => {
      const limiter = await make(1);
      expect(await limiter.check("first")).toEqual({ allowed: true });
      expect(await limiter.check("second")).toEqual({ allowed: true });
      expect((await limiter.check("first")).allowed).toBe(false);
    });

    it("keeps refusing while the window holds, rather than letting every other request through", async () => {
      const limiter = await make(1);
      await limiter.check("someone");
      expect((await limiter.check("someone")).allowed).toBe(false);
      expect((await limiter.check("someone")).allowed).toBe(false);
    });
  });
}
