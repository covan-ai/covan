import { describe, it, expect } from "vitest";
import { formatRelative } from "./relative-time";

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
