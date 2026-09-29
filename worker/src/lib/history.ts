export type HistoryTurn = { role: "user" | "assistant"; content: string };

export const MSG_HISTORY_LIMIT = 60;
export const HISTORY_CHAR_BUDGET = 32000;
export const PER_MESSAGE_CHAR_CAP = 6000;

/**
 * Characters per token in conversation prose, measured rather than assumed.
 *
 * WHY THIS IS HERE AND NOT A RATIO IN A COMMENT. The budget above is in
 * characters and nothing in this file — or anywhere else — said what that costs.
 * `lib/harness/budget.ts` had the same hole for tool output, and closing it
 * found the cap had been derived from a 4:1 guess that was 1.7x wrong. The same
 * guess was here: the only figure ever attached to this constant was an aside in
 * that file calling conversation prose "nearer four".
 *
 * Measured 2026-09-29 with Anthropic's `count_tokens`, on the real components of
 * a real prompt (see `0069_what_the_prompt_was_made_of.sql`):
 *
 *     English instruction prose      3.2 - 3.6 chars/token
 *     Turkish prose and markdown     1.92      chars/token   (4,000 -> 2,085)
 *
 * So "nearer four" is right for English and nearly twice wrong for Turkish, and
 * this deployment's conversations are both. **The dense end is the one a budget
 * has to be stated in**, for `TOOL_OUTPUT_CHARS_PER_TOKEN`'s reason: a ceiling
 * described by its best case is not a ceiling. Hence 1.9 and not 2.7.
 *
 * Not used to compute the budget — the budget stays a character count, because
 * the trimming below cuts characters and a token figure would have to be
 * converted back at every comparison. It is used to say what the budget *costs*,
 * which is the thing that was missing.
 */
export const HISTORY_CHARS_PER_TOKEN = 1.9;

/**
 * What a full history can cost, at its worst.
 *
 * Derived, so it cannot drift from the budget it describes. Roughly 16,800
 * tokens — which is the number worth knowing, because it is more than the
 * persona, both manifests, the retrieval block and all eight tool schemas put
 * together (measured: ~11,000 for the lot, `0069`). A long chat is the largest
 * thing in a prompt and it was the one part with no figure on it.
 *
 * `limits.ts` reasons about the context window against this.
 */
export const MAX_HISTORY_TOKENS = Math.ceil(HISTORY_CHAR_BUDGET / HISTORY_CHARS_PER_TOKEN);

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
 * budget, cutting the per-turn cost of long chats. Without this, every turn
 * re-sends the entire history, so cost grows quadratically over a conversation.
 *
 * Characters and not tokens because the trimming cuts characters and there is no
 * tokenizer here to ask. That was always the right call and it used to be the
 * whole answer — "a cheap proxy for tokens", with no statement of what the proxy
 * cost. `HISTORY_CHARS_PER_TOKEN` and `MAX_HISTORY_TOKENS` above are that
 * statement, measured.
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
  {
    maxChars = HISTORY_CHAR_BUDGET,
    perMessageCap = PER_MESSAGE_CHAR_CAP,
  }: { maxChars?: number; perMessageCap?: number } = {},
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
