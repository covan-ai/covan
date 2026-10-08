import { describe, it, expect } from "vitest";
import { renderCoverageReport, type CoverageTotals } from "./coverage-render";
import { enforceFloor, MAX_LABEL_CHARS, type DedupedQuestion, type Gap } from "./coverage-cluster";

const totals: CoverageTotals = {
  days: 7,
  answers: 128,
  covered: 105,
  fallback: 23,
  ungrounded: 0,
  unrecorded: 0,
};

describe("the rendered report", () => {
  it("leads with the two numbers and the window", () => {
    const text = renderCoverageReport({ totals, gaps: [], withheld: 0 });
    expect(text).toContain("7 days");
    expect(text).toContain("23 of 128");
  });

  it("lists each gap with both counts", () => {
    const text = renderCoverageReport({
      totals,
      gaps: [{ label: "Expenses and reimbursement", questions: 7, askers: 4 }],
      withheld: 0,
    });
    expect(text).toContain("Expenses and reimbursement");
    expect(text).toContain("7 questions");
    expect(text).toContain("4 people");
  });

  it("says one question and one person without an s", () => {
    const text = renderCoverageReport({
      totals,
      gaps: [{ label: "Payday", questions: 1, askers: 1 }],
      withheld: 0,
    });
    expect(text).toContain("1 question,");
    expect(text).toContain("1 person");
  });

  /**
   * The empty report is a sentence, not a blank. A workspace that turned this
   * on and received nothing should be told why it received nothing — otherwise
   * the feature reads as broken, which is exactly the failure the derived floor
   * exists to avoid.
   */
  it("explains an empty report rather than looking broken", () => {
    const text = renderCoverageReport({ totals, gaps: [], withheld: 9 });
    expect(text).toMatch(/did not come together/i);
    expect(text).toContain("9");
  });

  it("says nothing about withheld questions when there are none", () => {
    const text = renderCoverageReport({
      totals,
      gaps: [{ label: "Expenses", questions: 7, askers: 4 }],
      withheld: 0,
    });
    expect(text).not.toMatch(/did not come together/i);
  });

  /**
   * `'none'` is a setup problem, not a coverage one — 0053 counts it apart on
   * purpose and so does this. Reported, and never clustered.
   */
  it("reports ungrounded answers as their own, separate problem", () => {
    const text = renderCoverageReport({
      totals: { ...totals, ungrounded: 12 },
      gaps: [],
      withheld: 0,
    });
    expect(text).toContain("12");
    expect(text).toMatch(/nothing attached/i);
  });

  it("leaves the ungrounded line out at zero", () => {
    const text = renderCoverageReport({ totals, gaps: [], withheld: 0 });
    expect(text).not.toMatch(/nothing attached/i);
  });

  /**
   * `unrecorded` is 0053's honesty about its own denominator: a workspace whose
   * history predates 0039 would otherwise read a sample as a census.
   */
  it("admits when some answers were never recorded", () => {
    const text = renderCoverageReport({
      totals: { ...totals, unrecorded: 40 },
      gaps: [],
      withheld: 0,
    });
    expect(text).toContain("40");
  });

  it("is byte-identical for the same input", () => {
    const input = {
      totals,
      gaps: [{ label: "Expenses", questions: 7, askers: 4 }],
      withheld: 2,
    };
    expect(renderCoverageReport(input)).toBe(renderCoverageReport(input));
  });

  it("survives a window with no answers at all", () => {
    const text = renderCoverageReport({
      totals: { days: 7, answers: 0, covered: 0, fallback: 0, ungrounded: 0, unrecorded: 0 },
      gaps: [],
      withheld: 0,
    });
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toContain("NaN");
  });
});

/**
 * A gap whose `label` is `null` is `coverage-cluster.ts` saying it would not
 * name this topic — the containment check found the model's name for it
 * reproduced somebody's question. The guard emits the row anyway, because a
 * deleted row is indistinguishable from a quiet week, and the wording of that
 * refusal is this file's job and nowhere else's. `null` must never reach the
 * admin as a blank, a "null", or a bullet that reads like a bug.
 */
describe("a topic the guard would not name", () => {
  const withheldGap: Gap = { label: null, questions: 4, askers: 3 };

  it("says a topic is there, how big it is, and that the name is withheld", () => {
    const text = renderCoverageReport({ totals, gaps: [withheldGap], withheld: 0 });
    expect(text).toContain("4 questions");
    expect(text).toContain("3 people");
    expect(text).toMatch(/not naming/i);
    expect(text).toMatch(/without a name/i);
  });

  it("never prints null or undefined where a label would have gone", () => {
    const text = renderCoverageReport({
      totals,
      gaps: [withheldGap, { label: "Expenses", questions: 7, askers: 4 }],
      withheld: 3,
    });
    expect(text).not.toContain("null");
    expect(text).not.toContain("undefined");
    expect(text).not.toMatch(/•\s*—/);
  });

  it("explains the refusal once, not once per row", () => {
    const text = renderCoverageReport({
      totals,
      gaps: [withheldGap, { label: null, questions: 3, askers: 3 }],
      withheld: 0,
    });
    expect(text.match(/reproduced/g) ?? []).toHaveLength(1);
    expect(text).toContain("2 topics");
  });

  it("lists a withheld topic alongside a named one, in the order given", () => {
    const text = renderCoverageReport({
      totals,
      gaps: [{ label: "Expenses", questions: 7, askers: 4 }, withheldGap],
      withheld: 0,
    });
    expect(text.indexOf("Expenses")).toBeLessThan(text.search(/not naming/i));
  });

  it("renders a report in which every topic is nameless", () => {
    const text = renderCoverageReport({
      totals,
      gaps: [withheldGap, { label: null, questions: 3, askers: 1 }],
      withheld: 0,
    });
    // Two bullets, both refusals, and the list is still a list.
    expect(text.match(/^ {2}•/gm) ?? []).toHaveLength(2);
    expect(text).toMatch(/not naming/i);
    expect(text).toContain("1 person");
  });

  it("says nothing about withheld names when every topic is named", () => {
    const text = renderCoverageReport({
      totals,
      gaps: [{ label: "Expenses", questions: 7, askers: 4 }],
      withheld: 0,
    });
    expect(text).not.toMatch(/without a name/i);
    expect(text).not.toMatch(/not naming/i);
  });

  /**
   * Fix round 1, finding 1. The report must not say the quoted question came
   * from the people in the row, because `isQuotation` is scoped to every
   * question the model saw and not to this cluster's members — fix round 1,
   * finding 2 of the guard, where a verbatim question in front of an admin
   * was ruled the same disclosure whichever cluster the model filed it under.
   *
   * So the question that cost a row its name can belong to somebody who
   * appears in no reported row at all. A locality claim would be the one
   * sentence in the file that is not a function of its input, and it would
   * assert in prose exactly what the guard's deniability depends on being
   * unknowable.
   */
  it("does not claim the quoted question came from the people in the row", () => {
    const deduped: DedupedQuestion[] = [
      { question: "when is payday", askerKeys: new Set([1, 2, 3]), copies: 3 },
      { question: "i am pregnant what leave do i get", askerKeys: new Set([4]), copies: 1 },
    ];
    // Labelled over the payday cluster, in the words of a question only one
    // person asked — a person below the floor, who is in no reported row.
    const gaps = enforceFloor(
      [{ label: "i am pregnant what leave do i get", members: [0] }],
      deduped,
      3,
    );
    expect(gaps).toEqual([{ label: null, questions: 3, askers: 3 }]);

    const text = renderCoverageReport({ totals, gaps, withheld: 1 });
    expect(text).not.toMatch(/behind it|behind them|behind those/i);
    expect(text).toMatch(/somebody had typed/i);
    expect(text).not.toContain("pregnant");
  });

  /**
   * Fix round 1, finding 3. Unreachable from `enforceFloor`, which refuses an
   * empty, whitespace or letterless label outright — so this is a hand-built
   * `Gap`. The renderer is still the last thing between a `Gap` and an
   * admin's inbox, and `"  • — 3 questions, 3 people"` is the exact bullet the
   * withheld wording exists to prevent.
   */
  it("treats a label with nothing printable in it exactly as a withheld one", () => {
    const text = renderCoverageReport({
      totals,
      gaps: [{ label: "   ", questions: 3, askers: 3 }],
      withheld: 0,
    });
    expect(text).not.toMatch(/•\s*—/);
    expect(text).toContain("• A topic we are not naming — 3 questions");
    // Counted as a refusal too, so the bullet is explained rather than
    // appearing without the sentence that makes sense of it.
    expect(text).toMatch(/without a name/i);
  });

  it("is byte-identical for the same input with a withheld topic in it", () => {
    const input = {
      totals,
      gaps: [withheldGap, { label: "Expenses", questions: 7, askers: 4 }],
      withheld: 2,
    };
    expect(renderCoverageReport(input)).toBe(renderCoverageReport(input));
  });
});

/**
 * `withheld` is the count of distinct questions no surviving gap covers —
 * never clustered at all, clustered below the floor, or clustered but
 * refused on label grounds — and it is a different fact from a topic whose
 * name was refused. Fix round 1, finding 3: this used to say "fell BELOW THE
 * FLOOR", which is only one of the three. Fix round 2: it then said "too
 * scattered", which is still false of the third (a cluster that cleared the
 * floor and was dropped only for its label). Withheld questions are counted
 * and never listed — the count names nobody and carries no label; a
 * nameless-but-present topic is listed with its counts. The report must not
 * blur the two, because they tell an admin opposite things: one says the
 * questions did not come together into a topic to report, the other says a
 * topic is there and we would not print what it was called.
 */
describe("the withheld count and the withheld name are different facts", () => {
  it("counts withheld questions and lists nameless topics in the same report", () => {
    const text = renderCoverageReport({
      totals,
      gaps: [{ label: null, questions: 4, askers: 3 }],
      withheld: 6,
    });
    // The withheld count is reported as a number of questions...
    expect(text).toContain("6");
    expect(text).toMatch(/did not come together/i);
    // ...and the nameless topic is still a listed row with its own counts.
    expect(text).toContain("4 questions");
    expect(text).toMatch(/not naming/i);
  });

  it("says nothing at all about withheld questions when none were withheld", () => {
    const text = renderCoverageReport({
      totals,
      gaps: [{ label: "Expenses", questions: 7, askers: 4 }],
      withheld: 0,
    });
    expect(text).not.toMatch(/did not come together/i);
  });
});

describe("the shapes that have no gaps in them", () => {
  it("explains a window that had sub-floor questions but produced no topics", () => {
    // `fallback` is non-zero, so there WERE questions that found nothing, and
    // yet there is neither a topic to list nor a below-floor count. Without a
    // line of its own this is a one-sentence email that reads as a failure.
    const text = renderCoverageReport({ totals, gaps: [], withheld: 0 });
    expect(text.split("\n").filter((l) => l !== "").length).toBeGreaterThan(1);
    expect(text).toMatch(/nothing to list|no topic/i);
  });

  it("does not claim every answer found nothing when none did", () => {
    const text = renderCoverageReport({
      totals: { ...totals, fallback: 0, covered: 128 },
      gaps: [],
      withheld: 0,
    });
    // "0 of 128 answers found nothing" is a double negative an admin has to
    // read twice. The good-news week gets its own sentence.
    expect(text).not.toContain("0 of 128");
    expect(text).toContain("128");
  });

  it("does not print a ratio of nothing when the window recorded no answers", () => {
    const text = renderCoverageReport({
      totals: { days: 7, answers: 0, covered: 0, fallback: 0, ungrounded: 0, unrecorded: 0 },
      gaps: [],
      withheld: 0,
    });
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("Infinity");
    expect(text).not.toContain("0 of 0");
    expect(text).toContain("7 days");
  });

  it("still admits the unrecorded replies when there were no answers either", () => {
    const text = renderCoverageReport({
      totals: { days: 7, answers: 0, covered: 0, fallback: 0, ungrounded: 0, unrecorded: 40 },
      gaps: [],
      withheld: 0,
    });
    expect(text).toContain("40");
  });

  it("says one day without an s", () => {
    const text = renderCoverageReport({
      totals: { ...totals, days: 1 },
      gaps: [],
      withheld: 0,
    });
    expect(text).toContain("1 day,");
    expect(text).not.toContain("1 days");
  });

  it("agrees with its own verb when exactly one reply was unrecorded", () => {
    // A count of one is the common case for this line, not the edge case: a
    // workspace with one surface that does not set `grounding` produces a
    // single unrecorded reply a week. "1 reply ... predate ... are not
    // counted" is the kind of sentence that makes an admin wonder what else
    // in the report was generated rather than counted.
    const text = renderCoverageReport({
      totals: { ...totals, unrecorded: 1 },
      gaps: [],
      withheld: 0,
    });
    expect(text).toContain("1 reply");
    expect(text).toContain("predates");
    expect(text).toContain("is not counted");
    expect(text).not.toContain("1 reply in this window predate ");
  });

  it("keeps the plural form for more than one unrecorded reply", () => {
    const text = renderCoverageReport({
      totals: { ...totals, unrecorded: 40 },
      gaps: [],
      withheld: 0,
    });
    expect(text).toContain("40 replies");
    expect(text).toContain("predate ");
    expect(text).toContain("are not counted");
  });
});

describe("a label at the edge of what the guard allows", () => {
  it("prints a label of exactly MAX_LABEL_CHARS in full", () => {
    // `enforceFloor` truncates to this length, so the longest label the
    // renderer can ever be handed is exactly this one. It must arrive whole:
    // a renderer that re-truncates would cut a topic name for a second time,
    // on a different boundary, for no reason anybody could find later.
    const label = "Expense policy for contractors and the paperwork that comes with it, in full";
    const padded = label + "!".repeat(MAX_LABEL_CHARS - label.length);
    expect([...padded]).toHaveLength(MAX_LABEL_CHARS);

    const text = renderCoverageReport({
      totals,
      gaps: [{ label: padded, questions: 7, askers: 4 }],
      withheld: 0,
    });
    expect(text).toContain(padded);
  });

  it("prints a one-character label rather than swallowing it", () => {
    const text = renderCoverageReport({
      totals,
      gaps: [{ label: "X", questions: 7, askers: 4 }],
      withheld: 0,
    });
    expect(text).toContain("X — 7 questions");
  });
});
