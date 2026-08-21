import parser from "cron-parser";

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
