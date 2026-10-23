// Cron expressions are an implementation detail of the routine engine. The
// interface never shows one, so every schedule passes through here first.
//
// This deliberately understands only the shapes the draft parser and the
// schedule form can produce. Anything else comes back untouched: a schedule
// described wrongly but confidently is worse than one shown as raw cron.

import { englishT, lookup, msg, type Translate } from "@/i18n";

const DAYS = [
  msg("Sundays"),
  msg("Mondays"),
  msg("Tuesdays"),
  msg("Wednesdays"),
  msg("Thursdays"),
  msg("Fridays"),
  msg("Saturdays"),
] as const;

/**
 * The English when nobody passed a `t`: `englishT`, plus the ordinal plurals
 * ("1st", "2nd", "3rd", "11th") it does not choose between — English's own
 * ordinal rules, which are what the old hand-written suffix table encoded.
 */
// i18n-ignore: English's own ordinal rules, for the English fallback only.
const englishOrdinals = new Intl.PluralRules("en", { type: "ordinal" });
const englishCronT: Translate = (key, options) => {
  if (options?.ordinal === true && typeof options.count === "number") {
    const form = options[`defaultValue_ordinal_${englishOrdinals.select(options.count)}`];
    if (typeof form === "string") return englishT(form, { ...options, count: options.count });
  }
  return englishT(key, options);
};

function timeOfDay(minute: string, hour: string): string | null {
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const m = Number(minute);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function cronToProse(expr: string, t: Translate = englishCronT): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // A specific month is a shape we never generate; describing it would mean
  // guessing at semantics the engine may not share.
  if (month !== "*") return expr;

  if (/^\*\/\d{1,2}$/.test(minute) && hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    const every = Number(minute.slice(2));
    if (every >= 1 && every <= 59) {
      return every === 1
        ? t("Every minute")
        : t("Every {{count}} minute", {
            count: every,
            defaultValue_other: "Every {{count}} minutes",
          });
    }
    return expr;
  }

  if (minute === "0" && dayOfMonth === "*" && dayOfWeek === "*") {
    if (hour === "*") return t("Every hour");
    // `0 */N * * *` is what the schedule picker writes for every-N-hours.
    const stepped = /^\*\/(\d{1,2})$/.exec(hour);
    if (stepped) {
      const every = Number(stepped[1]);
      if (every === 1) return t("Every hour");
      if (every >= 2 && every <= 23) {
        return t("Every {{count}} hour", {
          count: every,
          defaultValue_other: "Every {{count}} hours",
        });
      }
      return expr;
    }
  }

  const time = timeOfDay(minute, hour);
  if (!time) return expr;

  if (dayOfMonth === "*" && dayOfWeek === "*") return t("Every day at {{time}}", { time });
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return t("Weekdays at {{time}}", { time });
  if (dayOfMonth === "*" && /^[0-6]$/.test(dayOfWeek)) {
    return t("{{days}} at {{time}}", { days: lookup(t, DAYS[Number(dayOfWeek)]!), time });
  }
  if (dayOfWeek === "*" && /^\d{1,2}$/.test(dayOfMonth)) {
    const day = Number(dayOfMonth);
    if (day >= 1 && day <= 31) {
      return t("Monthly on the {{count}} at {{time}}", {
        count: day,
        ordinal: true,
        time,
        defaultValue_ordinal_one: "Monthly on the {{count}}st at {{time}}",
        defaultValue_ordinal_two: "Monthly on the {{count}}nd at {{time}}",
        defaultValue_ordinal_few: "Monthly on the {{count}}rd at {{time}}",
        defaultValue_ordinal_other: "Monthly on the {{count}}th at {{time}}",
      });
    }
  }

  return expr;
}

/**
 * The schedule as briefly as a list item can carry it (A7's pane): "Daily
 * 09:00", "Mondays 09:00", "Weekdays 08:30", "1st of month". Anything else is
 * `cronToProse`'s sentence.
 */
export function cronToShort(expr: string, t: Translate = englishCronT): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return cronToProse(expr, t);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const at = timeOfDay(minute!, hour!);
  if (month !== "*" || !at) return cronToProse(expr, t);
  if (dayOfMonth === "*" && dayOfWeek === "*") return t("Daily {{time}}", { time: at });
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return t("Weekdays {{time}}", { time: at });
  if (dayOfMonth === "*" && /^[0-6]$/.test(dayOfWeek!)) {
    return t("{{days}} {{time}}", { days: lookup(t, DAYS[Number(dayOfWeek)]!), time: at });
  }
  if (dayOfWeek === "*" && /^\d{1,2}$/.test(dayOfMonth!)) {
    const d = Number(dayOfMonth);
    if (d >= 1 && d <= 31) {
      return t("{{count}} of month", {
        count: d,
        ordinal: true,
        defaultValue_ordinal_one: "{{count}}st of month",
        defaultValue_ordinal_two: "{{count}}nd of month",
        defaultValue_ordinal_few: "{{count}}rd of month",
        defaultValue_ordinal_other: "{{count}}th of month",
      });
    }
  }
  return cronToProse(expr, t);
}
