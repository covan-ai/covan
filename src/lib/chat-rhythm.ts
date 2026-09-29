import type { Message } from "./agents-store";

/**
 * How much air goes above one turn.
 *
 * The transcript used to be `space-y-6`: 24px between everything, so the gap
 * between a question and its answer was the same as the gap between one
 * conversation and the next. Nothing grouped. A reader scanning the column had
 * no way to see, before reading a word, where one exchange ended.
 *
 * So: a question and its answer are TIGHT, and everything else is LOOSE. That
 * is the whole rule, and it is the only thing on this screen that makes a
 * transcript read as a series of exchanges rather than as a stack of boxes.
 *
 * A pure function rather than a class in the loop, because the interesting
 * part is the cases that are NOT a pair — two questions in a row, two answers
 * in a row, and the first turn of all — and each of those is a decision worth
 * being able to read on its own.
 */
export type TurnGap = "none" | "tight" | "loose";

export function gapBefore(
  previous: Message | undefined,
  current: Message,
  hasDivider: boolean,
): TurnGap {
  // A date divider is the turn's sibling, not part of it, and it carries
  // padding on both sides already. A margin under it is two gaps in a row.
  if (hasDivider) return "none";
  if (!previous) return "none";

  const answersTheQuestionAbove = previous.role === "user" && current.role === "assistant";
  return answersTheQuestionAbove ? "tight" : "loose";
}

/**
 * The gap in Tailwind's terms. 20px and 44px — the two values the whole
 * rhythm is built from, named once so they cannot drift between the four
 * places a turn is drawn.
 */
export const GAP_CLASS: Record<TurnGap, string> = {
  none: "",
  tight: "mt-5",
  loose: "mt-11",
};
