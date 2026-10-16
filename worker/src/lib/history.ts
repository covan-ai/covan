export type HistoryTurn = { role: "user" | "assistant"; content: string };

export const MSG_HISTORY_LIMIT = 60;
export const HISTORY_CHAR_BUDGET = 32000;
export const PER_MESSAGE_CHAR_CAP = 6000;

/**
 * The cap on the newest message, which is the one being answered.
 *
 * `PER_MESSAGE_CHAR_CAP` exists so one giant paste is not re-sent in full on
 * every later turn. It was also applied to the turn that pasted it, so the model
 * saw the first 6,000 characters of a 62,000-character message and never the
 * question typed underneath — it answered an older one instead. The newest
 * message is sent once at this size; on the next turn it is history and takes
 * the ordinary cap.
 *
 * 60,000 characters is ~31,600 tokens at `HISTORY_CHARS_PER_TOKEN`, the dense
 * end. Its budget share is counted as if it were capped normally (see
 * `selectHistory`), so the worst prompt is the ~28,000-token envelope
 * `limits.ts` describes, plus `MAX_HISTORY_TOKENS`, plus the ~28,400 tokens
 * this allows past the ordinary cap: about 73,000, inside the 80,000 at which
 * a turn starts trimming and well inside every model's window.
 */
export const NEWEST_MESSAGE_CHAR_CAP = 60_000;

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

/**
 * Share of a capped message kept from its head; the rest is kept from its tail.
 *
 * Head only used to be the rule, on the theory that the opening carries the
 * intent. For a paste it is the other way round as often as not: the document
 * comes first and the question about it comes last. Keeping both ends means
 * the model sees what was pasted and what was asked about it.
 */
const HEAD_SHARE = 0.6;

/** What stands where the middle was, so the model knows it was cut, and by how much. */
function omissionMark(omitted: number): string {
  return `\n\n[… ${omitted.toLocaleString("en-US")} characters omitted …]\n\n`;
}

/**
 * Trim one message's content to at most `cap` chars, keeping its head and its
 * tail with a marker between them that says how much was left out. Returns the
 * original string when it already fits.
 */
export function capContent(content: string, cap: number): string {
  if (content.length <= cap) return content;
  // The marker's own length depends on the number in it; size it for the
  // largest possible omission, which is never smaller than the real one.
  const room = Math.max(0, cap - omissionMark(content.length).length);
  const head = Math.ceil(room * HEAD_SHARE);
  const tail = room - head;
  const omitted = content.length - head - tail;
  return content.slice(0, head) + omissionMark(omitted) + (tail > 0 ? content.slice(-tail) : "");
}

/**
 * Where a trim cuts back to, as a share of the ceiling it was triggered by.
 *
 * A window that trims to exactly its ceiling drops the oldest message on every
 * turn once a conversation sits just over the line, and the oldest message is
 * the front of the transcript — the part prompt caching keys on. Every turn then
 * pays a cache write on the whole history to make room for one short message
 * (#250). Cutting back to three quarters leaves a quarter of the budget as slack
 * — 8,000 chars at the default — and the front stays put until that is spent.
 */
export const HISTORY_LOW_WATER_SHARE = 0.75;

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
 *   can't dominate (or get re-sent in full on every subsequent turn) — except
 *   the newest, which is the one being answered and is capped at `newestCap`.
 *   Its share of the budget is still counted at `perMessageCap`, so a long
 *   paste does not push the conversation before it out of the window, and the
 *   front does not move when that paste becomes history on the next turn.
 * - Under `maxChars` in total, everything is sent.
 * - Over it, the front is cut — but to `lowWater`, not to `maxChars`, and in
 *   bands. The newest message is always kept even if it alone exceeds the
 *   budget, so there is always something to respond to.
 *
 * THE BANDED CUT, AND WHY A STATELESS FUNCTION CAN HOLD THE FRONT STILL. There
 * is nowhere to remember where the last turn cut, and there does not need to be.
 * Let `T` be the capped total and `slack = maxChars - lowWater`. The cut offset
 * is the excess rounded *up* to a whole number of slacks:
 *
 *     cutAt = slack * ceil((T - maxChars) / slack)
 *
 * and the front is the first message that starts at or after `cutAt` chars into
 * the conversation. Two facts make that stable across turns. Appending a message
 * never changes where any earlier message starts — the prefix sums of an
 * append-only list are fixed. And `cutAt` only changes when `T` crosses into the
 * next band of `slack` chars. So between those crossings every turn computes the
 * same `cutAt` over the same prefix sums and lands on the same front: the
 * transcript the provider sees starts with the same bytes, and the cache entry
 * the last turn wrote is still a prefix of this one. The front moves at most once
 * per `slack` chars appended, instead of on every turn.
 *
 * What is sent is never more than `maxChars` (bar the newest-message exception):
 * the kept suffix is `T - start(front) <= T - cutAt <= maxChars`. Right after a
 * cut it is just over `lowWater`, and it grows back towards `maxChars` until the
 * next band cuts again — the same window on average, a fraction of the writes.
 *
 * `lowWater` at or above `maxChars` leaves no slack, and the cut is then the
 * plain one this function always made: the longest newest suffix that fits.
 */
export function selectHistory(
  rows: HistoryTurn[],
  {
    maxChars = HISTORY_CHAR_BUDGET,
    perMessageCap = PER_MESSAGE_CHAR_CAP,
    lowWater = Math.round(maxChars * HISTORY_LOW_WATER_SHARE),
    newestCap = Math.max(perMessageCap, NEWEST_MESSAGE_CHAR_CAP),
  }: { maxChars?: number; perMessageCap?: number; lowWater?: number; newestCap?: number } = {},
): HistoryTurn[] {
  if (rows.length === 0) return [];

  const last = rows.length - 1;
  const capped = rows.map((r, i) => ({
    role: r.role,
    content: capContent(r.content, i === last ? newestCap : perMessageCap),
  }));
  // What each message weighs against the budget: its ordinary capped length,
  // the newest included. The newest's extra is carried on top of the budget
  // for this one turn rather than paid for with the conversation before it.
  const weight = capped.map((m) => Math.min(m.content.length, perMessageCap));

  const total = weight.reduce((n, w) => n + w, 0);
  if (total <= maxChars) return capped;

  const excess = total - maxChars;
  const slack = maxChars - lowWater;
  const cutAt = slack > 0 ? slack * Math.ceil(excess / slack) : excess;

  // The first message that starts at or past the cut; the newest at the latest.
  let front = capped.length - 1;
  let start = 0;
  for (let i = 0; i < capped.length - 1; i++) {
    if (start >= cutAt) {
      front = i;
      break;
    }
    start += weight[i];
  }
  return capped.slice(front);
}
