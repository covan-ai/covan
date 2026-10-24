import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RoutineEnv } from "../../types";
import type { CreditSnapshot, Entitlements } from "../entitlements";
import { paidRunCeiling, RUNAWAY_COST_CAP_USD } from "./ceiling";
import { conversationRun } from "./outcome";

/** Four credits to the dollar: an invented rate, not the hosted one. */
function metered(
  snapshot: Partial<Extract<CreditSnapshot, { metered: true }>>,
  quote: ((usd: number) => number) | null = (usd) => usd * 4,
): Pick<Entitlements, "snapshot" | "quote"> {
  return {
    snapshot: async () => ({
      metered: true,
      balance: 0,
      granted: 0,
      spent: 0,
      unlimited: false,
      replies: 0,
      ...snapshot,
    }),
    ...(quote ? { quote } : {}),
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("paidRunCeiling", () => {
  it("is the provider cost the balance above the floor still covers", async () => {
    expect(await paidRunCeiling(metered({ balance: 3, floor: 1 }), "ws-1")).toBe(0.5);
  });

  it("rounds down to the cent", async () => {
    expect(await paidRunCeiling(metered({ balance: 1 }), "ws-1")).toBe(0.25);
    expect(await paidRunCeiling(metered({ balance: 0.07 }), "ws-1")).toBe(0.01);
  });

  it("never asks the provider for less than a cent, even at or below the floor", async () => {
    expect(await paidRunCeiling(metered({ balance: 1, floor: 2 }), "ws-1")).toBe(0.01);
  });

  it("is the runaway ceiling when the balance covers more", async () => {
    expect(await paidRunCeiling(metered({ balance: 10_000 }), "ws-1")).toBe(RUNAWAY_COST_CAP_USD);
  });

  it("is the runaway ceiling where nothing is metered, or nobody is charged", async () => {
    const open = { snapshot: async (): Promise<CreditSnapshot> => ({ metered: false }) };
    expect(await paidRunCeiling(open, "ws-1")).toBe(RUNAWAY_COST_CAP_USD);
    expect(await paidRunCeiling(metered({ balance: 1, unlimited: true }), "ws-1")).toBe(
      RUNAWAY_COST_CAP_USD,
    );
  });

  it("is the runaway ceiling when there is no rate to convert with", async () => {
    expect(await paidRunCeiling(metered({ balance: 1 }, null), "ws-1")).toBe(RUNAWAY_COST_CAP_USD);
    expect(
      await paidRunCeiling(
        metered({ balance: 1 }, () => 0),
        "ws-1",
      ),
    ).toBe(RUNAWAY_COST_CAP_USD);
  });

  it("is the runaway ceiling, not a refusal, when the balance cannot be read", async () => {
    const broken = {
      snapshot: async (): Promise<CreditSnapshot> => {
        throw new Error("ledger down");
      },
      quote: (usd: number) => usd * 4,
    };
    expect(await paidRunCeiling(broken, "ws-1")).toBe(RUNAWAY_COST_CAP_USD);
  });
});

describe("conversationRun's ceiling", () => {
  const ENV = { BROWSER_USE_API_KEY: "bu_test" } as RoutineEnv;

  it("sends the ceiling it is given, and tells the run to hurry only when it is tight", () => {
    const roomy = conversationRun(ENV, { task: "t", maxCostUsd: RUNAWAY_COST_CAP_USD });
    expect(roomy.maxCostUsd).toBe(RUNAWAY_COST_CAP_USD);
    expect(roomy.task).not.toContain("Your budget is small");

    const tight = conversationRun(ENV, { task: "t", maxCostUsd: 0.2 });
    expect(tight.maxCostUsd).toBe(0.2);
    expect(tight.task).toContain("Your budget is small");
  });

  it("keeps the free retry on its own ceiling, whatever it is given", () => {
    const retry = conversationRun(ENV, { task: "t", freeRetry: true, maxCostUsd: 3 });
    expect(retry.maxCostUsd).toBe(0.1);
    expect(retry.task).toContain("Your budget is small");
  });
});
