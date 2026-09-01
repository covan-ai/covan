import { describe, it, expect, vi } from "vitest";

// `quota.ts` exports hooks as well as arithmetic, so importing it reaches
// `api-client`, which builds a Supabase client from `VITE_*` at import time and
// throws when they are unset. Nothing below calls the API — every test here is
// a pure function of one response object — so the transport is stubbed rather
// than configured.
vi.mock("./api-client", () => ({ api: {} }));

import { quotaFrom, quotaSentence, approximateReplies } from "./quota";
import type { UsageResponse } from "./api-client";

/*
 * The allowance, as a number a person is asked to believe.
 *
 * The bug that prompted these tests was not an arithmetic error — both halves
 * of the estimate were defensible on their own. It was a seam: the banner said
 * "about 81 replies left" before the first message and "about 801" after it,
 * and a figure that improves tenfold for no reason the reader can see is worse
 * than no figure at all.
 */

const LIMIT = 300_000;

function usage(over: {
  used?: number;
  messageCount?: number;
  totalTokens?: number;
  resetsAt?: string | null;
}): UsageResponse {
  return {
    agents: [],
    quota: { used: over.used ?? 0, limit: LIMIT, resetsAt: over.resetsAt ?? null },
    totals: {
      messageCount: over.messageCount ?? 0,
      promptTokens: 0,
      cachedTokens: 0,
      measuredPromptTokens: 0,
      completionTokens: 0,
      totalTokens: over.totalTokens ?? 0,
      estCostUsd: 0,
    },
  };
}

describe("the estimate before and after the first reply", () => {
  it("does not multiply tenfold when one cheap reply arrives", () => {
    // The measured production case, as one assertion. A first question to a
    // brand-new agent with no documents is the cheapest message that account
    // will ever send, so a sample of one is drawn from the bottom of a range
    // that spans more than an order of magnitude.
    const before = quotaFrom(usage({}))!;
    const after = quotaFrom(usage({ used: 370, messageCount: 1, totalTokens: 370 }))!;

    expect(before.repliesLeft).toBe(81);
    // It may move — the estimate getting better is the point — but not by the
    // 10x that made it read as a correction rather than a refinement.
    expect(after.repliesLeft).toBeLessThan(before.repliesLeft * 2);
  });

  it("keeps moving towards what the replies actually cost", () => {
    // The prior is outvoted, not permanent. Same cheap 370-token replies, more
    // of them, and the figure climbs steadily rather than in one jump.
    const at = (n: number) =>
      quotaFrom(usage({ used: 370 * n, messageCount: n, totalTokens: 370 * n }))!.repliesLeft;

    expect(at(1)).toBeLessThan(at(10));
    expect(at(10)).toBeLessThan(at(50));
    expect(at(50)).toBeLessThan(at(200));
  });

  it("ends up essentially the caller's own average once there is a real sample", () => {
    // 200 replies at 370 tokens: the five-reply prior is 2.4% of the weight, so
    // the estimate is theirs. Anything much wider than this would mean the
    // prior never really lets go.
    const q = quotaFrom(usage({ used: 74_000, messageCount: 200, totalTokens: 74_000 }))!;
    expect(q.perReply).toBeGreaterThan(370);
    expect(q.perReply).toBeLessThan(370 * 1.3);
  });

  it("uses the assumption alone before anything has been sent", () => {
    const q = quotaFrom(usage({}))!;
    expect(q.perReply).toBe(3700);
    expect(q.repliesSeen).toBe(0);
  });

  it("ignores a message count with no tokens behind it", () => {
    // Replies stored before token accounting existed report a count and no
    // total. Dividing by them would drag the average towards zero and promise
    // an allowance nobody has.
    const q = quotaFrom(usage({ messageCount: 40, totalTokens: 0 }))!;
    expect(q.perReply).toBe(3700);
    expect(q.repliesSeen).toBe(0);
  });
});

describe("how precisely the number is stated", () => {
  it("rounds away a digit it does not mean", () => {
    expect(approximateReplies(801)).toBe(800);
    expect(approximateReplies(437)).toBe(440);
    expect(approximateReplies(81)).toBe(81);
  });

  it("stays exact where the number is something to plan around", () => {
    // Below twenty it stops being reassurance. "About 5 replies left" and
    // "about 10" are different pieces of news.
    for (const n of [0, 1, 3, 7, 19]) expect(approximateReplies(n)).toBe(n);
  });

  it("never rounds the low-band sentence, which is the one people act on", () => {
    const q = quotaFrom(usage({ used: LIMIT - 8_000, messageCount: 60, totalTokens: 222_000 }))!;
    expect(q.level).toBe("low");
    expect(quotaSentence(q)).toContain(`About ${q.repliesLeft} `);
  });
});

describe("what the banner says", () => {
  it("says the allowance is gone rather than counting to zero", () => {
    const q = quotaFrom(usage({ used: LIMIT, resetsAt: "2026-10-01T00:00:00.000Z" }))!;
    expect(q.level).toBe("spent");
    expect(quotaSentence(q)).toContain("used up");
  });

  it("says nothing at all for an install with no allowance", () => {
    // Self-hosted brings its own OpenAI key, and `limit: null` is how the API
    // says so. Every caller can then render nothing on one check.
    const selfHosted = { ...usage({}), quota: { used: 0, limit: null, resetsAt: null } };
    expect(quotaFrom(selfHosted)).toBeNull();
  });
});
