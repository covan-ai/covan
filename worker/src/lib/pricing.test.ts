import { describe, it, expect } from "vitest";
import { estimateCostUsd } from "./pricing";

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
});
