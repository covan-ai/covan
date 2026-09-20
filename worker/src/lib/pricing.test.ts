import { describe, it, expect } from "vitest";
import { estimateCostUsd, referenceReplyCostUsd, modelCostsFor, REFERENCE_REPLY } from "./pricing";
import { MODEL_IDS, DEFAULT_MODEL } from "./models";

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
    // gpt-4.1: $2/M in. Tracks `DEFAULT_MODEL` in lib/models.ts, which is where
    // an unrecognised id actually resolves to.
    expect(estimateCostUsd("mystery-model", 1_000_000, 0)).toBeCloseTo(2, 6);
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
    // Falling back to the default model's rate is the right answer for a
    // self-hosted endpoint whose catalogue we cannot know. It is the wrong
    // answer for a model we ship: the usage view would quote the wrong number
    // and stay silent about it.
    //
    // `PRICES` is keyed by `ModelId`, so a missing row is now a type error and
    // this can no longer be the first thing to notice one. It is kept because
    // it catches what the type cannot: a row that is present but copied from
    // the wrong model and therefore identical to the fallback.
    const fallback = estimateCostUsd("mystery-model", 1_000_000, 0);
    for (const id of MODEL_IDS) {
      if (id === DEFAULT_MODEL) continue; // the fallback itself
      expect(estimateCostUsd(id, 1_000_000, 0), id).not.toBe(fallback);
    }
  });
});

describe("referenceReplyCostUsd", () => {
  // The anchor. 0025 measured ten real replies and priced them on gpt-4o at
  // "about $0.015"; if this reference ever stops reproducing that number, the
  // sentence in the interface that cites the measurement has stopped being
  // about the measurement.
  it("reproduces the figure 0025 recorded for gpt-4o", () => {
    expect(referenceReplyCostUsd("gpt-4o")).toBeCloseTo(0.015, 3);
  });

  it("prices the whole catalogue", () => {
    for (const id of MODEL_IDS) {
      expect(referenceReplyCostUsd(id), id).toBeGreaterThan(0);
    }
  });

  // The bands are absolute, so the ordering they express has to be real.
  it("agrees with the price list about which models are dearer", () => {
    const nano = referenceReplyCostUsd("gpt-5-nano")!;
    const mini = referenceReplyCostUsd("gpt-4o-mini")!;
    const flagship = referenceReplyCostUsd("gpt-4o")!;
    const opus = referenceReplyCostUsd("claude-opus-5")!;
    expect(nano).toBeLessThan(mini);
    expect(mini).toBeLessThan(flagship);
    expect(flagship).toBeLessThan(opus);
  });

  // Not DEFAULT_PRICE. Under OPENAI_BASE_URL every id is unknown by design, and
  // a borrowed number beside somebody's local model is a claim about their
  // hardware.
  it("has no price for an id it does not know", () => {
    expect(referenceReplyCostUsd("llama-3.3-70b-instruct")).toBeNull();
    expect(referenceReplyCostUsd("")).toBeNull();
  });

  it("prices a fresh prompt, so the number errs high", () => {
    // Same tokens through the billing estimator with nothing cached.
    expect(referenceReplyCostUsd("gpt-4o")).toBeCloseTo(
      estimateCostUsd("gpt-4o", REFERENCE_REPLY.promptTokens, REFERENCE_REPLY.completionTokens),
      10,
    );
  });
});

describe("modelCostsFor", () => {
  it("prices every id it is given", () => {
    const costs = modelCostsFor(["gpt-4o", "claude-opus-5"]);
    expect(Object.keys(costs).sort()).toEqual(["claude-opus-5", "gpt-4o"]);
  });

  it("leaves out an id it cannot price rather than guessing", () => {
    expect(modelCostsFor(["gpt-4o", "some-local-model"])).toEqual({
      "gpt-4o": referenceReplyCostUsd("gpt-4o"),
    });
  });

  // With OPENAI_MODEL set, resolveModel sends every completion to that one
  // model whatever the picker says. A price beside gpt-4o would then describe
  // a request this deployment never makes.
  it("says nothing at all under a custom endpoint", () => {
    expect(modelCostsFor(["gpt-4o", "gpt-4.1"], { OPENAI_MODEL: "llama-3.3-70b" })).toEqual({});
  });
});
