import { normaliseForComparison } from "../rag";

/**
 * The guard between a private question and an admin's inbox.
 *
 * Everything here is pure. No model, no database, no network — on purpose,
 * because the alternative was a prompt that asks a model not to report a
 * cluster of one and not to quote anybody, and a prompt is a request. These
 * functions run on what the model sent back, so a model that ignores its
 * instructions produces a SHORTER report rather than a disclosure.
 *
 * covan-ai/covan#44 is the issue; `0053`'s header is the argument about why the
 * counts could ship without any of this and the questions behind them could
 * not.
 */

/** One sub-floor question, as `workspace_coverage_gaps` returns it. */
export type GapQuestion = {
  /** Already truncated to 120 characters by the function. */
  question: string;
  /**
   * An opaque integer, stable only within one call of the function.
   *
   * Never a user id — the function does not return one. It exists so the floor
   * can be counted here without anybody's identity reaching this process.
   */
  askerKey: number;
};

export type DedupedQuestion = {
  question: string;
  askerKeys: Set<number>;
  /** How many times it was asked, which is what the report prints. */
  copies: number;
};

/** What the model answered: a label, and which deduped questions it covers. */
export type RawCluster = { label: string; members: number[] };

/** A gap that survived. The only shape the renderer ever sees. */
export type Gap = { label: string; questions: number; askers: number };

/**
 * The longest a topic label may be.
 *
 * A label is a few words naming an area of the team's work. A model that
 * returns a paragraph has either misunderstood or is quoting, and both are
 * answered the same way: cut it. 80 characters is long enough for the longest
 * reasonable one and far too short to hide a question in.
 */
export const MAX_LABEL_CHARS = 80;

/**
 * How many distinct askers a cluster needs before it may be reported.
 *
 * Derived from the workspace's size rather than configured, because what the
 * floor protects is members from each other:
 *
 *   1 member   → 1. There is nobody to protect from. The only person who could
 *                read the report is the only person who asked, and a floor here
 *                would fail a solo founder for a protection nobody needs.
 *   2 members  → null, meaning do not run. With two people ANY reported topic
 *                tells one of them about the other; k-anonymity is impossible
 *                at n=2 and no number fixes it. The interface says so at the
 *                switch (`GAP_REPORT_MIN_MEMBERS` in `src/lib/routine-templates.ts`)
 *                so nobody has to discover it from an empty report every week.
 *   3 or more  → 3.
 *
 * Not configurable in any form. A privacy floor an admin can set is a privacy
 * floor an admin can set to one.
 *
 * A member count that is not a positive integer answers null — unavailable
 * rather than unguarded, which is the only safe direction for a function whose
 * answer decides what gets disclosed.
 */
export function askerFloor(memberCount: number): number | null {
  if (!Number.isInteger(memberCount) || memberCount < 1) return null;
  if (memberCount === 1) return 1;
  if (memberCount === 2) return null;
  return 3;
}

/**
 * Collapse questions that are literally the same question.
 *
 * On a real workspace the same thing is asked over and over, and fifty copies
 * of "how do I expense a flight" is one gap rather than fifty. Doing this
 * before the model call is also the only token saving in this feature that
 * costs nothing: the prompt is the whole of what a run pays for.
 *
 * Containment on normalised text, not similarity, and `normaliseForComparison`
 * is `rag.ts`'s — whitespace and case, nothing else. "Nearly the same question"
 * is a judgement this must not make on its own: merging two questions that
 * differ in meaning would put one person's topic under another's label.
 *
 * **Every copy's asker key is kept.** Two people asking the same thing is two
 * askers behind one gap, and a dedupe that kept one would silently lower the
 * floor — the one change in this feature that weakens a guarantee while looking
 * like an optimisation.
 */
export function dedupeQuestions(rows: GapQuestion[]): DedupedQuestion[] {
  const byText = new Map<string, DedupedQuestion>();

  for (const row of rows) {
    const key = normaliseForComparison(row.question);
    if (key === "") continue;

    const existing = byText.get(key);
    if (existing) {
      existing.askerKeys.add(row.askerKey);
      existing.copies += 1;
    } else {
      byText.set(key, {
        question: row.question,
        askerKeys: new Set([row.askerKey]),
        copies: 1,
      });
    }
  }

  return [...byText.values()];
}

/**
 * How much of a question a label may reproduce before it stops naming a
 * topic and starts quoting an answer.
 *
 * Any one of the three is enough on its own: `QUOTATION_MIN_WORDS` words,
 * `QUOTATION_MIN_CHARS` characters, or sharing `QUOTATION_MIN_RATIO` of the
 * question's own words with it. Below all three, the shared text cannot
 * carry both a subject and a predicate — three words under forty characters
 * that are also under 60% of the question is a noun phrase, which is what a
 * topic label is. The floor already requires three independent askers behind
 * anything that reaches this check, so a phrase that survives it is one
 * three people raised on their own, not one lifted word for word out of a
 * single person's mouth.
 *
 * A review of the single-expression version this replaced ran it over
 * thirteen realistic label/question pairs and found it drops eleven of them
 * — including `"Expense policy"` and `"Parental leave"`, the exact multi-word
 * phrases colleagues use to ask about those subjects — while keeping
 * `"Expenses"` and dropping `"Expense"` against the same question, a result
 * that turns on whether the model pluralised a noun. These thresholds are
 * the fix: a rule that can tell a topic name from a quoted question apart.
 */
const QUOTATION_MIN_WORDS = 4;
const QUOTATION_MIN_CHARS = 40;
const QUOTATION_MIN_RATIO = 0.6;

/** Escape `s` so it can be interpolated into a `RegExp` source literally. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split already-normalised (single-spaced, trimmed, lowercased) text into
 * its words. */
function wordsOf(normalised: string): string[] {
  return normalised.split(" ").filter((w) => w !== "");
}

/**
 * Does `haystack` contain `needle` as a contiguous run of whole words?
 *
 * Not `haystack.includes(needle)`. A raw substring check matches "ai" inside
 * "email" and "hr" inside "hrs" — exactly the false positives that made the
 * rule this supports indiscriminate before it was split in two. Word
 * boundaries are checked only at the two ends of `needle`; its own internal
 * spaces are matched literally, so a multi-word needle still has to appear as
 * one contiguous phrase, not as scattered words.
 */
function containsAsWholeWords(haystack: string, needle: string): boolean {
  if (needle === "") return false;
  return new RegExp(`\\b${escapeRegExp(needle)}\\b`).test(haystack);
}

/**
 * Is `label` a quotation of one of `questions`, rather than a name for one?
 *
 * Two different events, deliberately never one expression again:
 *
 *   * Direction B — the label embeds a whole question. Absolute, no
 *     threshold: there is no length at which reproducing somebody's question
 *     verbatim stops being the disclosure.
 *   * Direction A — a question embeds the label. Only a quotation once the
 *     shared run of words clears `QUOTATION_MIN_WORDS`, `QUOTATION_MIN_CHARS`
 *     or `QUOTATION_MIN_RATIO` — see that constant's comment for why those
 *     three and not a flat containment check.
 */
function isQuotation(label: string, questions: DedupedQuestion[]): boolean {
  const normalisedLabel = normaliseForComparison(label);
  if (normalisedLabel === "") return false;
  const labelWords = wordsOf(normalisedLabel);

  return questions.some((q) => {
    const normalisedQuestion = normaliseForComparison(q.question);
    if (normalisedQuestion === "") return false;

    if (containsAsWholeWords(normalisedLabel, normalisedQuestion)) return true;

    if (!containsAsWholeWords(normalisedQuestion, normalisedLabel)) return false;
    const qWords = wordsOf(normalisedQuestion);
    return (
      labelWords.length >= QUOTATION_MIN_WORDS ||
      normalisedLabel.length >= QUOTATION_MIN_CHARS ||
      labelWords.length / qWords.length >= QUOTATION_MIN_RATIO
    );
  });
}

/**
 * Slice to `MAX_LABEL_CHARS` by Unicode code point, not UTF-16 unit.
 *
 * `label.slice(0, N)` counts UTF-16 units, so a label truncated in the middle
 * of an emoji (or anything else outside the Basic Multilingual Plane) leaves
 * a lone surrogate behind — a string that is not valid UTF-16, which breaks
 * an email renderer or a JSON payload rather than merely looking cut off.
 */
function truncateLabel(label: string): string {
  return [...label].slice(0, MAX_LABEL_CHARS).join("");
}

/**
 * Keep only the clusters that may be reported, and say how big each one is.
 *
 * Refuses six things a model, or a caller, can hand it — each one a way a
 * disclosure or a broken report would reach an admin without anybody having
 * chosen it:
 *
 *   * a floor that is not a positive integer. `askerFloor` already answers
 *     `null` for exactly this input; refusing it again here closes the gap a
 *     caller would otherwise hit at the type checker and paper over with
 *     `floor ?? 0` — which this function would satisfy for every cluster,
 *     since a count can never be less than zero. The function that computes
 *     the floor refuses garbage; this one must too, or the refusal is only
 *     theatre at one end of the call.
 *   * fewer distinct askers than the floor — the floor itself.
 *   * a repeated member index — de-duplicated before counting, so a model
 *     repeating an index cannot inflate a gap's count and promote it.
 *   * a member index that is not in the list — a model counting past the end.
 *   * a label that quotes a question, per `isQuotation` — checked against
 *     every question the model saw (`deduped`), not just this cluster's own
 *     members, because a quoted question is the same disclosure whichever
 *     cluster it was filed under; and checked against the label both before
 *     and after truncation, because truncating first can cut a quote in half
 *     and let the surviving half through.
 *   * a label that is empty, whitespace, or longer than `MAX_LABEL_CHARS` —
 *     the last of these is truncated rather than dropped, since a long label
 *     is usually a correct label with an explanation glued on.
 *
 * Ordered by how many questions are behind the gap, so the thing most worth
 * writing down is first. That is `0053`'s ordering choice for its own pair of
 * functions, made again here.
 */
export function enforceFloor(
  clusters: RawCluster[],
  deduped: DedupedQuestion[],
  floor: number | null,
): Gap[] {
  if (floor === null || !Number.isInteger(floor) || floor < 1) return [];

  const gaps: Gap[] = [];

  for (const cluster of clusters) {
    // De-duplicated before the range filter: a model repeating an index must
    // not get to count that question's askers and copies more than once.
    const members = [...new Set(cluster.members)]
      .filter((i) => Number.isInteger(i) && i >= 0 && i < deduped.length)
      .map((i) => deduped[i]);
    if (members.length === 0) continue;

    const askers = new Set<number>();
    let questions = 0;
    for (const m of members) {
      for (const k of m.askerKeys) askers.add(k);
      questions += m.copies;
    }
    if (askers.size < floor) continue;

    const fullLabel = cluster.label.trim();
    if (fullLabel === "") continue;

    const truncatedLabel = truncateLabel(fullLabel);

    // Both the label as the model wrote it and the label as the report will
    // show it, against every question the model saw — not just this
    // cluster's members. See `enforceFloor`'s own comment for why each half
    // of this matters on its own.
    if (isQuotation(fullLabel, deduped) || isQuotation(truncatedLabel, deduped)) continue;

    gaps.push({ label: truncatedLabel, questions, askers: askers.size });
  }

  return gaps.sort((a, b) => b.questions - a.questions || a.label.localeCompare(b.label));
}
