import { englishT, type Translate } from "@/i18n";

/**
 * Lists under date eyebrows (DESIGN.md §7, A4): Today, Yesterday, Earlier —
 * in the order the items came, so a list the server sorted by what needs you
 * keeps that order inside each day.
 *
 * `label` is the English key; whoever draws the eyebrow says `t(label)`.
 */
export type DayGroup<T> = { label: "Today" | "Yesterday" | "Earlier"; items: T[] };

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function groupByDay<T>(
  items: T[],
  timeOf: (item: T) => number,
  now: number = Date.now(),
): DayGroup<T>[] {
  const today = startOfDay(now);
  const yesterday = today - 24 * 60 * 60 * 1000;
  const groups: DayGroup<T>[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Earlier", items: [] },
  ];
  for (const item of items) {
    const t = timeOf(item);
    groups[t >= today ? 0 : t >= yesterday ? 1 : 2]!.items.push(item);
  }
  return groups.filter((g) => g.items.length > 0);
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Every function below takes `t` and `locale` after `now`, defaulting to the
 * English and the region it has always been formatted in, so a caller that
 * has not been translated yet reads exactly as before.
 */
const EN = "en-GB";

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * A moment, sorted into the coarsest bucket that still says when it was. The
 * words come from the caller's `t`; the bucket is what the functions below
 * used to tell apart by reading their own output, which no longer works once
 * the output is in another language.
 */
type Moment =
  | { kind: "now" }
  | { kind: "minutes"; n: number }
  | { kind: "hours"; n: number }
  | { kind: "today"; clock: string }
  | { kind: "yesterday" }
  | { kind: "weekday"; text: string }
  | { kind: "date"; text: string };

function moment(at: number, now: number, locale: string): Moment {
  const ago = now - at;
  if (ago < MINUTE) return { kind: "now" };
  if (ago < HOUR) return { kind: "minutes", n: Math.floor(ago / MINUTE) };
  if (ago < 4 * HOUR) return { kind: "hours", n: Math.floor(ago / HOUR) };
  const today = startOfDay(now);
  const d = new Date(at);
  if (at >= today) return { kind: "today", clock: clock(d) };
  if (at >= today - 24 * HOUR) return { kind: "yesterday" };
  if (at >= today - 6 * 24 * HOUR) {
    return { kind: "weekday", text: d.toLocaleDateString(locale, { weekday: "short" }) };
  }
  return { kind: "date", text: d.toLocaleDateString(locale, { day: "numeric", month: "short" }) };
}

/**
 * The time on a row, as short as it can be and still be read at a glance:
 * "now", "12 min", "3 h" for the last few hours, "09:12" for earlier today,
 * "Yesterday", a weekday within the week, and "12 Oct" before that.
 */
export function shortTime(
  at: number,
  now: number = Date.now(),
  t: Translate = englishT,
  locale: string = EN,
): string {
  const m = moment(at, now, locale);
  switch (m.kind) {
    case "now":
      return t("now");
    case "minutes":
      return t("{{count}} min", { count: m.n, defaultValue_other: "{{count}} min" });
    case "hours":
      return t("{{count}} h", { count: m.n, defaultValue_other: "{{count}} h" });
    case "today":
      return m.clock;
    case "yesterday":
      return t("Yesterday");
    default:
      return m.text;
  }
}

/** "today, 09:00", "yesterday, 18:40", "Mon, 09:00", "12 Oct" — a past moment in a sentence. */
export function lastActivityWords(
  at: number,
  now: number = Date.now(),
  t: Translate = englishT,
  locale: string = EN,
): string {
  const d = new Date(at);
  const hm = clock(d);
  const today = startOfDay(now);
  if (at >= today) return t("today, {{time}}", { time: hm });
  if (at >= today - 24 * HOUR) return t("yesterday, {{time}}", { time: hm });
  if (at >= today - 6 * 24 * HOUR) {
    return t("{{weekday}}, {{time}}", {
      weekday: d.toLocaleDateString(locale, { weekday: "short" }),
      time: hm,
    });
  }
  return d.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

/** "12 min ago", "3 h ago", "Today, 09:12", "Yesterday", "Mon", "12 Oct" — A5's Last activity. */
export function lastActivityLabel(
  at: number,
  now: number = Date.now(),
  t: Translate = englishT,
  locale: string = EN,
): string {
  const m = moment(at, now, locale);
  switch (m.kind) {
    case "now":
      return t("just now");
    case "minutes":
      return t("{{count}} min ago", { count: m.n, defaultValue_other: "{{count}} min ago" });
    case "hours":
      return t("{{count}} h ago", { count: m.n, defaultValue_other: "{{count}} h ago" });
    case "today":
      return t("Today, {{time}}", { time: m.clock });
    case "yesterday":
      return t("Yesterday");
    default:
      return m.text;
  }
}

/** "10:06" today, "Yesterday", then "20 Oct" — the board's clock, not "40 min ago". */
export function clockTime(
  at: number,
  now: number = Date.now(),
  t: Translate = englishT,
  locale: string = EN,
): string {
  const d = new Date(at);
  const today = startOfDay(now);
  if (at >= today) return clock(d);
  if (at >= today - 86_400_000) return t("Yesterday");
  return d.toLocaleDateString(locale, { day: "numeric", month: "short" });
}

/** "Today, 10:04", "Yesterday", "20 Oct" — the ledger's When (A15). */
export function ledgerWhen(
  at: number,
  now: number = Date.now(),
  t: Translate = englishT,
  locale: string = EN,
): string {
  const today = startOfDay(now);
  if (at >= today) return t("Today, {{time}}", { time: clock(new Date(at)) });
  return clockTime(at, now, t, locale);
}

/** "5 h ago", "Yesterday", "Mon", "2 w ago", "1 mo ago": the Modified column. */
export function agoShort(
  at: number,
  now: number = Date.now(),
  t: Translate = englishT,
  locale: string = EN,
): string {
  const ago = Math.max(0, now - at);
  if (ago < 60 * MINUTE) {
    const n = Math.max(1, Math.floor(ago / MINUTE));
    return t("{{count}} min ago", { count: n, defaultValue_other: "{{count}} min ago" });
  }
  if (ago < 24 * HOUR) {
    const n = Math.floor(ago / HOUR);
    return t("{{count}} h ago", { count: n, defaultValue_other: "{{count}} h ago" });
  }
  const days = Math.floor(ago / (24 * HOUR));
  if (days < 2) return t("Yesterday");
  if (days < 7) return new Date(at).toLocaleDateString(locale, { weekday: "short" });
  if (days < 30) {
    const n = Math.floor(days / 7);
    return t("{{count}} w ago", { count: n, defaultValue_other: "{{count}} w ago" });
  }
  if (days < 365) {
    const n = Math.floor(days / 30);
    return t("{{count}} mo ago", { count: n, defaultValue_other: "{{count}} mo ago" });
  }
  const n = Math.floor(days / 365);
  return t("{{count}} y ago", { count: n, defaultValue_other: "{{count}} y ago" });
}

/** "Synced 12 min ago", "Synced yesterday", "Synced on Mon" (A8). */
export function syncedWords(
  at: number,
  now: number = Date.now(),
  t: Translate = englishT,
  locale: string = EN,
): string {
  const ago = Math.max(0, now - at);
  const days = Math.floor(ago / (24 * HOUR));
  if (days >= 2 && days < 7) {
    return t("Synced on {{weekday}}", {
      weekday: new Date(at).toLocaleDateString(locale, { weekday: "short" }),
    });
  }
  if (days >= 1 && days < 2) return t("Synced yesterday");
  return t("Synced {{when}}", { when: agoShort(at, now, t, locale) });
}
