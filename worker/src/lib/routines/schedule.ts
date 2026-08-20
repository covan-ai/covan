import parser from "cron-parser";

/**
 * The next firing of `cron` strictly after `from`, resolved in `timezone`.
 *
 * A routine's frequency lives here, not in the Worker's cron trigger: the
 * trigger only asks "is anything due?" every five minutes, so "every 15
 * minutes", "hourly" and "Mondays at 09:00" all run on one engine.
 */
export function nextRunAt(cron: string, timezone: string, from: Date): Date {
  const it = parser.parseExpression(cron, { currentDate: from, tz: timezone });
  return it.next().toDate();
}

export function isValidCron(cron: string, timezone: string): boolean {
  try {
    const it = parser.parseExpression(cron, { tz: timezone });
    it.next(); // Trigger timezone validation
    return true;
  } catch {
    return false;
  }
}
