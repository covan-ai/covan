import type { Message } from "./agents-store";

/**
 * What to call the day a message was sent on, and which messages open one.
 *
 * "Today", "Yesterday", and explicit dates for older messages. Uses local time
 * rather than UTC — a message sent at 11 PM appears under "Today" if it is
 * still today where the reader is, not where the server is.
 */

function dateLabel(ts: number): string {
  const date = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const isSameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (isSameDay(date, today)) return "Today";
  if (isSameDay(date, yesterday)) return "Yesterday";

  // "March 15" for this year, "March 15, 2025" for other years
  const sameYear = date.getFullYear() === today.getFullYear();
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * Which messages open a new calendar day, and what that day is called.
 *
 * Keyed by message id and not by index: the transcript looks a divider up while
 * it draws a turn, so it never has to remember what it drew last. A message
 * absent from the map opens nothing and draws no divider.
 *
 * The day itself is compared rather than the label. The two agree today — one
 * label per day — but a day boundary is the real question, and asking it
 * directly means a later change to how a day is *named* cannot silently move
 * where the lines fall.
 */
export function dateDividers(messages: Message[]): Map<string, string> {
  const dividers = new Map<string, string>();
  let previousDay: string | null = null;

  for (const msg of messages) {
    const day = new Date(msg.createdAt).toDateString();
    if (day !== previousDay) dividers.set(msg.id, dateLabel(msg.createdAt));
    previousDay = day;
  }

  return dividers;
}
