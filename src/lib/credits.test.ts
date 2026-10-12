import { describe, it, expect, vi } from "vitest";

// `credits.ts` exports hooks as well as arithmetic, so importing it reaches
// `api-client`, which builds a Supabase client from `VITE_*` at import time and
// throws when they are unset. Nothing below calls the API — every test here is
// a pure function of one response object — so the transport is stubbed rather
// than configured.
vi.mock("./api-client", () => ({ api: {} }));

import { creditsFrom, creditsSentence, approximateReplies, LOW_BALANCE_CREDITS } from "./credits";
import type { CreditSnapshot, UsageResponse } from "./api-client";

const TOTALS = {
  messageCount: 0,
  promptTokens: 0,
  cachedTokens: 0,
  cacheWriteTokens: 0,
  measuredPromptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estCostUsd: 0,
};

function usage(credits: CreditSnapshot): UsageResponse {
  return { agents: [], credits, totals: TOTALS };
}

function metered(over: Partial<Extract<CreditSnapshot, { metered: true }>> = {}): UsageResponse {
  return usage({
    metered: true,
    balance: 500,
    granted: 500,
    spent: 0,
    unlimited: false,
    replies: 0,
    ...over,
  });
}

describe("what there is to show", () => {
  it("shows nothing on a self-hosted install", () => {
    expect(creditsFrom(usage({ metered: false }))).toBeNull();
  });

  it("shows nothing for a house workspace, which has no balance to watch", () => {
    expect(creditsFrom(metered({ unlimited: true, balance: 0 }))).toBeNull();
  });

  it("shows nothing before the figure has arrived", () => {
    expect(creditsFrom(undefined)).toBeNull();
  });
});

describe("the estimate before and after the first reply", () => {
  it("starts from the assumption, two credits a reply", () => {
    expect(creditsFrom(metered())!.repliesLeft).toBe(250);
  });

  it("does not multiply tenfold when one cheap reply arrives", () => {
    // A first question to an agent with no documents is the cheapest message an
    // account will ever send. A sample of one is drawn from the bottom of the
    // range, and it must not replace the middle of it.
    const before = creditsFrom(metered())!;
    const after = creditsFrom(metered({ balance: 499.9, spent: 0.1, replies: 1 }))!;
    expect(after.repliesLeft).toBeLessThan(before.repliesLeft * 2);
  });

  it("keeps moving towards what this workspace's replies actually cost", () => {
    const at = (n: number) =>
      creditsFrom(metered({ balance: 500 - 0.1 * n, spent: 0.1 * n, replies: n }))!.repliesLeft;
    expect(at(1)).toBeLessThan(at(10));
    expect(at(10)).toBeLessThan(at(50));
    expect(at(50)).toBeLessThan(at(200));
  });
});

describe("levels", () => {
  it("is fine with a healthy balance", () => {
    expect(creditsFrom(metered())!.level).toBe("fine");
  });

  it("is low under the warning line", () => {
    expect(creditsFrom(metered({ balance: LOW_BALANCE_CREDITS - 1, spent: 451 }))!.level).toBe(
      "low",
    );
  });

  it("is spent at zero, and at the overshoot below it", () => {
    expect(creditsFrom(metered({ balance: 0, spent: 500 }))!.level).toBe("spent");
    const over = creditsFrom(metered({ balance: -0.4, spent: 500.4 }))!;
    expect(over.level).toBe("spent");
    // Never "-0.4 credits left" on a screen.
    expect(over.balance).toBe(0);
    expect(over.repliesLeft).toBe(0);
    expect(over.ratio).toBe(0);
  });
});

describe("creditsSentence", () => {
  it("says the balance and the replies it is worth", () => {
    expect(creditsSentence(creditsFrom(metered({ balance: 412.7, spent: 87.3 }))!)).toMatch(
      /^412 credits left · about \d+ replies$/,
    );
  });

  it("says plainly when the workspace is out", () => {
    expect(creditsSentence(creditsFrom(metered({ balance: 0, spent: 500 }))!)).toBe(
      "This workspace is out of credits.",
    );
  });

  it("never mentions a reset, because there is none", () => {
    expect(creditsSentence(creditsFrom(metered({ balance: 10, spent: 490 }))!)).not.toMatch(
      /reset|month/i,
    );
  });
});

describe("approximateReplies", () => {
  it("stays exact below twenty", () => {
    expect(approximateReplies(17)).toBe(17);
  });

  it("rounds to two significant figures above it", () => {
    expect(approximateReplies(801)).toBe(800);
    expect(approximateReplies(2468)).toBe(2500);
  });
});
