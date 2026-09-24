/**
 * Cost estimation for message token usage.
 *
 * Mirrors worker/src/lib/pricing.ts but simplified for the frontend. Only
 * includes models currently in the catalogue, not historical ones.
 */

type ModelPrices = {
  in: number;
  cachedIn: number;
  out: number;
};

const PRICES: Record<string, ModelPrices> = {
  "gpt-4o": { in: 2.5, cachedIn: 1.25, out: 10 },
  "gpt-4o-mini": { in: 0.15, cachedIn: 0.075, out: 0.6 },
  "gpt-4.1": { in: 2, cachedIn: 0.5, out: 8 },
  "gpt-4.1-mini": { in: 0.4, cachedIn: 0.1, out: 1.6 },
  "gpt-5": { in: 1.25, cachedIn: 0.125, out: 10 },
  "gpt-5-mini": { in: 0.25, cachedIn: 0.025, out: 2 },
  "gpt-5-nano": { in: 0.05, cachedIn: 0.005, out: 0.4 },
  "claude-opus-5": { in: 5, cachedIn: 0.5, out: 25 },
  "claude-sonnet-5": { in: 3, cachedIn: 0.3, out: 15 },
  "claude-opus-4-8": { in: 5, cachedIn: 0.5, out: 25 },
  "claude-sonnet-4-6": { in: 3, cachedIn: 0.3, out: 15 },
  "claude-sonnet-4-5": { in: 3, cachedIn: 0.3, out: 15 },
  "claude-haiku-4-5": { in: 1, cachedIn: 0.1, out: 5 },
};

const DEFAULT_PRICE = PRICES["gpt-4.1"];

const CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * Estimated USD cost for token usage.
 *
 * cachedTokens and cacheWriteTokens are both subsets of promptTokens, not
 * additions, and are disjoint from each other. cacheWriteTokens is priced at
 * Anthropic's 1.25x storage premium and is always zero on OpenAI, whose cache
 * is free to populate. Kept in step with worker/src/lib/pricing.ts: the same
 * reply is costed in both places, on the message badge here and on the usage
 * page there, and two answers to one question is worse than no answer.
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
  cacheWriteTokens = 0,
): number {
  const p = PRICES[model] ?? DEFAULT_PRICE;
  const cached = Math.min(Math.max(cachedTokens, 0), promptTokens);
  const written = Math.min(Math.max(cacheWriteTokens, 0), promptTokens - cached);
  const fresh = promptTokens - cached - written;
  return (
    (fresh / 1_000_000) * p.in +
    (cached / 1_000_000) * p.cachedIn +
    (written / 1_000_000) * p.in * CACHE_WRITE_MULTIPLIER +
    (completionTokens / 1_000_000) * p.out
  );
}

/**
 * Format cost in cents as a dollar string.
 */
export function formatCost(usd: number): string {
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/**
 * Format large token counts with "k" suffix.
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return tokens.toString();
}
