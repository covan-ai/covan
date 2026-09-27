import { readFileSync } from "node:fs";

import { describe, it, expect } from "vitest";

import { estimateCostUsd } from "./pricing";

/**
 * The badge under a chat message and the figure on the usage page are the same
 * question asked twice, in two trees, from two tables that nothing joins.
 *
 * `worker/src/lib/pricing.ts` was repriced for Sonnet 5 and this copy was not,
 * so every Claude reply in the product showed one number under the bubble and
 * another on /usage — 50% apart, with nothing saying which was right. Both
 * files say in comments that they are kept in step; this is the first thing
 * that makes them.
 */
describe("the two pricing tables", () => {
  it("charge the same for every model either of them knows", () => {
    const rowOf = (source: string, model: string) => {
      const line = source.split("\n").find((l) => l.trimStart().startsWith(`"${model}":`));
      return line?.slice(line.indexOf("{"));
    };
    const worker = readFileSync("worker/src/lib/pricing.ts", "utf8");
    const here = readFileSync("src/lib/pricing.ts", "utf8");

    const models = [...here.matchAll(/^ {2}"([a-z0-9.-]+)":/gm)].map((m) => m[1]);
    expect(models.length).toBeGreaterThan(5);
    for (const model of models) {
      expect(rowOf(here, model), model).toBe(rowOf(worker, model));
    }
  });

  it("prices Sonnet 5 at the $2/$10 that is its standard rate", () => {
    expect(estimateCostUsd("claude-sonnet-5", 1_000_000, 0)).toBeCloseTo(2, 6);
    expect(estimateCostUsd("claude-sonnet-5", 0, 1_000_000)).toBeCloseTo(10, 6);
    expect(estimateCostUsd("claude-sonnet-5", 1_000_000, 0, 1_000_000)).toBeCloseTo(0.2, 6);
  });
});
