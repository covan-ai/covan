// The interface never asks anyone to write a cron expression. This is the
// translation layer between the three shapes the picker offers and the cron
// string the engine actually schedules on.
//
// `fromCron` is deliberately narrow: it returns null for anything it cannot
// represent exactly, and the caller falls back to showing `cronToProse`. A
// picker that silently rounds `0 9 * * 1-5` to "every day at 09:00" would
// change a routine's schedule behind the user's back.

// The engine's own heartbeat is a five-minute cron trigger, so nothing finer
// than this can be honoured however precisely it is asked for.
export const MIN_MINUTES = 5;

export type ScheduleForm =
  | { mode: "minutes"; every: number }
  | { mode: "hours"; every: number }
  | { mode: "daily"; hour: number; minute: number };

export type ScheduleMode = ScheduleForm["mode"];

export function toCron(form: ScheduleForm): string {
  switch (form.mode) {
    case "minutes":
      return `*/${form.every} * * * *`;
    case "hours":
      return `0 */${form.every} * * *`;
    case "daily":
      return `${form.minute} ${form.hour} * * *`;
  }
}

/** A whole number in [min, max], or null. Rejects "07", "+7", "7.0" and "". */
function intInRange(field: string, min: number, max: number): number | null {
  if (!/^(0|[1-9]\d*)$/.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
}

// The N in a bare step field like `*/15`, or null if the field is not one.
function step(field: string, max: number): number | null {
  const match = /^\*\/(\d+)$/.exec(field);
  return match ? intInRange(match[1], 1, max) : null;
}

export function fromCron(expr: string): ScheduleForm | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Every shape below repeats through the whole week and year. Anything that
  // narrows the day or month is outside what the picker can express.
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") return null;

  if (hour === "*") {
    const every = step(minute, 59);
    if (every !== null) return { mode: "minutes", every };
    // `0 * * * *` — the create dialog's historical default — is hourly.
    if (minute === "0") return { mode: "hours", every: 1 };
    return null;
  }

  const hourStep = step(hour, 23);
  if (hourStep !== null) {
    // Only on-the-hour steps. `*/30 */6 * * *` fires twice per matching hour,
    // which "every 6 hours" does not describe.
    return minute === "0" ? { mode: "hours", every: hourStep } : null;
  }

  const h = intInRange(hour, 0, 23);
  const m = intInRange(minute, 0, 59);
  if (h === null || m === null) return null;
  return { mode: "daily", hour: h, minute: m };
}
