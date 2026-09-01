import { describe, it, expect } from "vitest";
import { formatRelative, documentAge, STALE_AFTER_DAYS } from "./relative-time";

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);

describe("formatRelative", () => {
  it("describes the near future", () => {
    expect(formatRelative(NOW + 24 * 60_000, NOW)).toBe("in 24 minutes");
    expect(formatRelative(NOW + 3 * 3_600_000, NOW)).toBe("in 3 hours");
  });

  it("describes the past", () => {
    expect(formatRelative(NOW - 2 * 3_600_000, NOW)).toBe("2 hours ago");
    expect(formatRelative(NOW - 3 * 86_400_000, NOW)).toBe("3 days ago");
  });

  it("collapses anything under a minute rather than counting seconds at the user", () => {
    expect(formatRelative(NOW + 5_000, NOW)).toBe("now");
    expect(formatRelative(NOW - 5_000, NOW)).toBe("now");
  });
});

describe("documentAge", () => {
  const NOW = Date.parse("2026-09-01T12:00:00Z");
  const daysAgo = (n: number) => NOW - n * 86_400_000;

  it("says today for anything inside a day", () => {
    expect(documentAge(NOW, NOW).label).toBe("today");
    expect(documentAge(NOW - 3_600_000, NOW).label).toBe("today");
  });

  it("counts days, then months, then years", () => {
    expect(documentAge(daysAgo(12), NOW).label).toBe("12 days ago");
    expect(documentAge(daysAgo(95), NOW).label).toBe("3 months ago");
    expect(documentAge(daysAgo(400), NOW).label).toBe("1 year ago");
  });

  it("rounds down, so it never claims more age than there is", () => {
    // Overstating raises a false alarm; understating hides a real staleness.
    // Between the two, the number is the one that must not exaggerate — the
    // threshold below is what is allowed to be strict.
    expect(documentAge(daysAgo(59), NOW).label).toBe("1 month ago");
    expect(documentAge(daysAgo(364), NOW).label).toBe("12 months ago");
  });

  it("turns stale at ninety days, not before", () => {
    expect(documentAge(daysAgo(89), NOW).stale).toBe(false);
    expect(documentAge(daysAgo(STALE_AFTER_DAYS), NOW).stale).toBe(true);
  });

  it("treats a future date as today rather than as negative age", () => {
    // Clock skew between a browser and Postgres is real, and "in 2 hours ago"
    // is not a thing to render.
    expect(documentAge(NOW + 7_200_000, NOW)).toEqual({ label: "today", stale: false });
  });
});
