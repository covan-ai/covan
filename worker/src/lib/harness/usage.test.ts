import { describe, it, expect } from "vitest";

import { readFileSync } from "node:fs";

import {
  MESSAGE_OUTCOMES,
  addUsage,
  emptyUsage,
  replyOutcome,
  usageColumns,
  usageOfRow,
} from "./usage";

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

  it("always answers with a pass list, even when neither half carried one", () => {
    // The signature promises a `TurnUsage`, whose `passes` is required. The
    // implementation only built one when an operand had one, so a sum of two
    // objects that had come in through a cast — `paused_turns.usage` is jsonb
    // read back with one — returned an object with no `passes`, and
    // `usageColumns` then emitted `pass_usage: undefined`, which supabase-js
    // drops from the row entirely.
    const bare = {
      promptTokens: 1,
      completionTokens: null,
      cachedTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    } as unknown as ReturnType<typeof emptyUsage>;
    expect(addUsage(bare, bare).passes).toEqual([]);
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

describe("replyOutcome", () => {
  it("says a turn waiting on somebody is paused", () => {
    expect(
      replyOutcome({ paused: { reason: "confirmation" }, finishReason: null, parked: true }),
    ).toBe("paused");
  });

  it("does not call an abandoned turn paused, when nothing was parked", () => {
    // `announcePause` runs only on the non-aborted branch. A row saying
    // "paused" with no `paused_turns` row behind it claims forever to be
    // waiting on somebody who can never answer — the exact false positive the
    // column was added to remove.
    expect(
      replyOutcome({ paused: { reason: "confirmation" }, finishReason: null, parked: false }),
    ).toBe("cut_short");
  });

  it("keeps a ceiling under its own name whether or not anything was parked", () => {
    // Nothing is parked for `budget` or `tokens` in either case: there is no
    // question for a person to answer, and the model answered with what it had.
    for (const parked of [true, false]) {
      expect(replyOutcome({ paused: { reason: "budget" }, finishReason: null, parked })).toBe(
        "budget",
      );
      expect(replyOutcome({ paused: { reason: "tokens" }, finishReason: null, parked })).toBe(
        "tokens",
      );
    }
  });

  it("reports a reply cut off at its length limit as truncated", () => {
    expect(replyOutcome({ paused: null, finishReason: "length", parked: true })).toBe("truncated");
  });

  it("is answered when nothing stopped it", () => {
    expect(replyOutcome({ paused: null, finishReason: "stop", parked: true })).toBe("answered");
  });
});
