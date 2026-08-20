import { describe, it, expect } from "vitest";
import { selectHistory } from "./history";

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
});
