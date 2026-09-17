import type { Message } from "./agents-store";

/**
 * Group messages by calendar date for rendering date dividers.
 *
 * "Today", "Yesterday", and explicit dates for older messages. Uses local time
 * rather than UTC — a message sent at 11 PM appears under "Today" if it is
 * still today where the reader is, not where the server is.
 */

type MessageGroup = {
  label: string;
  messages: Message[];
};

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

export function groupMessagesByDate(messages: Message[]): MessageGroup[] {
  if (messages.length === 0) return [];

  const groups: MessageGroup[] = [];
  let currentLabel = dateLabel(messages[0].createdAt);
  let currentMessages: Message[] = [];

  for (const msg of messages) {
    const label = dateLabel(msg.createdAt);
    if (label !== currentLabel) {
      groups.push({ label: currentLabel, messages: currentMessages });
      currentLabel = label;
      currentMessages = [];
    }
    currentMessages.push(msg);
  }

  if (currentMessages.length > 0) {
    groups.push({ label: currentLabel, messages: currentMessages });
  }

  return groups;
}
