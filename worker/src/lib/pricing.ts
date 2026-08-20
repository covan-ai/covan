// Approximate OpenAI list prices in USD per 1,000,000 tokens (input, output).
// Used only for a rough cost estimate in the usage view — not billing-accurate,
// and historical replies are priced at the agent's current model.
const PRICES: Record<string, { in: number; out: number }> = {
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "gpt-4.1": { in: 2, out: 8 },
  "gpt-4.1-mini": { in: 0.4, out: 1.6 },
};

const DEFAULT_PRICE = PRICES["gpt-4o"];

/** Estimated USD cost for a number of prompt/completion tokens on `model`. */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const p = PRICES[model] ?? DEFAULT_PRICE;
  return (promptTokens / 1_000_000) * p.in + (completionTokens / 1_000_000) * p.out;
}
