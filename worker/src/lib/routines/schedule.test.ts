import { describe, it, expect } from "vitest";
import { nextRunAt, isValidCron, windowDays } from "./schedule";

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

describe("nextRunAt as the first scheduled run", () => {
  it("returns a future instant, never the current one", () => {
    const from = new Date("2026-08-26T14:32:00Z");
    const next = nextRunAt("0 9 * * *", "UTC", from);

    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.toISOString()).toBe("2026-08-27T09:00:00.000Z");
  });

  it("does not fire immediately for a frequent schedule either", () => {
    const from = new Date("2026-08-26T14:32:00Z");
    const next = nextRunAt("*/15 * * * *", "UTC", from);

    expect(next.getTime()).toBeGreaterThan(from.getTime());
    expect(next.toISOString()).toBe("2026-08-26T14:45:00.000Z");
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

/**
 * covan-cloud#307. The coverage report reads "the last N days", and N used to
 * be seven whatever the schedule said — so an owner who edited the weekly
 * template to daily got a daily email of the same rolling week.
 */
describe("windowDays", () => {
  it("is seven for the weekly template, even when the run starts a little late", () => {
    // Mondays 09:00 UTC; 2026-10-12 is a Monday. Two minutes late is still a week.
    expect(windowDays("0 9 * * 1", "UTC", new Date("2026-10-12T09:02:00Z"))).toBe(7);
  });

  it("counts a run that starts exactly on its slot as that slot's period", () => {
    expect(windowDays("0 9 * * 1", "UTC", new Date("2026-10-12T09:00:00Z"))).toBe(7);
  });

  it("is one for a daily schedule", () => {
    expect(windowDays("0 9 * * *", "UTC", new Date("2026-10-12T09:03:00Z"))).toBe(1);
  });

  it("is one, never zero, for anything more often than daily", () => {
    expect(windowDays("*/15 * * * *", "UTC", new Date("2026-10-12T09:03:00Z"))).toBe(1);
    expect(windowDays("0 * * * *", "UTC", new Date("2026-10-12T09:03:00Z"))).toBe(1);
  });

  it("reads the period that just ended on an uneven schedule", () => {
    // Mondays and Thursdays: Thursday's run covers the three days since
    // Monday, and Monday's the four since Thursday.
    const cron = "0 9 * * 1,4";
    expect(windowDays(cron, "UTC", new Date("2026-10-15T09:01:00Z"))).toBe(3);
    expect(windowDays(cron, "UTC", new Date("2026-10-19T09:01:00Z"))).toBe(4);
  });

  it("is the month's length for a monthly schedule", () => {
    // 1st of the month: 2026-10-01 back to 2026-09-01 is thirty days.
    expect(windowDays("0 9 1 * *", "UTC", new Date("2026-10-01T09:01:00Z"))).toBe(30);
  });

  it("stays seven across a daylight-saving week", () => {
    // Europe/Berlin leaves DST on 2026-10-25, so the week ending Monday
    // 2026-10-26 is 169 hours long.
    expect(windowDays("0 9 * * 1", "Europe/Berlin", new Date("2026-10-26T08:05:00Z"))).toBe(7);
  });

  it("answers the fallback rather than throwing on an expression it cannot read", () => {
    expect(windowDays("not a cron", "UTC", new Date("2026-10-12T09:00:00Z"))).toBe(7);
    expect(windowDays("not a cron", "UTC", new Date("2026-10-12T09:00:00Z"), 3)).toBe(3);
  });
});
