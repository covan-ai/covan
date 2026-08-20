// Cron expressions are an implementation detail of the routine engine. The
// interface never shows one, so every schedule passes through here first.
//
// This deliberately understands only the shapes the draft parser and the
// schedule form can produce. Anything else comes back untouched: a schedule
// described wrongly but confidently is worse than one shown as raw cron.

const DAYS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
] as const;

function timeOfDay(minute: string, hour: string): string | null {
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null;
  const m = Number(minute);
  const h = Number(hour);
  if (m > 59 || h > 23) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function ordinal(n: number): string {
  const suffixes = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffixes[(v - 20) % 10] ?? suffixes[v] ?? suffixes[0]}`;
}

export function cronToProse(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // A specific month is a shape we never generate; describing it would mean
  // guessing at semantics the engine may not share.
  if (month !== "*") return expr;

  if (/^\*\/\d{1,2}$/.test(minute) && hour === "*" && dayOfMonth === "*" && dayOfWeek === "*") {
    const every = Number(minute.slice(2));
    if (every >= 1 && every <= 59) {
      return every === 1 ? "Every minute" : `Every ${every} minutes`;
    }
    return expr;
  }

  if (minute === "0" && dayOfMonth === "*" && dayOfWeek === "*") {
    if (hour === "*") return "Every hour";
    // `0 */N * * *` is what the schedule picker writes for every-N-hours.
    const stepped = /^\*\/(\d{1,2})$/.exec(hour);
    if (stepped) {
      const every = Number(stepped[1]);
      if (every === 1) return "Every hour";
      if (every >= 2 && every <= 23) return `Every ${every} hours`;
      return expr;
    }
  }

  const time = timeOfDay(minute, hour);
  if (!time) return expr;

  if (dayOfMonth === "*" && dayOfWeek === "*") return `Every day at ${time}`;
  if (dayOfMonth === "*" && dayOfWeek === "1-5") return `Weekdays at ${time}`;
  if (dayOfMonth === "*" && /^[0-6]$/.test(dayOfWeek)) {
    return `${DAYS[Number(dayOfWeek)]} at ${time}`;
  }
  if (dayOfWeek === "*" && /^\d{1,2}$/.test(dayOfMonth)) {
    const day = Number(dayOfMonth);
    if (day >= 1 && day <= 31) return `Monthly on the ${ordinal(day)} at ${time}`;
  }

  return expr;
}
