// Approximate OpenAI list prices in USD per 1,000,000 tokens.
// Used only for a rough cost estimate in the usage view — not billing-accurate,
// and historical replies are priced at the agent's current model.
//
// `cachedIn` is the rate for prompt tokens OpenAI served from its automatic
// prompt cache. The discount is not uniform across families — the 4o models
// cache at half price, the 4.1 models at a quarter — so it is a per-model
// figure rather than one multiplier applied to `in`.
const PRICES: Record<string, { in: number; cachedIn: number; out: number }> = {
  "gpt-4o": { in: 2.5, cachedIn: 1.25, out: 10 },
  "gpt-4o-mini": { in: 0.15, cachedIn: 0.075, out: 0.6 },
  "gpt-4.1": { in: 2, cachedIn: 0.5, out: 8 },
  "gpt-4.1-mini": { in: 0.4, cachedIn: 0.1, out: 1.6 },
};

const DEFAULT_PRICE = PRICES["gpt-4o"];

/**
 * Estimated USD cost for a number of prompt/completion tokens on `model`.
 *
 * `cachedTokens` is a *subset* of `promptTokens`, which is how OpenAI reports
 * it (`usage.prompt_tokens_details.cached_tokens` counts tokens already
 * included in `usage.prompt_tokens`). It is therefore subtracted out and
 * re-priced, never added — adding it would bill the same tokens twice.
 * Omitting it prices the whole prompt as fresh, which is what every caller
 * written before caching was measured means.
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens = 0,
): number {
  const p = PRICES[model] ?? DEFAULT_PRICE;
  const cached = Math.min(Math.max(cachedTokens, 0), promptTokens);
  const fresh = promptTokens - cached;
  return (
    (fresh / 1_000_000) * p.in +
    (cached / 1_000_000) * p.cachedIn +
    (completionTokens / 1_000_000) * p.out
  );
}
