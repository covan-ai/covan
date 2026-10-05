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
 * Keep only the clusters that may be reported, and say how big each one is.
 *
 * Five refusals, and each is a thing a model can do that must not become a
 * disclosure or a broken report:
 *
 *   * fewer distinct askers than the floor — the floor itself
 *   * a label that contains, or is contained by, one single question — a
 *     verbatim question identifies its author to anybody who knows the team
 *   * a label that is empty or whitespace — a blank bullet
 *   * a label longer than `MAX_LABEL_CHARS` — cut rather than dropped, since a
 *     long label is usually a correct label with an explanation glued on
 *   * a member index that is not in the list — a model counting past the end
 *
 * Ordered by how many questions are behind the gap, so the thing most worth
 * writing down is first. That is `0053`'s ordering choice for its own pair of
 * functions, made again here.
 */
export function enforceFloor(
  clusters: RawCluster[],
  deduped: DedupedQuestion[],
  floor: number,
): Gap[] {
  const gaps: Gap[] = [];

  for (const cluster of clusters) {
    const members = cluster.members
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

    const label = cluster.label.trim().slice(0, MAX_LABEL_CHARS);
    if (label === "") continue;

    // Containment either way round. A label that is a question is the obvious
    // case; a question that contains the label happens when the model answers
    // with a fragment of one, which is the same disclosure in fewer words.
    const normalisedLabel = normaliseForComparison(label);
    const quotesSomebody = members.some((m) => {
      const q = normaliseForComparison(m.question);
      return q.includes(normalisedLabel) || normalisedLabel.includes(q);
    });
    if (quotesSomebody) continue;

    gaps.push({ label, questions, askers: askers.size });
  }

  return gaps.sort((a, b) => b.questions - a.questions || a.label.localeCompare(b.label));
}
