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

/**
 * How old a document is allowed to get before the interface says so.
 *
 * Ninety days because that is the interval the failure actually turns on: an
 * onboarding document written once and wrong three months later is the thing
 * teams upload first and nobody remembers to revisit. Longer and the warning
 * arrives after the damage; much shorter and every chip in a working workspace
 * is a warning, which is the same as none.
 */
export const STALE_AFTER_DAYS = 90;

export type DocumentAge = {
  /** "today", "12 days ago", "7 months ago". */
  label: string;
  stale: boolean;
};

/**
 * The age of an uploaded document, in the coarsest unit that is still true.
 *
 * Separate from `formatRelative` above, which stops at days because it serves a
 * routine's next run — "in 3 days" is what you want there and "247 days ago" is
 * not what you want here. Months and years are how people hold the age of a
 * document.
 *
 * Rounded **down**, always. Overstating an age raises a false alarm; understating
 * one hides a real staleness, and between the two the second is the failure this
 * exists to prevent — so the number never claims more age than there is, and the
 * threshold is crossed only once it genuinely has been.
 */
export function documentAge(uploadedAt: number, now: number = Date.now()): DocumentAge {
  const days = Math.floor(Math.max(0, now - uploadedAt) / DAY);
  const stale = days >= STALE_AFTER_DAYS;

  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "always" });
  if (days < 1) return { label: "today", stale };
  if (days < 30) return { label: rtf.format(-days, "day"), stale };
  if (days < 365) return { label: rtf.format(-Math.floor(days / 30), "month"), stale };
  return { label: rtf.format(-Math.floor(days / 365), "year"), stale };
}
