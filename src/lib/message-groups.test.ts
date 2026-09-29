import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Message } from "@/lib/agents-store";
import { dateDividers } from "./message-groups";

const msg = (id: string, createdAt: number, role: Message["role"] = "user"): Message => ({
  id,
  role,
  content: "…",
  createdAt,
});

/** Local time on a named day, so a label never depends on the runner's clock. */
const at = (y: number, month: number, d: number, h = 12, min = 0) =>
  new Date(y, month - 1, d, h, min).getTime();

describe("dateDividers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 2, 15, 12, 0, 0)); // 15 March 2026, local
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("has nothing to divide in an empty transcript", () => {
    expect([...dateDividers([])]).toEqual([]);
  });

  it("marks the first message of a one-day transcript and nothing after it", () => {
    const out = dateDividers([
      msg("m1", at(2026, 3, 15, 9)),
      msg("m2", at(2026, 3, 15, 9, 1), "assistant"),
      msg("m3", at(2026, 3, 15, 14)),
    ]);
    expect([...out]).toEqual([["m1", "Today"]]);
  });

  it("marks the first message of each day across three days", () => {
    const out = dateDividers([
      msg("m1", at(2026, 3, 13, 9)),
      msg("m2", at(2026, 3, 13, 9, 1), "assistant"),
      msg("m3", at(2026, 3, 14, 10)),
      msg("m4", at(2026, 3, 15, 8)),
      msg("m5", at(2026, 3, 15, 8, 1), "assistant"),
    ]);
    expect([...out]).toEqual([
      ["m1", "March 13"],
      ["m3", "Yesterday"],
      ["m4", "Today"],
    ]);
  });

  it("names today, yesterday, a day this year, and a day in another year", () => {
    const out = dateDividers([
      msg("older", at(2025, 12, 20)),
      msg("this-year", at(2026, 3, 1)),
      msg("yesterday", at(2026, 3, 14)),
      msg("today", at(2026, 3, 15)),
    ]);
    expect([...out]).toEqual([
      ["older", "December 20, 2025"],
      ["this-year", "March 1"],
      ["yesterday", "Yesterday"],
      ["today", "Today"],
    ]);
  });

  it("puts the divider on a reply when the reply is what opens the day", () => {
    // Asked at 23:58, answered four minutes later. The answer is the first
    // thing on the new day, so it carries the divider — the question keeps the
    // old one above it.
    const out = dateDividers([
      msg("q", at(2026, 3, 14, 23, 58)),
      msg("a", at(2026, 3, 15, 0, 2), "assistant"),
    ]);
    expect([...out]).toEqual([
      ["q", "Yesterday"],
      ["a", "Today"],
    ]);
  });

  it("keys by message id, so a lookup is by identity rather than position", () => {
    const out = dateDividers([msg("m1", at(2026, 3, 15))]);
    expect(out.get("m1")).toBe("Today");
    expect(out.get("m2")).toBeUndefined();
  });
});
