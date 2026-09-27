import { describe, it, expect } from "vitest";

import { readFileSync } from "node:fs";

import { MESSAGE_OUTCOMES, addUsage, emptyUsage, usageColumns, usageOfRow } from "./usage";

describe("addUsage", () => {
  it("null + null stays null: an Anthropic reply has no reasoning count", () => {
    const sum = addUsage(
      { ...emptyUsage(), promptTokens: 100, completionTokens: 10, reasoningTokens: null },
      { ...emptyUsage(), promptTokens: 200, completionTokens: 20, reasoningTokens: null },
    );
    expect(sum.promptTokens).toBe(300);
    expect(sum.completionTokens).toBe(30);
    expect(sum.reasoningTokens).toBeNull();
  });

  it("null + number is the number: a resumed OpenAI half after a null first half", () => {
    const sum = addUsage(
      { ...emptyUsage(), cacheWriteTokens: null },
      { ...emptyUsage(), cacheWriteTokens: 40 },
    );
    expect(sum.cacheWriteTokens).toBe(40);
  });

  it("passes concatenate in order and are never renumbered", () => {
    const sum = addUsage(
      {
        ...emptyUsage(),
        passes: [{ index: 0, prompt: 1, cached: 0, written: null, completion: 1, reasoning: null }],
      },
      {
        ...emptyUsage(),
        passes: [{ index: 4, prompt: 2, cached: 1, written: null, completion: 1, reasoning: null }],
      },
    );
    expect(sum.passes.map((p) => p.index)).toEqual([0, 4]);
  });
});

describe("usageOfRow", () => {
  it("reads a column the row does not carry as not measured, not as zero", () => {
    const usage = usageOfRow({ prompt_tokens: 400, completion_tokens: 1536, cached_tokens: 0 });
    expect(usage.promptTokens).toBe(400);
    expect(usage.cachedTokens).toBe(0);
    expect(usage.cacheWriteTokens).toBeNull();
    expect(usage.reasoningTokens).toBeNull();
    expect(usage.passes).toEqual([]);
  });

  it("ignores a pass_usage that is not an array, which is what a null column reads as", () => {
    expect(usageOfRow({ pass_usage: null }).passes).toEqual([]);
    expect(usageOfRow({ pass_usage: { index: 0 } }).passes).toEqual([]);
  });
});

describe("usageColumns", () => {
  it("names the six columns a reply's cost lives in, and nothing else", () => {
    expect(Object.keys(usageColumns(emptyUsage())).sort()).toEqual([
      "cache_write_tokens",
      "cached_tokens",
      "completion_tokens",
      "pass_usage",
      "prompt_tokens",
      "reasoning_tokens",
    ]);
  });

  it("round-trips a row through usageOfRow unchanged", () => {
    const row = {
      prompt_tokens: 1,
      completion_tokens: 2,
      cached_tokens: 3,
      cache_write_tokens: null,
      reasoning_tokens: 5,
      pass_usage: [{ index: 0, prompt: 1, cached: 3, written: null, completion: 2, reasoning: 5 }],
    };
    expect(usageColumns(usageOfRow(row))).toEqual(row);
  });
});

describe("MESSAGE_OUTCOMES", () => {
  it("says exactly what 0065's check constraint allows", () => {
    // A value here that the constraint does not know is a 400 from PostgREST
    // on a reply that was otherwise fine, and nothing else would catch it
    // until production: the column is written by the worker and read by
    // nobody the type checker can see.
    const sql = readFileSync(
      "../supabase/migrations/0065_what_one_turn_was_and_what_it_all_cost.sql",
      "utf8",
    );
    const allowed = [...sql.matchAll(/outcome in \(([^)]*)\)/g)]
      .flatMap((m) => [...m[1].matchAll(/'([a-z_]+)'/g)].map((v) => v[1]))
      .sort();
    expect(allowed).toEqual([...MESSAGE_OUTCOMES].sort());
  });
});
