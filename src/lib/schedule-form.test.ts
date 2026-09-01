import { describe, it, expect } from "vitest";
import { toCron, fromCron, MIN_MINUTES, type ScheduleForm } from "./schedule-form";

describe("toCron", () => {
  it("writes an every-N-minutes schedule", () => {
    expect(toCron({ mode: "minutes", every: 15 })).toBe("*/15 * * * *");
  });

  it("writes an every-N-hours schedule that fires on the hour", () => {
    expect(toCron({ mode: "hours", every: 6 })).toBe("0 */6 * * *");
  });

  it("writes a daily schedule, zero-padding nothing the cron parser dislikes", () => {
    expect(toCron({ mode: "daily", hour: 9, minute: 0 })).toBe("0 9 * * *");
    expect(toCron({ mode: "daily", hour: 0, minute: 5 })).toBe("5 0 * * *");
  });
});

describe("fromCron", () => {
  it("reads back every shape toCron can write", () => {
    const forms: ScheduleForm[] = [
      { mode: "minutes", every: 5 },
      { mode: "minutes", every: 30 },
      { mode: "hours", every: 1 },
      { mode: "hours", every: 12 },
      { mode: "daily", hour: 9, minute: 0 },
      { mode: "daily", hour: 23, minute: 59 },
    ];
    for (const form of forms) {
      expect(fromCron(toCron(form))).toEqual(form);
    }
  });

  it("treats the bare hourly expression as every 1 hour", () => {
    // `0 * * * *` is the create dialog's historical default, so routines
    // already carry it. It means exactly what `0 */1 * * *` means.
    expect(fromCron("0 * * * *")).toEqual({ mode: "hours", every: 1 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(fromCron("  */10 * * * *  ")).toEqual({ mode: "minutes", every: 10 });
  });

  it("reads an interval below the floor rather than hiding it", () => {
    // Routines created before the picker existed can carry these. Returning the
    // form lets the picker show the real value and mark it invalid; returning
    // null would strand the user on a read-only schedule they cannot correct.
    expect(fromCron("*/1 * * * *")).toEqual({ mode: "minutes", every: 1 });
  });

  it("returns null for shapes the picker cannot express", () => {
    expect(fromCron("0 9 * * 1-5")).toBeNull(); // weekdays
    expect(fromCron("0 9 * * 1")).toBeNull(); // a single weekday
    expect(fromCron("0 9 1 * *")).toBeNull(); // monthly
    expect(fromCron("0 9 * 3 *")).toBeNull(); // a specific month
    expect(fromCron("*/15 9 * * *")).toBeNull(); // stepped minutes within an hour
  });

  it("returns null for anything that is not a five-field expression", () => {
    expect(fromCron("")).toBeNull();
    expect(fromCron("* * * *")).toBeNull();
    expect(fromCron("0 9 * * * *")).toBeNull();
    expect(fromCron("not a cron")).toBeNull();
  });

  it("returns null for out-of-range values", () => {
    expect(fromCron("*/0 * * * *")).toBeNull();
    expect(fromCron("*/60 * * * *")).toBeNull();
    expect(fromCron("0 */0 * * *")).toBeNull();
    expect(fromCron("0 */24 * * *")).toBeNull();
    expect(fromCron("60 9 * * *")).toBeNull();
    expect(fromCron("0 24 * * *")).toBeNull();
  });

  it("cannot represent a minute step above 59, which is why the picker must not build one", () => {
    expect(fromCron("*/60 * * * *")).toBeNull();
    expect(fromCron("*/90 * * * *")).toBeNull();
    // 59 is the largest one that round-trips.
    expect(fromCron("*/59 * * * *")).toEqual({ mode: "minutes", every: 59 });
  });
});

describe("MIN_MINUTES", () => {
  it("matches the engine's own heartbeat", () => {
    // wrangler.cron.toml runs the engine on `*/5 * * * *`. Offering anything
    // finer would display a promise the engine cannot keep.
    expect(MIN_MINUTES).toBe(5);
  });
});
