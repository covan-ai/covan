import { describe, expect, it, vi } from "vitest";
import { warnIfLow, WARN_AT } from "./warn";

/**
 * The warning that arrives before the allowance is gone.
 *
 * Until this existed the first thing anybody heard about their quota was a
 * refusal — `guardQuota` answering 402 in the middle of a conversation. The
 * screen has shown a "low" state at three quarters spent since `lib/quota.ts`
 * was written; this is the same threshold, said out loud, once.
 *
 * `WARN_AT` is imported rather than repeated so the two cannot drift into
 * disagreeing about what "low" means.
 */
const PERIOD = "2026-10-01T00:00:00.000Z";

function ctx(options: {
  used: number;
  limit: number | null;
  warnedFor?: string | null;
  quotaExhausted?: boolean;
  sent?: Array<Record<string, unknown>>;
  upserts?: Array<Record<string, unknown>>;
}) {
  const prefs = {
    quota_exhausted: options.quotaExhausted ?? true,
    quota_warned_for: options.warnedFor ?? null,
  };

  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: prefs, error: null }) }),
      }),
      upsert: async (values: Record<string, unknown>) => {
        options.upserts?.push(values);
        return { error: null };
      },
    }),
  };

  return {
    env: {
      RESEND_API_KEY: "re_test",
      RESEND_FROM: "Covan <x@y.z>",
      ALLOWED_ORIGIN: "https://c.app",
    },
    get: (key: string) =>
      key === "user"
        ? { id: "u1", email: "someone@example.com" }
        : key === "db"
          ? db
          : {
              snapshot: async () => ({
                used: options.used,
                limit: options.limit,
                resetsAt: PERIOD,
              }),
            },
  } as never;
}

function captureSends(sent: Array<Record<string, unknown>>) {
  vi.spyOn(globalThis, "fetch").mockImplementation((async (_i: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch);
}

describe("warnIfLow", () => {
  it("warns once the allowance is mostly spent", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const upserts: Array<Record<string, unknown>> = [];
    captureSends(sent);

    await warnIfLow(ctx({ used: Math.ceil(1000 * WARN_AT), limit: 1000, sent, upserts }));

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual(["someone@example.com"]);
    // The period is stamped so the next reply does not send a second one.
    expect(upserts[0]).toMatchObject({ user_id: "u1", quota_warned_for: PERIOD });
  });

  it("stays quiet while there is plenty left", async () => {
    const sent: Array<Record<string, unknown>> = [];
    captureSends(sent);

    await warnIfLow(ctx({ used: 100, limit: 1000, sent }));

    expect(sent).toEqual([]);
  });

  // The condition stays true for every request after the threshold, which is
  // exactly why the stamp exists: without it the warning becomes one message
  // per reply until the period rolls over.
  it("does not warn twice in the same period", async () => {
    const sent: Array<Record<string, unknown>> = [];
    captureSends(sent);

    await warnIfLow(ctx({ used: 900, limit: 1000, warnedFor: PERIOD, sent }));

    expect(sent).toEqual([]);
  });

  it("warns again once the period has rolled over", async () => {
    const sent: Array<Record<string, unknown>> = [];
    captureSends(sent);

    await warnIfLow(ctx({ used: 900, limit: 1000, warnedFor: "2026-09-01T00:00:00.000Z", sent }));

    expect(sent).toHaveLength(1);
  });

  // `limit: null` is what the open build's `unlimitedEntitlements` answers. A
  // self-hosted Covan brings its own OpenAI key and has no allowance to warn
  // about, so this whole feature has to be silent there.
  it("says nothing when there is no allowance at all", async () => {
    const sent: Array<Record<string, unknown>> = [];
    captureSends(sent);

    await warnIfLow(ctx({ used: 999_999, limit: null, sent }));

    expect(sent).toEqual([]);
  });

  // One question, one switch. `quota_exhausted` already means "tell me about my
  // allowance"; asking people to answer that twice would be the design mistake.
  it("respects the switch that already governs quota notices", async () => {
    const sent: Array<Record<string, unknown>> = [];
    captureSends(sent);

    await warnIfLow(ctx({ used: 900, limit: 1000, quotaExhausted: false, sent }));

    expect(sent).toEqual([]);
  });
});
