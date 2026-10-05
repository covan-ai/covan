import type { Gap } from "./coverage-cluster";

/**
 * The report, printed rather than written.
 *
 * This file is the best decision in the feature and the reason deserves to be
 * here rather than only in the spec. The first design handed the surviving
 * clusters back to the routine's ordinary summarise call to be written up in
 * the agent's voice — one more model call per run, buying three problems:
 *
 *   * a model can invent a number next to a real label, and a report of counts
 *     that might be wrong is worse than no report;
 *   * a model can embellish a label that has already passed the containment
 *     check, which is the one way a paraphrase of somebody's question could get
 *     past `enforceFloor`;
 *   * and a weekly report that reads differently every week, because wording
 *     varies, is harder to read than one that does not.
 *
 * So the only model call in a coverage run is the clustering one. The figures
 * are ours, the shape is stable, and nobody's coverage gaps arrive written in
 * the voice of a Support Agent persona.
 *
 * Which makes one promise this file has to keep: the same input renders the
 * same bytes. No date, no clock, no randomness, no rounding and no hedging
 * word — every sentence below is a function of the counts it was handed. The
 * ordering it prints in is `enforceFloor`'s, which is total for the same
 * reason.
 */

/** The window's grounding counts, in `0053`'s four buckets plus its denominator. */
export type CoverageTotals = {
  days: number;
  /** Replies carrying a grounding at all. The denominator. */
  answers: number;
  /** `'chunks'` — somebody had written something for this question. */
  covered: number;
  /** `'documents'` — nothing cleared the floor. The number this report is about. */
  fallback: number;
  /** `'none'` — nothing grounded it. A setup problem, counted apart. */
  ungrounded: number;
  /** No grounding recorded. Replies older than 0039, and any surface that does not set it. */
  unrecorded: number;
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What a bullet says when `coverage-cluster.ts` would not name the topic.
 *
 * A `Gap` with `label: null` is not a missing value and must not look like
 * one. The containment check found that the name the model gave this cluster
 * reproduced somebody's question, so the name is withheld and the topic is
 * not: the admin is told a topic is there, how many questions it drew and how
 * many people asked them, and that we are deliberately not printing what it
 * was called.
 *
 * Written as a phrase in the report's own voice rather than a placeholder in
 * brackets, because a placeholder reads like a bug and this is a decision. It
 * is also why `Gap.label` is `null` and not the string below: a sentinel in
 * the data is a sentinel somebody eventually sorts, translates or mistakes for
 * a topic name, and the wording of a refusal belongs to the thing that does
 * the talking.
 */
const WITHHELD_TOPIC = "A topic we are not naming";

export function renderCoverageReport(input: {
  totals: CoverageTotals;
  gaps: Gap[];
  /**
   * Deduped questions that fell short of the FLOOR, so were not reported.
   *
   * A different fact from a gap with no label, and the report keeps them
   * apart. This number names nobody and carries no topic — it is the one
   * thing that tells an admin an empty report means "the questions were too
   * scattered" rather than "your documents are complete". A nameless gap is
   * the opposite: a topic that cleared the floor, listed with its counts,
   * whose name we would not print.
   */
  withheld: number;
}): string {
  const { totals, gaps, withheld } = input;
  const lines: string[] = [];
  const window = plural(totals.days, "day", "days");

  // Three openings, because the obvious one is wrong twice. No percentage is
  // computed anywhere in this file, of this ratio or any other, so there is
  // no division to guard — but `answers` of zero still has to say something
  // other than "0 of 0 answers", and `fallback` of zero would otherwise read
  // "0 of 128 answers found nothing", a double negative in the one week an
  // admin most wants to skim.
  if (totals.answers === 0) {
    lines.push(
      `Over the last ${window}, no answer recorded what grounded it, so there is no ` +
        `coverage to report.`,
    );
  } else if (totals.fallback === 0) {
    lines.push(
      `Over the last ${window}, every one of ${plural(totals.answers, "answer", "answers")} ` +
        `found something in your documents close to what was asked.`,
    );
  } else {
    lines.push(
      `Over the last ${window}, ${totals.fallback} of ` +
        `${plural(totals.answers, "answer", "answers")} found nothing in your documents ` +
        `close to what was asked.`,
    );
  }

  if (gaps.length > 0) {
    lines.push("");
    lines.push("What came up most:");
    for (const gap of gaps) {
      lines.push(
        `  • ${gap.label ?? WITHHELD_TOPIC} — ${plural(gap.questions, "question", "questions")}, ` +
          `${plural(gap.askers, "person", "people")}`,
      );
    }

    // Once for the report, not once per bullet: an explanation repeated down
    // a list stops being read, and this one is the half of the guard an admin
    // has to understand to trust the rest of it.
    const unnamed = gaps.filter((gap) => gap.label === null).length;
    if (unnamed === 1) {
      lines.push("");
      lines.push(
        `One topic above is listed without a name. The name our clustering gave it ` +
          `reproduced one of the questions behind it, so we withheld the name and kept the ` +
          `topic: you are told what came up and how many people it came from, never what ` +
          `anybody typed. Nothing has been dropped from the list.`,
      );
    } else if (unnamed > 1) {
      lines.push("");
      lines.push(
        `${plural(unnamed, "topic", "topics")} above are listed without a name. The names ` +
          `our clustering gave them reproduced questions people had typed, so we withheld ` +
          `the names and kept the topics: you are told what came up and how many people it ` +
          `came from, never what anybody typed. Nothing has been dropped from the list.`,
      );
    }
  }

  if (withheld > 0) {
    lines.push("");
    lines.push(
      gaps.length > 0
        ? `${plural(withheld, "other question", "other questions")} fell short too, ` +
            `but came from too few people to report.`
        : `${plural(withheld, "question", "questions")} fell short, but not enough ` +
            `different people asked about any one topic for it to be reported. Nothing ` +
            `here names anybody, which is why the bar is where it is.`,
    );
  } else if (gaps.length === 0 && totals.fallback > 0) {
    // Questions did find nothing, and yet there is neither a topic to list
    // nor a below-floor count to report. Saying so costs a line and saves an
    // admin from reading a one-sentence email as a broken feature.
    lines.push("");
    lines.push(`None of them grouped into a topic, so there is nothing to list this time.`);
  }

  if (totals.ungrounded > 0) {
    lines.push("");
    lines.push(
      `Separately, ${plural(totals.ungrounded, "answer", "answers")} had nothing ` +
        `attached at all. That is a setup problem rather than a coverage one — an ` +
        `agent with no knowledge bundle, or a bundle with nothing in it.`,
    );
  }

  if (totals.unrecorded > 0) {
    lines.push("");
    lines.push(
      totals.unrecorded === 1
        ? `1 reply in this window predates grounding being recorded and is not counted above.`
        : `${totals.unrecorded} replies in this window predate grounding being recorded ` +
            `and are not counted above.`,
    );
  }

  return lines.join("\n");
}
