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
  /** The caller's own observed cost per reply — see the note below. */
  perReply: number;
  repliesLeft: number;
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

export function quotaFrom(usage: UsageResponse | undefined): QuotaView | null {
  const quota = usage?.quota;
  if (!quota || quota.limit === null || quota.limit <= 0) return null;

  // Replies, not tokens, because nobody budgets in tokens — and the conversion
  // uses THIS user's own average rather than a constant. What a reply costs
  // varies by more than an order of magnitude: a first question to an agent
  // with no documents measured 101 tokens, while a long conversation grounded
  // in uploads averaged 5,335. `totals` is already scoped by row level security
  // to the caller's own conversations, so it is their average and nobody else's.
  const seen = usage?.totals;
  const perReply =
    seen && seen.messageCount > 0 && seen.totalTokens > 0
      ? Math.max(1, Math.round(seen.totalTokens / seen.messageCount))
      : ASSUMED_TOKENS_PER_REPLY;

  const ratio = Math.min(quota.used / quota.limit, 1);
  const repliesLeft = Math.max(0, Math.floor((quota.limit - quota.used) / perReply));
  const resetsOn = quota.resetsAt
    ? new Date(quota.resetsAt).toLocaleDateString(undefined, { month: "long", day: "numeric" })
    : null;

  const level: QuotaView["level"] =
    quota.used >= quota.limit ? "spent" : ratio >= 0.75 || repliesLeft <= 3 ? "low" : "fine";

  return { used: quota.used, limit: quota.limit, ratio, perReply, repliesLeft, resetsOn, level };
}

/**
 * One sentence for a surface that has room for exactly one — the banner above
 * the composer. Screens with more space phrase their own.
 */
export function quotaSentence(q: QuotaView): string {
  const when = q.resetsOn ? ` It resets on ${q.resetsOn}.` : "";
  if (q.level === "spent") return `This month's allowance is used up.${when}`;
  if (q.level === "low") {
    const n = q.repliesLeft;
    return `About ${n} ${n === 1 ? "reply" : "replies"} left this month.${when}`;
  }
  return `About ${q.repliesLeft} replies left this month`;
}

/**
 * Shares the `["usage"]` query with every other screen, so the figure cannot
 * disagree with itself across the app and a reply refreshes all of them at once.
 */
export function useQuota(): QuotaView | null {
  const { data } = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  return useMemo(() => quotaFrom(data), [data]);
}
