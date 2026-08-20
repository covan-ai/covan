import { describe, it, expect } from "vitest";
import { cronToProse } from "./cron-to-prose";

describe("cronToProse", () => {
  it.each([
    ["*/5 * * * *", "Every 5 minutes"],
    ["*/1 * * * *", "Every minute"],
    ["0 * * * *", "Every hour"],
    // The shape the schedule picker writes for its every-N-hours mode.
    ["0 */1 * * *", "Every hour"],
    ["0 */6 * * *", "Every 6 hours"],
    ["0 */23 * * *", "Every 23 hours"],
    ["0 9 * * *", "Every day at 09:00"],
    ["30 14 * * *", "Every day at 14:30"],
    ["0 9 * * 1", "Mondays at 09:00"],
    ["0 9 * * 0", "Sundays at 09:00"],
    ["0 9 * * 1-5", "Weekdays at 09:00"],
    ["0 9 1 * *", "Monthly on the 1st at 09:00"],
    ["0 9 2 * *", "Monthly on the 2nd at 09:00"],
    ["0 9 3 * *", "Monthly on the 3rd at 09:00"],
    ["0 9 11 * *", "Monthly on the 11th at 09:00"],
    ["0 9 21 * *", "Monthly on the 21st at 09:00"],
  ])("renders %s as %s", (expr, prose) => {
    expect(cronToProse(expr)).toBe(prose);
  });

  // Showing a wrong schedule confidently is worse than showing an ugly one
  // honestly, so anything unrecognised comes back untouched.
  it.each([
    ["0 9 * 3 *"], // a month field we do not describe
    ["0 9 * * 6#2"], // nth-weekday syntax
    ["not a cron"],
    ["0 9 * *"], // too few fields
    ["99 99 * * *"], // out of range
  ])("returns %s unchanged when it cannot describe it", (expr) => {
    expect(cronToProse(expr)).toBe(expr);
  });
});
