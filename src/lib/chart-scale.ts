/**
 * The top of a bar chart's scale: the smallest round number at or above the
 * tallest bar, so the gridlines read 120 / 60 / 0 rather than 136 / 68 / 0.
 */
export function niceCeiling(max: number): number {
  if (!(max > 0)) return 0;
  const step = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) {
    if (m * step >= max) return Number((m * step).toPrecision(6));
  }
  return 10 * step;
}

/**
 * `locale` is the tag `useLocale()` gives, defaulting to the one these were
 * always formatted in so an untranslated caller reads as before.
 */

/** A gridline's number: "120", "1.5k" past ten thousand, "$2.50" for dollars. */
export function tickLabel(
  value: number,
  unit: "credits" | "usd",
  locale: string = "en-US",
): string {
  if (unit === "usd") {
    return value.toLocaleString(locale, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  }
  if (value >= 10_000) {
    return `${(value / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })}k`;
  }
  return value.toLocaleString(locale, { maximumFractionDigits: 1 });
}

/** "Tue 21 Oct" for a `YYYY-MM-DD` day, read as the calendar day it names. */
export function chartDay(day: string, locale: string = "en-GB"): string {
  const d = new Date(`${day}T12:00:00Z`);
  const weekday = d.toLocaleDateString(locale, { weekday: "short", timeZone: "UTC" });
  const date = d.toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: "UTC" });
  return `${weekday} ${date}`;
}

/** "9 Oct" for a `YYYY-MM-DD` day. */
export function chartDate(day: string, locale: string = "en-GB"): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}
