import { describe, it, expect } from "vitest";
import { estimateCostUsd } from "./pricing";
import { MODEL_IDS } from "./models";

describe("estimateCostUsd", () => {
  it("prices prompt and completion tokens per the model's rate", () => {
    // gpt-4o: $2.5/M in, $10/M out. 1M in + 1M out = 2.5 + 10 = 12.5
    expect(estimateCostUsd("gpt-4o", 1_000_000, 1_000_000)).toBeCloseTo(12.5, 6);
    // gpt-4o-mini: $0.15/M in, $0.60/M out. 500k in + 250k out
    expect(estimateCostUsd("gpt-4o-mini", 500_000, 250_000)).toBeCloseTo(0.075 + 0.15, 6);
  });

  it("returns 0 for zero tokens", () => {
    expect(estimateCostUsd("gpt-4.1", 0, 0)).toBe(0);
  });

  it("falls back to the default model's price for an unknown model", () => {
    expect(estimateCostUsd("mystery-model", 1_000_000, 0)).toBeCloseTo(2.5, 6);
  });

  it("prices cached prompt tokens at the discounted rate", () => {
    // gpt-4.1: $2/M fresh, $0.50/M cached. 1M prompt tokens, all of them cached.
    expect(estimateCostUsd("gpt-4.1", 1_000_000, 0, 1_000_000)).toBeCloseTo(0.5, 6);
    // Half cached: 500k at $2/M + 500k at $0.50/M
    expect(estimateCostUsd("gpt-4.1", 1_000_000, 0, 500_000)).toBeCloseTo(1 + 0.25, 6);
  });

  it("treats cached tokens as a subset of the prompt, never an addition", () => {
    // OpenAI reports cached_tokens as part of prompt_tokens, not alongside it.
    // Adding them would bill the same tokens twice, so the total with caching
    // must never exceed the same prompt priced entirely fresh.
    const fresh = estimateCostUsd("gpt-4o", 100_000, 0, 0);
    const cached = estimateCostUsd("gpt-4o", 100_000, 0, 100_000);
    expect(cached).toBeLessThan(fresh);
    expect(cached).toBeCloseTo(fresh / 2, 6); // gpt-4o caches at half price
  });

  it("clamps a cached count that exceeds the prompt", () => {
    // Defensive: a malformed usage payload must not produce a negative bill.
    expect(estimateCostUsd("gpt-4o", 1_000, 0, 999_999)).toBeCloseTo(
      estimateCostUsd("gpt-4o", 1_000, 0, 1_000),
      6,
    );
  });

  it("defaults to no caching when the count is omitted", () => {
    // Every pre-existing caller passes three arguments; they must not change price.
    expect(estimateCostUsd("gpt-4o", 1_000_000, 0)).toBeCloseTo(2.5, 6);
  });

  it("prices the Claude models, which bill in the same two dimensions", () => {
    // claude-haiku-4-5: $1/M in, $5/M out.
    expect(estimateCostUsd("claude-haiku-4-5", 1_000_000, 1_000_000)).toBeCloseTo(6, 6);
    // claude-sonnet-4-5: $3/M in, $15/M out, cache reads at a tenth.
    expect(estimateCostUsd("claude-sonnet-4-5", 1_000_000, 0, 1_000_000)).toBeCloseTo(0.3, 6);
  });

  it("prices the GPT-5 family below the 4o default it replaces", () => {
    const perMillionIn = (model: string) => estimateCostUsd(model, 1_000_000, 0);
    expect(perMillionIn("gpt-5")).toBeLessThan(perMillionIn("gpt-4o"));
    expect(perMillionIn("gpt-5-mini")).toBeLessThan(perMillionIn("gpt-5"));
    expect(perMillionIn("gpt-5-nano")).toBeLessThan(perMillionIn("gpt-5-mini"));
  });

  it("has a rate for every model the picker offers", () => {
    // Falling back to gpt-4o's rate is the right answer for a self-hosted
    // endpoint whose catalogue we cannot know. It is the wrong answer for a
    // model we ship: the usage view would quote 2.5x for haiku and stay silent
    // about it. So an id added to the catalogue without a price fails here.
    const fallback = estimateCostUsd("mystery-model", 1_000_000, 0);
    for (const id of MODEL_IDS) {
      if (id === "gpt-4o") continue; // the fallback itself
      expect(estimateCostUsd(id, 1_000_000, 0), id).not.toBe(fallback);
    }
  });
});
