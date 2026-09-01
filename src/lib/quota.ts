import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type UsageResponse } from "./api-client";

/**
 * The monthly allowance, in the terms an interface needs to show it.
 *
 * `null` means there is nothing to show — a self-hosted Covan brings its own
 * OpenAI key and has no allowance, and the API says so with `limit: null`. Every
 * caller can therefore render nothing on a single check, and none of them has
 * to know that hosted and self-hosted differ.
 */
export type QuotaView = {
  used: number;
  limit: number;
  /** 0–1, clamped: usage can legitimately overshoot the limit by one operation. */
  ratio: number;
  /** Cost per reply, mostly the caller's own once they have sent a few — see the note below. */
  perReply: number;
  repliesLeft: number;
  /** How many replies the estimate has actually seen. 0 before the first one. */
  repliesSeen: number;
  /** Localised day and month, e.g. "1 September". `null` if the API omitted it. */
  resetsOn: string | null;
  level: "fine" | "low" | "spent";
};

/**
 * Before anyone has sent a message there is no average to work from. Anything
 * chosen here is a guess; this one is the middle of what real conversations
 * have cost.
 */
const ASSUMED_TOKENS_PER_REPLY = 3700;

/**
 * How many replies the assumption above is worth, weighed against real ones.
 *
 * This exists because switching outright from the assumption to the measurement
 * produced a number nobody could believe: the banner said **about 81 replies
 * left**, and after a single reply it said **about 801**. Nothing was bought
 * and nothing was refunded.
 *
 * Neither half was wrong. 3,700 is the middle of what real conversations cost,
 * and a person's own average is a better guide to their next reply than anybody
 * else's. The fault was the seam. A first question to a brand-new agent with no
 * documents is the cheapest message that account will ever send — one measured
 * at 101 tokens — so a sample of one is drawn from the bottom of a range that
 * spans more than an order of magnitude, and it was replacing a constant drawn
 * from the middle. Every new account meets that seam, because everybody has a
 * first reply.
 *
 * So the assumption is not replaced, it is outvoted: it counts as five replies,
 * and real ones dilute it. The estimate still ends up entirely the caller's own
 * — after fifty replies the prior is a tenth of the weight — it just gets there
 * in steps a person can follow instead of in one jump of 10x.
 */
const PRIOR_REPLIES = 5;

/**
 * Round to two significant figures once the number is big enough that the last
 * digit is noise.
 *
 * "About 801 replies" claims a precision the estimate does not have, and worse,
 * it makes the estimate improving look like an arithmetic correction. Below
 * twenty it stays exact, because that is where the number stops being
 * reassurance and starts being something to plan around.
 */
export function approximateReplies(n: number): number {
  if (n < 20) return n;
  const magnitude = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / magnitude) * magnitude;
}

export function quotaFrom(usage: UsageResponse | undefined): QuotaView | null {
  const quota = usage?.quota;
  if (!quota || quota.limit === null || quota.limit <= 0) return null;

  // Replies, not tokens, because nobody budgets in tokens — and the conversion
  // leans on THIS user's own replies rather than on a constant. What a reply
  // costs varies by more than an order of magnitude: a first question to an
  // agent with no documents measured 101 tokens, while a long conversation
  // grounded in uploads averaged 5,335. `totals` is already scoped by row level
  // security to the caller's own conversations, so it is their average and
  // nobody else's.
  //
  // Weighed against the assumption rather than replacing it — see PRIOR_REPLIES
  // for why, and for the 81-to-801 jump that made it necessary.
  const seen = usage?.totals;
  const repliesSeen = seen && seen.totalTokens > 0 ? Math.max(0, seen.messageCount) : 0;
  const perReply = Math.max(
    1,
    Math.round(
      (ASSUMED_TOKENS_PER_REPLY * PRIOR_REPLIES + (seen?.totalTokens ?? 0)) /
        (PRIOR_REPLIES + repliesSeen),
    ),
  );

  const ratio = Math.min(quota.used / quota.limit, 1);
  const repliesLeft = Math.max(0, Math.floor((quota.limit - quota.used) / perReply));
  const resetsOn = quota.resetsAt
    ? new Date(quota.resetsAt).toLocaleDateString(undefined, { month: "long", day: "numeric" })
    : null;

  const level: QuotaView["level"] =
    quota.used >= quota.limit ? "spent" : ratio >= 0.75 || repliesLeft <= 3 ? "low" : "fine";

  return {
    used: quota.used,
    limit: quota.limit,
    ratio,
    perReply,
    repliesLeft,
    repliesSeen,
    resetsOn,
    level,
  };
}

/**
 * One sentence for a surface that has room for exactly one — the banner above
 * the composer. Screens with more space phrase their own.
 */
export function quotaSentence(q: QuotaView): string {
  const when = q.resetsOn ? ` It resets on ${q.resetsOn}.` : "";
  if (q.level === "spent") return `This month's allowance is used up.${when}`;
  if (q.level === "low") {
    // Exact here, whatever `approximateReplies` would do with it: the low band
    // is where the number stops being reassurance and becomes something to
    // plan around, and it is small enough to be worth stating precisely.
    const n = q.repliesLeft;
    return `About ${n} ${n === 1 ? "reply" : "replies"} left this month.${when}`;
  }
  return `About ${approximateReplies(q.repliesLeft)} replies left this month`;
}

/**
 * Shares the `["usage"]` query with every other screen, so the figure cannot
 * disagree with itself across the app and a reply refreshes all of them at once.
 */
export function useQuota(): QuotaView | null {
  const { data } = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  return useMemo(() => quotaFrom(data), [data]);
}

/**
 * Whether this is the hosted Covan rather than someone's own install.
 *
 * There is no flag for this and there does not need to be one: the entitlements
 * adapter already knows. A self-hosted install brings its own OpenAI key and
 * has no allowance, which is exactly what `limit: null` means (see usage.ts).
 * Named here rather than left as a bare null check at each call site, so the
 * inference is stated once and can be corrected in one place if it ever stops
 * holding.
 *
 * `undefined` while the figure is still loading — callers that would otherwise
 * flash a hosted-only surface should wait for it.
 */
export function useIsHosted(): boolean | undefined {
  const { data, isPending } = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  if (isPending) return undefined;
  return typeof data?.quota?.limit === "number";
}
