import { CronExpressionParser } from "cron-parser";

/**
 * The next firing of `cron` strictly after `from`, resolved in `timezone`.
 *
 * A routine's frequency lives here, not in the engine's heartbeat: the
 * heartbeat only asks "is anything due?", on a fixed interval that belongs to
 * the deployment — five minutes on the Cloudflare trigger, ROUTINE_TICK_MS on
 * Node. So "every 15 minutes", "hourly" and "Mondays at 09:00" all run on one
 * engine.
 */
export function nextRunAt(cron: string, timezone: string, from: Date): Date {
  const it = CronExpressionParser.parse(cron, { currentDate: from, tz: timezone });
  return it.next().toDate();
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How many days one period of `cron` covers, as of `at` — for a report that
 * reads "the last N days" and should read the period it is reporting on.
 *
 * The distance between the two most recent firings at or before `at`, so a
 * routine that runs Mondays and Thursdays reads the three or four days since
 * the one before, rather than whatever the next gap happens to be. A
 * scheduled run starts a little after its slot (the engine looks every few
 * minutes), and asking for the firings before `at` rather than the distance
 * from the earlier one to `at` keeps that lateness out of the answer: a weekly
 * routine that started two minutes late is still a seven-day window, not
 * eight.
 *
 * Rounded rather than ceiled, so a daylight-saving week of 167 or 169 hours is
 * still seven days. Clamped to 1–365, the range `workspace_coverage_gaps` and
 * `workspace_coverage_totals` clamp to themselves (0076): anything more often
 * than daily reads one day, because a day is the smallest window those reads
 * take.
 *
 * An expression this cannot step back through — none should reach it, since
 * every write path validates with `isValidCron` — answers `fallback` rather
 * than throwing, because a report with yesterday's window is better than a
 * routine that fails on a cadence question.
 */
export function windowDays(cron: string, timezone: string, at: Date, fallback = 7): number {
  try {
    const it = CronExpressionParser.parse(cron, {
      // One millisecond past `at`, so a run that starts exactly on its slot
      // counts that slot as the most recent firing rather than the one before.
      currentDate: new Date(at.getTime() + 1),
      tz: timezone,
    });
    const latest = it.prev().toDate();
    const before = it.prev().toDate();
    const days = Math.round((latest.getTime() - before.getTime()) / DAY_MS);
    return Math.min(365, Math.max(1, days));
  } catch {
    return fallback;
  }
}

export function isValidCron(cron: string, timezone: string): boolean {
  try {
    const it = CronExpressionParser.parse(cron, { tz: timezone });
    it.next(); // Trigger timezone validation
    return true;
  } catch {
    return false;
  }
}
