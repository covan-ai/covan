export type HistoryTurn = { role: "user" | "assistant"; content: string };

// Marker appended when a single message is truncated to the per-message cap, so
// the model can tell the content was cut rather than genuinely ending there.
const TRUNCATION_MARK = "\n…[truncated]";

/**
 * Trim one message's content to at most `cap` chars, keeping the head (the
 * opening usually carries the intent; a huge paste's tail is rarely needed).
 * Returns the original string when it already fits.
 */
function capContent(content: string, cap: number): string {
  if (content.length <= cap) return content;
  const keep = Math.max(0, cap - TRUNCATION_MARK.length);
  return content.slice(0, keep) + TRUNCATION_MARK;
}

/**
 * Select the newest slice of conversation history that fits within a character
 * budget (a cheap proxy for tokens — no tokenizer dependency), cutting the
 * per-turn cost of long chats. Without this, every turn re-sends the entire
 * history, so cost grows quadratically over a conversation.
 *
 * - `rows` arrive oldest-first and are returned oldest-first.
 * - Each message is first capped to `perMessageCap` chars so one giant paste
 *   can't dominate (or get re-sent in full on every subsequent turn).
 * - Messages are then admitted newest-first until `maxChars` is exhausted; the
 *   most recent turns matter most. The newest message is always kept even if it
 *   alone exceeds the budget, so there is always something to respond to.
 */
export function selectHistory(
  rows: HistoryTurn[],
  { maxChars = 24000, perMessageCap = 6000 }: { maxChars?: number; perMessageCap?: number } = {},
): HistoryTurn[] {
  if (rows.length === 0) return [];

  const capped = rows.map((r) => ({ role: r.role, content: capContent(r.content, perMessageCap) }));

  const kept: HistoryTurn[] = [];
  let used = 0;
  for (let i = capped.length - 1; i >= 0; i--) {
    const len = capped[i].content.length;
    // Always keep the newest message; admit older ones only while they fit.
    if (kept.length > 0 && used + len > maxChars) break;
    kept.push(capped[i]);
    used += len;
  }
  return kept.reverse();
}
