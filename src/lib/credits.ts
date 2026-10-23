import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type UsageResponse } from "./api-client";
import { englishT, type Translate } from "@/i18n";

/**
 * The workspace's credits, in the terms an interface needs to show them.
 *
 * `null` means there is nothing to show — a self-hosted Covan charges nobody,
 * and a house workspace on the hosted build has no balance to watch. Every
 * caller can therefore render nothing on a single check, and none of them has
 * to know why.
 *
 * Credits belong to the workspace: one pool that every member spends from and
 * an admin tops up. There is no monthly reset — a balance goes down when the
 * workspace's agents work and up when credits are added.
 */
export type CreditsView = {
  /** Credits left, never shown below zero. */
  balance: number;
  /** Credits ever added — the grant at sign-up plus every top-up. */
  granted: number;
  /** 0–1, clamped: the balance can overshoot zero by one operation. */
  ratio: number;
  /** Credits per reply, mostly this workspace's own once it has sent a few. */
  perReply: number;
  repliesLeft: number;
  /** How many replies the estimate has actually seen. 0 before the first one. */
  repliesSeen: number;
  /**
   * Whether `repliesLeft` is worth printing in the fine band — see
   * `REPLIES_BEFORE_ESTIMATE`. The low and spent bands print it regardless.
   */
  repliesKnown: boolean;
  level: "fine" | "low" | "spent";
};

/**
 * How many charged replies the estimate needs before it is shown as a number.
 *
 * Under this the average is mostly the assumption, and a single cheap message
 * visibly moves it: on 2026-10-21 a tester watched "about N replies left" go
 * UP after sending one, because the prior is outvoted one reply at a time.
 * Until then the balance is shown alone. The low and spent bands are the
 * exception — there the number is what somebody plans around, and an exact
 * small figure is more use than none.
 */
export const REPLIES_BEFORE_ESTIMATE = 10;

/**
 * Below this many credits the balance is worth a warning. The same figure the
 * hosted build mails the workspace's admins at, so the screen and the mailbox
 * give one answer to "are we about to run out".
 */
export const LOW_BALANCE_CREDITS = 50;

/**
 * Before a workspace has sent a reply there is no average to work from. Two
 * credits is the middle of what a reply costs: a short answer is a fraction of
 * one, a long tool turn grounded in documents is a few.
 */
const ASSUMED_CREDITS_PER_REPLY = 2;

/**
 * How many replies the assumption above is worth, weighed against real ones.
 *
 * Switching outright from the assumption to the measurement produced a number
 * nobody could believe: a first question to a brand-new agent with no
 * documents is the cheapest message an account will ever send, so a sample of
 * one is drawn from the bottom of a range that spans more than an order of
 * magnitude. "About 250 replies left" became "about 2,500" after one reply,
 * with nothing bought and nothing refunded.
 *
 * So the assumption is not replaced, it is outvoted: it counts as five replies,
 * and real ones dilute it. After fifty replies it is a tenth of the weight.
 */
const PRIOR_REPLIES = 5;

/**
 * Round to two significant figures once the number is big enough that the last
 * digit is noise. Below twenty it stays exact, because that is where the number
 * stops being reassurance and starts being something to plan around.
 */
export function approximateReplies(n: number): number {
  if (n < 20) return n;
  const magnitude = 10 ** (Math.floor(Math.log10(n)) - 1);
  return Math.round(n / magnitude) * magnitude;
}

/** A credit figure as a person reads it: whole credits, never negative. */
export function wholeCredits(n: number): number {
  return Math.max(0, Math.floor(n));
}

/**
 * A balance in words: "<1 credit", "1 credit", "2,400 credits".
 *
 * Not `wholeCredits` alone, because half a credit floored is "0 credits" — a
 * screen saying the workspace has nothing while it still has something, which
 * the pilot found on 2026-10-16 (covan-cloud#407).
 */
export function creditsPhrase(n: number, t: Translate = englishT, locale?: string): string {
  if (n > 0 && n < 1) return t("<1 credit");
  const whole = wholeCredits(n);
  return t("{{balance}} credit", {
    count: whole,
    balance: whole.toLocaleString(locale),
    defaultValue_other: "{{balance}} credits",
  });
}

export function creditsFrom(usage: UsageResponse | undefined): CreditsView | null {
  const credits = usage?.credits;
  if (!credits || !credits.metered || credits.unlimited) return null;

  // Replies, not credits, because "412 credits" means nothing until somebody
  // has seen what a reply costs. The conversion leans on this workspace's own
  // history — every reply it was ever charged for — weighed against the
  // assumption rather than replacing it. See PRIOR_REPLIES.
  const repliesSeen = credits.spent > 0 ? Math.max(0, credits.replies) : 0;
  const spentSeen = repliesSeen > 0 ? credits.spent : 0;
  const perReply = Math.max(
    0.01,
    (ASSUMED_CREDITS_PER_REPLY * PRIOR_REPLIES + spentSeen) / (PRIOR_REPLIES + repliesSeen),
  );

  const balance = Math.max(0, credits.balance);
  const ratio = credits.granted > 0 ? Math.min(Math.max(balance / credits.granted, 0), 1) : 0;
  const repliesLeft = Math.max(0, Math.floor(balance / perReply));

  // Spent is wherever the server stops starting things, which on the hosted
  // build is a few credits above zero (`floor`). Called "low" there, the screen
  // offered a composer and a reply estimate for a balance every send was
  // refused on.
  const level: CreditsView["level"] =
    credits.balance <= 0 || credits.balance < (credits.floor ?? 0)
      ? "spent"
      : credits.balance < LOW_BALANCE_CREDITS || repliesLeft <= 3
        ? "low"
        : "fine";

  return {
    balance,
    granted: Math.max(0, credits.granted),
    ratio,
    perReply,
    repliesLeft,
    repliesSeen,
    repliesKnown: repliesSeen >= REPLIES_BEFORE_ESTIMATE,
    level,
  };
}

/**
 * One sentence for a surface that has room for exactly one — the banner above
 * the composer. Screens with more space phrase their own.
 */
export function creditsSentence(c: CreditsView, t: Translate = englishT, locale?: string): string {
  if (c.level === "spent") return t("This workspace is out of credits.");
  const credits = t("{{credits}} left", { credits: creditsPhrase(c.balance, t, locale) });
  if (c.level === "low") {
    // Exact here, whatever `approximateReplies` would do with it: the low band
    // is where the number becomes something to plan around.
    const n = c.repliesLeft;
    return t("{{credits}} · about {{count}} reply", {
      credits,
      count: n,
      defaultValue_other: "{{credits}} · about {{count}} replies",
    });
  }
  // The balance alone until the estimate has something to stand on.
  if (!c.repliesKnown) return credits;
  const replies = approximateReplies(c.repliesLeft);
  return t("{{credits}} · about {{replies}} replies", {
    credits,
    replies: replies.toLocaleString(locale),
  });
}

/**
 * Shares the `["usage"]` query with every other screen, so the figure cannot
 * disagree with itself across the app and a reply refreshes all of them at once.
 */
export function useCredits(opts: { watch?: boolean } = {}): CreditsView | null {
  const { data } = useQuery({
    queryKey: ["usage"],
    queryFn: api.usage,
    // A spent balance is the one figure somebody is waiting on: credits are
    // added by hand, elsewhere, and nothing in this tab would otherwise learn
    // they had arrived until a reload. So while it reads spent — or while the
    // caller has just been refused for credits it still shows (`watch`) — it
    // is asked again every half minute, and on focus as every query is.
    refetchInterval: (query) =>
      opts.watch || isSpent(query.state.data) ? CREDITS_RECHECK_MS : false,
  });
  return useMemo(() => creditsFrom(data), [data]);
}

/** How often a spent balance is asked again. */
export const CREDITS_RECHECK_MS = 30_000;

function isSpent(usage: UsageResponse | undefined): boolean {
  return creditsFrom(usage)?.level === "spent";
}

/**
 * Whether this is the hosted Covan rather than someone's own install.
 *
 * There is no flag for this and there does not need to be one: the entitlements
 * adapter already knows. A self-hosted install charges nobody, which is exactly
 * what `metered: false` means (see the worker's `routes/usage.ts`). A house
 * workspace on the hosted build is still hosted — `unlimited` hides its
 * balance, not the fact.
 *
 * `undefined` while the figure is still loading — callers that would otherwise
 * flash a hosted-only surface should wait for it.
 */
export function useIsHosted(): boolean | undefined {
  const { data, isPending } = useQuery({ queryKey: ["usage"], queryFn: api.usage });
  if (isPending) return undefined;
  return data?.credits?.metered === true;
}
