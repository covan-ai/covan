import { describe, it, expect } from "vitest";
import { selectHistory } from "./history";

const size = (turns: { content: string }[]) => turns.reduce((n, t) => n + t.content.length, 0);

const turn = (role: "user" | "assistant", content: string) => ({ role, content });

describe("selectHistory", () => {
  it("returns empty for empty input", () => {
    expect(selectHistory([])).toEqual([]);
  });

  it("keeps everything when under budget, preserving chronological order", () => {
    const rows = [turn("user", "a"), turn("assistant", "b"), turn("user", "c")];
    expect(selectHistory(rows)).toEqual(rows);
  });

  it("drops the oldest messages once the budget is exhausted", () => {
    const rows = [
      turn("user", "x".repeat(100)),
      turn("assistant", "y".repeat(100)),
      turn("user", "z".repeat(100)),
    ];
    const out = selectHistory(rows, { maxChars: 150, perMessageCap: 1000 });
    // Newest-first admission: "z" (100) fits, "y" would push to 200 > 150 → stop.
    expect(out).toEqual([turn("user", "z".repeat(100))]);
  });

  it("always keeps the newest message even if it alone exceeds the budget", () => {
    const rows = [turn("user", "old"), turn("user", "z".repeat(100))];
    const out = selectHistory(rows, { maxChars: 10, perMessageCap: 1000 });
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("z".repeat(100));
  });

  it("caps an oversized single message and marks it truncated", () => {
    const rows = [turn("user", "p".repeat(10000))];
    const out = selectHistory(rows, { perMessageCap: 100 });
    expect(out[0].content.length).toBe(100);
    expect(out[0].content.endsWith("[truncated]")).toBe(true);
    expect(out[0].content.startsWith("p")).toBe(true);
  });

  it("counts capped (not original) length against the budget", () => {
    const rows = [
      turn("user", "a".repeat(5000)),
      turn("assistant", "b".repeat(5000)),
      turn("user", "c".repeat(5000)),
    ];
    // Each caps to 100; budget 250 admits all three (300 capped total > 250 would
    // drop one — check the cap is what's measured, not the 5000 originals).
    const out = selectHistory(rows, { maxChars: 250, perMessageCap: 100 });
    expect(out).toHaveLength(2);
    expect(out.every((m) => m.content.length === 100)).toBe(true);
  });

  it("keeps the same oldest message across turns until the slack is spent", () => {
    // A conversation growing ten chars a turn, well past a 100-char ceiling.
    // Trimming to the ceiling would move the front on every turn past the line;
    // with 40 chars of slack it may move at most once per 40 chars appended.
    const rows: ReturnType<typeof turn>[] = [];
    const fronts: string[] = [];
    let moves = 0;
    for (let i = 0; i < 60; i++) {
      rows.push(turn(i % 2 ? "assistant" : "user", String(i).padStart(10, "_")));
      const out = selectHistory(rows, { maxChars: 100, lowWater: 60, perMessageCap: 1000 });
      expect(size(out)).toBeLessThanOrEqual(100);
      if (fronts.length > 0 && out[0].content !== fronts[fronts.length - 1]) moves++;
      fronts.push(out[0].content);
    }
    const appendedPastCeiling = 60 * 10 - 100;
    expect(moves).toBeGreaterThan(0);
    expect(moves).toBeLessThanOrEqual(Math.ceil(appendedPastCeiling / 40));
  });

  it("cuts back to the low-water mark, not the ceiling", () => {
    // Eleven 10-char messages: 110 chars, ten over a 100-char ceiling.
    const rows = Array.from({ length: 11 }, (_, i) => turn("user", String(i).padStart(10, "_")));
    const out = selectHistory(rows, { maxChars: 100, lowWater: 60, perMessageCap: 1000 });
    // The old cut kept exactly 100. This one keeps the low-water mark plus at
    // most one message's worth of rounding — and still ends on the newest.
    expect(size(out)).toBeGreaterThan(60);
    expect(size(out)).toBeLessThanOrEqual(60 + 10);
    expect(out[out.length - 1]).toEqual(rows[10]);
  });

  it("never returns more than maxChars", () => {
    // A seeded generator, so a failure reproduces.
    let seed = 250;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 50; run++) {
      const rows = Array.from({ length: 1 + Math.floor(next() * 40) }, () =>
        turn("user", "m".repeat(1 + Math.floor(next() * 300))),
      );
      const maxChars = 300 + Math.floor(next() * 2000);
      const out = selectHistory(rows, { maxChars, perMessageCap: 1000 });
      expect(size(out)).toBeLessThanOrEqual(maxChars);
      expect(out[out.length - 1]).toEqual(rows[rows.length - 1]);
      // What is kept is always a contiguous, newest suffix.
      expect(out).toEqual(rows.slice(rows.length - out.length));
    }
  });

  it("behaves exactly as before when lowWater equals maxChars", () => {
    // The old rule: admit newest-first while it fits, newest always kept.
    const before = (rows: ReturnType<typeof turn>[], maxChars: number) => {
      const kept: ReturnType<typeof turn>[] = [];
      let used = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        const len = rows[i].content.length;
        if (kept.length > 0 && used + len > maxChars) break;
        kept.push(rows[i]);
        used += len;
      }
      return kept.reverse();
    };
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let run = 0; run < 50; run++) {
      const rows = Array.from({ length: 1 + Math.floor(next() * 30) }, () =>
        turn("assistant", "n".repeat(1 + Math.floor(next() * 200))),
      );
      const maxChars = 50 + Math.floor(next() * 1500);
      expect(selectHistory(rows, { maxChars, lowWater: maxChars, perMessageCap: 1000 })).toEqual(
        before(rows, maxChars),
      );
    }
  });
});
