/**
 * What a turn cost, added up across the halves it was answered in.
 *
 * A turn that stops to ask for permission is one reply written in two goes,
 * and until 0065 the second go *replaced* the row's usage instead of adding to
 * it — so every pass before the pause vanished from `messages` while still
 * having been charged to the allowance. 10 of the 29 turns carrying
 * `pass_usage` between 2026-09-24 and 09-26 start above index 0 for that
 * reason.
 *
 * The sum lives here rather than in `routes/chat.ts` because the cron Worker
 * reaches the harness and never reaches a route: nothing under `lib/harness/`
 * may import from `routes/`.
 */

import type { CompletionUsage } from "../completion";

import type { PassUsage } from "./loop";

export type TurnUsage = CompletionUsage & { passes: PassUsage[] };

/**
 * How a reply ended — `messages.outcome`, and the same list the check
 * constraint holds. Declared in 0065 and widened by 0067.
 *
 * A list rather than a bare union so the two can be compared: a value the
 * constraint does not know is a 400 from PostgREST on a reply that was
 * otherwise fine, and nothing between here and production would say so.
 * `usage.test.ts` reads both migrations and asserts this list equals what they
 * leave behind, which is what makes adding a value here a two-file change on
 * purpose.
 */
export const MESSAGE_OUTCOMES = [
  "answered",
  "paused",
  "budget",
  "tokens",
  // The platform's ceiling rather than either of ours — see `RUNTIME_INSTRUCTION`
  // in `lib/harness/loop.ts`. Separate from `budget` because recording it as a
  // tool-budget stop would hide the one event the subrequest gate exists to make
  // visible, which is the same argument that split `tokens` off in the first
  // place.
  "runtime",
  "cut_short",
  "empty",
  "truncated",
] as const;

export type MessageOutcome = (typeof MESSAGE_OUTCOMES)[number];

export function emptyUsage(): TurnUsage {
  return {
    promptTokens: null,
    completionTokens: null,
    cachedTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
    webSearches: null,
    passes: [],
  };
}

/**
 * null means "not measured" and must survive a sum; 0 is a measurement.
 *
 * The distinction is load-bearing rather than tidy: `cache_write_tokens is
 * null` is how a row is known to be an OpenAI reply and `reasoning_tokens is
 * null` how it is known to be an Anthropic one, so a continuation that wrote
 * 0 where the provider reported nothing would erase the tell 0064 relies on.
 */
function add(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

/** The six counters, summed. What a caller with no pass list wants. */
export function addCounts(a: CompletionUsage, b: CompletionUsage): CompletionUsage {
  return {
    promptTokens: add(a.promptTokens, b.promptTokens),
    completionTokens: add(a.completionTokens, b.completionTokens),
    cachedTokens: add(a.cachedTokens, b.cachedTokens),
    cacheWriteTokens: add(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: add(a.reasoningTokens, b.reasoningTokens),
    webSearches: add(a.webSearches, b.webSearches),
  };
}

/**
 * The same sum, carrying the per-pass list with it.
 *
 * Two functions rather than one overloaded one, over a single definition of
 * the null rule. The overload this replaces promised a `TurnUsage` — whose
 * `passes` is required — from an implementation that only built one when an
 * operand happened to have it, and `paused_turns.usage` is jsonb read back
 * through a cast, so an operand really can arrive without the field. Absent,
 * `usageColumns` emits `pass_usage: undefined` and supabase-js drops the key:
 * a NULL column where the merged list should be.
 */
export function addUsage(
  a: CompletionUsage & { passes?: PassUsage[] },
  b: CompletionUsage & { passes?: PassUsage[] },
): TurnUsage {
  return {
    ...addCounts(a, b),
    // An index is which model call it was inside its own half, and nothing
    // here renumbers them. A RESUME continues the numbering, because the loop
    // seeds `pass` from `max(step.pass) + 1` of the steps it carries in; a
    // CONTINUATION does not — it runs with no `stepsSoFar`, so its passes
    // start at zero again and one row's list can read [0, 1, 0, 1].
    passes: [...(a.passes ?? []), ...(b.passes ?? [])],
  };
}

/** One counter summed across a row's recorded passes, null when none recorded it. */
export function sumOverPasses(
  raw: unknown,
  pick: (p: PassUsage) => number | null | undefined,
): number | null {
  if (!Array.isArray(raw)) return null;
  const seen = (raw as PassUsage[]).map(pick).filter((n) => typeof n === "number");
  return seen.length === 0 ? null : seen.reduce((x, y) => x + y, 0);
}

/** One number off a `messages` row, where a column that is not there is not a zero. */
function count(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * What a reply row says it cost.
 *
 * `pass_usage` goes through `Array.isArray` rather than a cast because the
 * column is `jsonb` and nullable: a reply written before 0062 has nothing
 * there, and a `null` spread into an array is a crash rather than an empty
 * list.
 */
export function usageOfRow(row: Record<string, unknown>): TurnUsage {
  return {
    promptTokens: count(row.prompt_tokens),
    completionTokens: count(row.completion_tokens),
    cachedTokens: count(row.cached_tokens),
    cacheWriteTokens: count(row.cache_write_tokens),
    reasoningTokens: count(row.reasoning_tokens),
    // Derived from the passes rather than read from a column, because there is
    // no column: the count lives in each `pass_usage` entry, where the cost it
    // explains is also per pass. Null when no pass recorded one, which is every
    // reply written before 2026-09-29 and every OpenAI reply since.
    webSearches: sumOverPasses(row.pass_usage, (p) => p.searches),
    passes: Array.isArray(row.pass_usage) ? (row.pass_usage as PassUsage[]) : [],
  };
}

/** The same thing, back in the shape an insert or an update takes. */
export function usageColumns(usage: TurnUsage): {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  pass_usage: PassUsage[];
} {
  return {
    prompt_tokens: usage.promptTokens,
    completion_tokens: usage.completionTokens,
    cached_tokens: usage.cachedTokens,
    cache_write_tokens: usage.cacheWriteTokens,
    reasoning_tokens: usage.reasoningTokens,
    pass_usage: usage.passes,
  };
}

/**
 * How a reply ended, from the three facts that decide it.
 *
 * Its own function because the answer differs between two call sites that
 * otherwise look identical: the turn that finishes and the turn the person
 * walked away from. `announcePause` runs only on the first, so on the second
 * `paused.reason === "confirmation"` describes something that was never
 * written down — a row saying `paused` with no `paused_turns` behind it is a
 * reply claiming forever to be waiting on somebody who can never answer it,
 * which is exactly the false positive `messages.outcome` exists to remove.
 *
 * `budget`, `tokens` and `runtime` are unaffected by that: nothing is parked
 * for any of them anywhere, because there is no question for a person to
 * answer.
 */
export function replyOutcome(input: {
  paused: { reason: "confirmation" | "budget" | "tokens" | "runtime" } | null;
  finishReason: string | null;
  /** Whether this turn will actually be parked for somebody to answer. */
  parked: boolean;
}): MessageOutcome {
  if (input.paused) {
    if (input.paused.reason !== "confirmation") return input.paused.reason;
    return input.parked ? "paused" : "cut_short";
  }
  return input.finishReason === "length" ? "truncated" : "answered";
}
