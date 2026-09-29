import { describe, it, expect } from "vitest";

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
  it("says exactly what every outcome constraint allows, as the migrations left them", () => {
    // A value here that the constraint does not know is a 400 from PostgREST
    // on a reply that was otherwise fine, and nothing else would catch it
    // until production: the column is written by the worker and read by
    // nobody the type checker can see.
    //
    // Read per CONSTRAINT rather than per file, and from whichever migration
    // redefined each one LAST, because that is what the database actually
    // holds. Two tables carry this vocabulary now — `messages.outcome` since
    // 0065 and `routine_runs.outcome` since 0070 — and one list is the whole
    // point: a scheduled run and a chat turn that ended the same way have to
    // say so with the same word, or the two histories cannot be read together.
    // Reading only the last file to mention `outcome in (` would have checked
    // whichever table happened to be touched most recently and silently
    // stopped checking the other.
    const dir = "../supabase/migrations";
    const latest = new Map<string, string[]>();
    for (const file of readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      const sql = readFileSync(join(dir, file), "utf8");
      // Every constraint is written as `add constraint <table>_outcome_known
      // check (... outcome in (...))`, so the name is the table and the list
      // that follows it is that table's vocabulary.
      for (const m of sql.matchAll(
        /add constraint (\w+_outcome_known)[\s\S]*?outcome in \(([^)]*)\)/g,
      )) {
        latest.set(m[1], [...m[2].matchAll(/'([a-z_]+)'/g)].map((v) => v[1]).sort());
      }
    }

    // Both tables, or the loop above found nothing and every assertion below
    // would pass against an empty map.
    expect([...latest.keys()].sort()).toEqual([
      "messages_outcome_known",
      "routine_runs_outcome_known",
    ]);
    for (const [name, allowed] of latest) {
      expect(allowed, name).toEqual([...MESSAGE_OUTCOMES].sort());
    }
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

  /**
   * `empty` was in the vocabulary from 0065 and nothing could write it.
   *
   * `routes/chat.ts` sends an SSE error and persists nothing when a streamed
   * reply comes back with no text, so there was no row to carry it — but two
   * paths DO write a row for a reply that said nothing: `POST /chat/confirm/:id`
   * stores `(no reply)` for a resumed half, and a scheduled run records what it
   * called. Both said `answered`, which is a row claiming it answered while
   * holding nothing. 0070 chose to write the value rather than drop it.
   */
  describe("a reply with no words in it", () => {
    it("is empty when nothing else explains it", () => {
      expect(replyOutcome({ paused: null, finishReason: "stop", parked: false, said: false })).toBe(
        "empty",
      );
    });

    it("stays answered when something was said", () => {
      expect(replyOutcome({ paused: null, finishReason: "stop", parked: false, said: true })).toBe(
        "answered",
      );
    });

    it("defaults to said, so no existing caller changes meaning", () => {
      expect(replyOutcome({ paused: null, finishReason: "stop", parked: false })).toBe("answered");
    });

    it("is outranked by every reason that says more", () => {
      // A turn that stopped to ask and said nothing is not "empty" — it is a
      // turn that stopped to ask, and that is the more useful word. Same for a
      // ceiling. `truncated` is the one case `empty` can never collide with: a
      // reply cut off at its length limit has words in it by definition.
      expect(
        replyOutcome({
          paused: { reason: "confirmation" },
          finishReason: null,
          parked: false,
          said: false,
        }),
      ).toBe("cut_short");
      expect(
        replyOutcome({
          paused: { reason: "budget" },
          finishReason: null,
          parked: false,
          said: false,
        }),
      ).toBe("budget");
    });
  });
});
