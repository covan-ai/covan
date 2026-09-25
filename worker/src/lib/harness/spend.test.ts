import { describe, it, expect, vi, beforeEach } from "vitest";
import { runtimeLimitFlag } from "../runtime-limit";
import type { ToolContext } from "./registry";

/**
 * The allowance check in front of a connected-service call, and the one
 * failure it is not allowed to forgive.
 *
 * `affordable` deliberately lets a broken quota read through: the counter
 * lives in the database everything else lives in, so a read failure means the
 * app is already in trouble and refusing every action on top of that turns a
 * billing inconvenience into an outage. That argument holds for a database
 * that is down. It does not hold when the read failed because the invocation
 * is out of subrequests, because then the call being guarded is a `fetch` that
 * cannot go out either — allowing it buys a certain failure one step later,
 * with a worse message.
 */
const check = vi.fn();
const record = vi.fn();

vi.mock("../entitlements", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../entitlements")>();
  return {
    ...actual,
    entitlementsFor: () => ({
      check: (userId: string) => check(userId),
      record: (userId: string, tokens: number) => record(userId, tokens),
      snapshot: async () => ({ used: 0, limit: null, resetsAt: null }),
    }),
  };
});

const { affordable, spend } = await import("./spend");

function ctxWith(): ToolContext {
  return {
    env: {},
    userId: "user-1",
    runtimeLimit: runtimeLimitFlag(),
  } as unknown as ToolContext;
}

const SUBREQUESTS = new Error(
  "user_usage read failed: Error: Too many subrequests by single Worker invocation.",
);

beforeEach(() => {
  check.mockReset();
  record.mockReset();
});

describe("affordable", () => {
  it("says nothing and goes ahead when there is allowance left", async () => {
    check.mockResolvedValue({ allowed: true });
    expect(await affordable(ctxWith())).toBeNull();
  });

  it("refuses in words a model can repeat when the allowance is gone", async () => {
    check.mockResolvedValue({ allowed: false, used: 10, limit: 10, resetsAt: "2026-10-01" });
    const out = await affordable(ctxWith());
    expect(out?.kind).toBe("error");
    expect(out?.kind === "error" && out.message).toContain("used its allowance");
  });

  it("forgives a broken quota read, which is the older and still-right rule", async () => {
    check.mockRejectedValue(new Error("relation does not exist"));
    const ctx = ctxWith();
    expect(await affordable(ctx)).toBeNull();
    expect(ctx.runtimeLimit?.hit).toBe(false);
  });

  it("refuses when the read failed because the invocation is out of subrequests", async () => {
    check.mockRejectedValue(SUBREQUESTS);
    const ctx = ctxWith();
    const out = await affordable(ctx);

    expect(out?.kind).toBe("error");
    expect(out?.kind === "error" && out.message).toContain("used up the requests");
    // And the fact is carried out of here, because the route that has to
    // explain the turn will only ever see `Connection error.` by then.
    expect(ctx.runtimeLimit?.hit).toBe(true);
  });

  it("survives a turn that carries no flag, which a scheduled run does not", async () => {
    check.mockRejectedValue(SUBREQUESTS);
    const ctx = { env: {}, userId: "user-1" } as unknown as ToolContext;
    expect((await affordable(ctx))?.kind).toBe("error");
  });
});

describe("spend", () => {
  it("records what the call cost", async () => {
    record.mockResolvedValue(undefined);
    await spend(ctxWith(), 1000);
    expect(record).toHaveBeenCalledWith("user-1", 1000);
  });

  it("never throws, because the money is already spent", async () => {
    record.mockRejectedValue(new Error("write failed"));
    await expect(spend(ctxWith(), 1000)).resolves.toBeUndefined();
  });

  it("raises the flag when the write could not be made for the same reason", async () => {
    record.mockRejectedValue(SUBREQUESTS);
    const ctx = ctxWith();
    await spend(ctx, 1000);
    expect(ctx.runtimeLimit?.hit).toBe(true);
  });
});
