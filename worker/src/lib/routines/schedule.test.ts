import { describe, it, expect } from "vitest";
import { nextRunAt, isValidCron } from "./schedule";

describe("nextRunAt", () => {
  it("advances a quarter-hourly routine to the next quarter", () => {
    const from = new Date("2026-08-14T10:07:00Z");
    expect(nextRunAt("*/15 * * * *", "UTC", from).toISOString()).toBe("2026-08-14T10:15:00.000Z");
  });

  it("resolves a daily time in the routine's own timezone, not UTC", () => {
    // 09:00 Istanbul (UTC+3) on 2026-08-17 is 06:00 UTC.
    const from = new Date("2026-08-14T10:00:00Z");
    expect(nextRunAt("0 9 * * 1", "Europe/Istanbul", from).toISOString()).toBe(
      "2026-08-17T06:00:00.000Z",
    );
  });

  it("keeps local wall-clock time across a DST transition", () => {
    // Europe/Berlin leaves DST at 03:00 on 2026-10-25. A 09:00 local routine is
    // 07:00 UTC before that Sunday and 08:00 UTC after it.
    const before = nextRunAt("0 9 * * *", "Europe/Berlin", new Date("2026-10-23T12:00:00Z"));
    const after = nextRunAt("0 9 * * *", "Europe/Berlin", new Date("2026-10-25T12:00:00Z"));
    expect(before.toISOString()).toBe("2026-10-24T07:00:00.000Z");
    expect(after.toISOString()).toBe("2026-10-26T08:00:00.000Z");
  });

  it("never returns a time at or before `from`", () => {
    const from = new Date("2026-08-14T10:15:00Z");
    expect(nextRunAt("*/15 * * * *", "UTC", from).getTime()).toBeGreaterThan(from.getTime());
  });
});

describe("isValidCron", () => {
  it("accepts well-formed expressions", () => {
    expect(isValidCron("*/15 * * * *", "UTC")).toBe(true);
    expect(isValidCron("0 9 * * 1", "Europe/Istanbul")).toBe(true);
  });

  it("rejects malformed expressions and unknown timezones", () => {
    expect(isValidCron("not a cron", "UTC")).toBe(false);
    expect(isValidCron("*/15 * * * *", "Mars/Olympus")).toBe(false);
  });
});
