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
 * How a reply ended — `messages.outcome`, and the same list 0065's check
 * constraint holds.
 *
 * A list rather than a bare union so the two can be compared: a value the
 * constraint does not know is a 400 from PostgREST on a reply that was
 * otherwise fine, and nothing between here and production would say so.
 */
export const MESSAGE_OUTCOMES = [
  "answered",
  "paused",
  "budget",
  "tokens",
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

export function addUsage(a: TurnUsage, b: TurnUsage): TurnUsage;
export function addUsage(a: CompletionUsage, b: CompletionUsage): CompletionUsage;
export function addUsage(
  a: CompletionUsage & { passes?: PassUsage[] },
  b: CompletionUsage & { passes?: PassUsage[] },
): CompletionUsage & { passes?: PassUsage[] } {
  const summed: CompletionUsage & { passes?: PassUsage[] } = {
    promptTokens: add(a.promptTokens, b.promptTokens),
    completionTokens: add(a.completionTokens, b.completionTokens),
    cachedTokens: add(a.cachedTokens, b.cachedTokens),
    cacheWriteTokens: add(a.cacheWriteTokens, b.cacheWriteTokens),
    reasoningTokens: add(a.reasoningTokens, b.reasoningTokens),
  };
  // Passes are never renumbered: an index is which model call it was inside
  // its own half, and a resumed run already continues the numbering from
  // `max(step.pass) + 1`.
  if (a.passes || b.passes) summed.passes = [...(a.passes ?? []), ...(b.passes ?? [])];
  return summed;
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
