/**
 * Lists under date eyebrows (DESIGN.md §7, A4): Today, Yesterday, Earlier —
 * in the order the items came, so a list the server sorted by what needs you
 * keeps that order inside each day.
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
 * The time on a row, as short as it can be and still be read at a glance:
 * "now", "12 min", "3 h" for the last few hours, "09:12" for earlier today,
 * "Yesterday", a weekday within the week, and "12 Oct" before that.
 */
export function shortTime(at: number, now: number = Date.now()): string {
  const ago = now - at;
  if (ago < MINUTE) return "now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min`;
  if (ago < 4 * HOUR) return `${Math.floor(ago / HOUR)} h`;
  const today = startOfDay(now);
  const d = new Date(at);
  if (at >= today) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (at >= today - 24 * HOUR) return "Yesterday";
  if (at >= today - 6 * 24 * HOUR) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "today, 09:00", "yesterday, 18:40", "Mon, 09:00", "12 Oct" — a past moment in a sentence. */
export function lastActivityWords(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const today = startOfDay(now);
  if (at >= today) return `today, ${hm}`;
  if (at >= today - 24 * HOUR) return `yesterday, ${hm}`;
  if (at >= today - 6 * 24 * HOUR)
    return `${d.toLocaleDateString("en-GB", { weekday: "short" })}, ${hm}`;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "12 min ago", "3 h ago", "Today, 09:12", "Yesterday", "Mon", "12 Oct" — A5's Last activity. */
export function lastActivityLabel(at: number, now: number = Date.now()): string {
  const short = shortTime(at, now);
  if (short === "now") return "just now";
  if (/min$| h$/.test(short)) return `${short} ago`;
  if (/^\d{2}:\d{2}$/.test(short)) return `Today, ${short}`;
  return short;
}

/** "10:06" today, "Yesterday", then "20 Oct" — the board's clock, not "40 min ago". */
export function clockTime(at: number, now: number = Date.now()): string {
  const d = new Date(at);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (at >= today.getTime()) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (at >= today.getTime() - 86_400_000) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "Today, 10:04", "Yesterday", "20 Oct" — the ledger's When (A15). */
export function ledgerWhen(at: number, now: number = Date.now()): string {
  const clock = clockTime(at, now);
  return /^\d{2}:\d{2}$/.test(clock) ? `Today, ${clock}` : clock;
}

/** "5 h ago", "Yesterday", "Mon", "2 w ago", "1 mo ago": the Modified column. */
export function agoShort(at: number, now: number = Date.now()): string {
  const MIN = 60_000;
  const ago = Math.max(0, now - at);
  if (ago < 60 * MIN) return `${Math.max(1, Math.floor(ago / MIN))} min ago`;
  if (ago < 24 * 60 * MIN) return `${Math.floor(ago / (60 * MIN))} h ago`;
  const days = Math.floor(ago / (24 * 60 * MIN));
  if (days < 2) return "Yesterday";
  if (days < 7) return new Date(at).toLocaleDateString("en-GB", { weekday: "short" });
  if (days < 30) return `${Math.floor(days / 7)} w ago`;
  if (days < 365) return `${Math.floor(days / 30)} mo ago`;
  return `${Math.floor(days / 365)} y ago`;
}

/** "Synced 12 min ago", "Synced yesterday", "Synced on Mon" (A8). */
export function syncedWords(at: number, now: number = Date.now()): string {
  const ago = agoShort(at, now);
  if (ago === "Yesterday") return "Synced yesterday";
  return /ago$/.test(ago) ? `Synced ${ago}` : `Synced on ${ago}`;
}
