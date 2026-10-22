import { describe, expect, it } from "vitest";
import { groupByDay, shortTime } from "./day-groups";

const NOW = new Date(2026, 9, 22, 14, 0).getTime(); // Thursday 22 October, 14:00
const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

describe("days on a list", () => {
  it("groups under Today, Yesterday and Earlier, keeping the order it was given", () => {
    const items = [at(22, 9), at(21, 18), at(22, 13), at(19, 10)];
    const groups = groupByDay(items, (t) => t, NOW);
    expect(groups.map((g) => g.label)).toEqual(["Today", "Yesterday", "Earlier"]);
    expect(groups[0]!.items).toEqual([at(22, 9), at(22, 13)]);
  });

  it("says when as briefly as it can", () => {
    expect(shortTime(NOW - 20 * 1000, NOW)).toBe("now");
    expect(shortTime(NOW - 12 * 60 * 1000, NOW)).toBe("12 min");
    expect(shortTime(NOW - 3 * 60 * 60 * 1000, NOW)).toBe("3 h");
    expect(shortTime(at(22, 9, 12), NOW)).toBe("09:12");
    expect(shortTime(at(21, 9), NOW)).toBe("Yesterday");
    expect(shortTime(at(19, 9), NOW)).toBe("Mon");
    expect(shortTime(at(2, 9), NOW)).toBe("2 Oct");
  });
});
