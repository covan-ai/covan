import type { ModelId } from "./models";

// Approximate list prices in USD per 1,000,000 tokens, for every model in
// `lib/models.ts`. Used only for a rough cost estimate in the usage view — not
// billing-accurate, and historical replies are priced at the agent's current
// model.
//
// `cachedIn` is the rate for prompt tokens the provider served from its prompt
// cache. The discount is not uniform — the 4o models cache at half price, the
// 4.1 models at a quarter, GPT-5 and Claude at a tenth — so it is a per-model
// figure rather than one multiplier applied to `in`.
//
// One thing this deliberately does not model: Anthropic charges a *premium*
// (1.25x input) for the tokens it writes into the cache, where OpenAI's
// automatic caching is free to populate. Those show up here at the plain `in`
// rate, so a Claude estimate runs slightly low on the first turn of a
// conversation and is right for every turn after it. Naming it beats a fourth
// rate on every row for an error that rounds to nothing over a month.
//
// Keyed by `ModelId` rather than by `string`, for the same reason `SPECS` in
// `lib/models.ts` is: adding an id to the catalogue without a price here is
// then a type error rather than a model that quietly bills at the fallback
// rate. `pricing.test.ts` used to be the only thing standing between a new
// model and a usage view that under-reported it by 2.5x, and a test can only
// catch that after somebody runs it.
const PRICES: Record<ModelId, { in: number; cachedIn: number; out: number }> = {
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

// What an id this file has no row for is priced at. It tracks `DEFAULT_MODEL`
// in `lib/models.ts` rather than naming a model of its own, because that is
// where an unrecognised id actually ends up: `resolveModel` sends it there, so
// pricing it as anything else would estimate a reply against a model that did
// not write it.
const DEFAULT_PRICE = PRICES["gpt-4.1"];

/**
 * Estimated USD cost for a number of prompt/completion tokens on `model`.
 *
 * `cachedTokens` is a *subset* of `promptTokens`, which is how OpenAI reports
 * it (`usage.prompt_tokens_details.cached_tokens` counts tokens already
 * included in `usage.prompt_tokens`) and what `lib/completion.ts` normalises
 * Anthropic's numbers into. It is therefore subtracted out and
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
  const p = PRICES[model as ModelId] ?? DEFAULT_PRICE;
  const cached = Math.min(Math.max(cachedTokens, 0), promptTokens);
  const fresh = promptTokens - cached;
  return (
    (fresh / 1_000_000) * p.in +
    (cached / 1_000_000) * p.cachedIn +
    (completionTokens / 1_000_000) * p.out
  );
}

/**
 * The reply this file prices a model against, so two models can be compared by
 * a number rather than by a feeling.
 *
 * Not invented. `0025_what_the_cache_already_paid_for.sql` measured ten real
 * assistant replies on the live project on 2026-08-23 and recorded the average:
 * 2,248 prompt tokens to 921 completion. That migration says in as many words
 * to treat the ratio as the finding and the absolute figures as provisional,
 * which is exactly what this is used for — the same reply costed on every
 * model, so what is being compared is the price list rather than the sample.
 *
 * Priced as a *fresh* prompt, at the `in` rate rather than `cachedIn`. A
 * second turn in the same conversation is cheaper than this on every model, so
 * the number errs high — and a picker is a place to err high, because the
 * failure mode that matters is somebody discovering a bill they were not shown.
 */
export const REFERENCE_REPLY = { promptTokens: 2248, completionTokens: 921 } as const;

/**
 * What one reference reply costs on `model`, or `null` for an id this build
 * has no price for.
 *
 * `null`, and deliberately not `DEFAULT_PRICE`. `estimateCostUsd` above falls
 * back to the default's price because that is where an unrecognised id
 * genuinely ends up — `resolveModel` sends it to `DEFAULT_MODEL`, so pricing it
 * that way describes what actually answered. Nothing like that is true here.
 * This number goes next to a name in a picker, and under `OPENAI_BASE_URL`
 * every id is unknown by design: putting "$0.012 a reply" beside somebody's
 * local Llama would be a claim about their electricity bill. No price is an
 * honest answer; a borrowed one is not.
 */
export function referenceReplyCostUsd(model: string): number | null {
  const p = PRICES[model as ModelId];
  if (!p) return null;
  return (
    (REFERENCE_REPLY.promptTokens / 1_000_000) * p.in +
    (REFERENCE_REPLY.completionTokens / 1_000_000) * p.out
  );
}

/**
 * The prices a picker may show, for the ids this deployment offers.
 *
 * Empty when `OPENAI_MODEL` is set, and that is the whole reason this takes an
 * environment. With that variable set, `resolveModel` sends every completion to
 * that one model whatever the picker says — so a price beside `gpt-4o` would be
 * describing a request this deployment will never make. DESIGN.md's first
 * failure mode is a claim the code cannot back, and that would be one.
 */
export function modelCostsFor(
  ids: readonly string[],
  env?: { OPENAI_MODEL?: string },
): Record<string, number> {
  if (env?.OPENAI_MODEL) return {};
  const out: Record<string, number> = {};
  for (const id of ids) {
    const cost = referenceReplyCostUsd(id);
    if (cost !== null) out[id] = cost;
  }
  return out;
}
