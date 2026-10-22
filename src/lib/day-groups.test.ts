import { describe, expect, it } from "vitest";
import { clockTime, groupByDay, lastActivityLabel, shortTime } from "./day-groups";
import { shortName } from "./monogram";

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

describe("a table's last activity", () => {
  it("reads like the board: minutes and hours ago, then today's time, then the day", () => {
    expect(lastActivityLabel(NOW - 12 * 60 * 1000, NOW)).toBe("12 min ago");
    expect(lastActivityLabel(NOW - 60 * 60 * 1000, NOW)).toBe("1 h ago");
    expect(lastActivityLabel(at(22, 9, 12), NOW)).toBe("Today, 09:12");
    expect(lastActivityLabel(at(21, 9), NOW)).toBe("Yesterday");
    expect(lastActivityLabel(at(19, 9), NOW)).toBe("Mon");
    expect(shortName("Can Bora")).toBe("Can B.");
    expect(shortName("Mina")).toBe("Mina");
  });
});

describe("clockTime", () => {
  const now = new Date(2026, 9, 22, 11, 30).getTime();
  it("is the clock today, Yesterday, then the date", () => {
    expect(clockTime(new Date(2026, 9, 22, 10, 6).getTime(), now)).toBe("10:06");
    expect(clockTime(new Date(2026, 9, 21, 23, 59).getTime(), now)).toBe("Yesterday");
    expect(clockTime(new Date(2026, 9, 20, 9, 0).getTime(), now)).toBe("20 Oct");
  });
});
