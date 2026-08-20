const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * "in 24 minutes" / "2 hours ago". `now` is injectable so tests do not depend
 * on the wall clock.
 *
 * Anything inside a minute collapses to "now": a next-run time counting down in
 * seconds is noise, and it would force a re-render every second to stay honest.
 */
export function formatRelative(epochMs: number, now: number = Date.now()): string {
  const diff = epochMs - now;
  const abs = Math.abs(diff);
  if (abs < MINUTE) return "now";

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  if (abs < HOUR) return rtf.format(Math.round(diff / MINUTE), "minute");
  if (abs < DAY) return rtf.format(Math.round(diff / HOUR), "hour");
  return rtf.format(Math.round(diff / DAY), "day");
}
