import { describe, it, expect } from "vitest";
import {
  askerFloor,
  dedupeQuestions,
  enforceFloor,
  MAX_LABEL_CHARS,
  type DedupedQuestion,
} from "./coverage-cluster";

describe("the floor", () => {
  it("does not protect a workspace of one from itself", () => {
    expect(askerFloor(1)).toBe(1);
  });

  it("refuses to run at two, where no floor can help", () => {
    expect(askerFloor(2)).toBeNull();
  });

  it("is three from three upwards", () => {
    expect(askerFloor(3)).toBe(3);
    expect(askerFloor(4)).toBe(3);
    expect(askerFloor(250)).toBe(3);
  });

  it("treats a nonsense member count as unavailable rather than open", () => {
    expect(askerFloor(0)).toBeNull();
    expect(askerFloor(-1)).toBeNull();
    // Fix round 1, finding 6: `0` and `-1` both also satisfy a simplified
    // `memberCount < 1` check with the `Number.isInteger` guard removed, so
    // neither caught a regression there on its own.
    expect(askerFloor(2.5)).toBeNull();
    expect(askerFloor(Number.NaN)).toBeNull();
  });
});

describe("dedupe", () => {
  it("collapses the same question asked twice", () => {
    const out = dedupeQuestions([
      { question: "How do I expense a flight?", askerKey: 1 },
      { question: "how do i expense a flight?", askerKey: 1 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].copies).toBe(2);
  });

  it("collapses on whitespace and case only, never on meaning", () => {
    const out = dedupeQuestions([
      { question: "How  do I  expense a flight?", askerKey: 1 },
      { question: "How do I expense a train?", askerKey: 1 },
    ]);
    expect(out).toHaveLength(2);
  });

  /**
   * The subtle bug in this phase. Two people asking the same thing is TWO
   * askers behind one gap, and a dedupe that kept one asker key would quietly
   * lower the floor — a privacy guarantee weakened by something that reads like
   * tidying up.
   */
  it("keeps every copy's asker", () => {
    const out = dedupeQuestions([
      { question: "Where is the handbook?", askerKey: 1 },
      { question: "where is the handbook?", askerKey: 2 },
      { question: "Where is the handbook?", askerKey: 3 },
    ]);
    expect(out).toHaveLength(1);
    expect([...out[0].askerKeys].sort()).toEqual([1, 2, 3]);
  });

  it("drops a question that is empty once normalised", () => {
    expect(dedupeQuestions([{ question: "   \n  ", askerKey: 1 }])).toEqual([]);
  });
});

describe("enforcing the floor on what the model returned", () => {
  const deduped: DedupedQuestion[] = [
    { question: "expense a flight", askerKeys: new Set([1, 2, 3]), copies: 5 },
    { question: "expense a train", askerKeys: new Set([4]), copies: 1 },
    { question: "when is payday", askerKeys: new Set([5, 6]), copies: 2 },
  ];

  it("keeps a cluster with enough distinct askers", () => {
    const gaps = enforceFloor([{ label: "Expenses", members: [0] }], deduped, 3);
    expect(gaps).toEqual([{ label: "Expenses", questions: 5, askers: 3 }]);
  });

  it("drops a cluster below the floor", () => {
    // "Payroll", not "Payday" (fix round 1, finding 7): the original fixture
    // was also a whole-word match inside deduped[2]'s question ("when is
    // payday"), so this test passed for two reasons at once and would still
    // pass with the floor check deleted. "Payroll" shares nothing with any
    // deduped question, so this now tests only the floor.
    expect(enforceFloor([{ label: "Payroll", members: [2] }], deduped, 3)).toEqual([]);
  });

  it("counts askers across a cluster's questions, not per question", () => {
    const gaps = enforceFloor([{ label: "Expenses", members: [1, 2] }], deduped, 3);
    expect(gaps).toEqual([{ label: "Expenses", questions: 3, askers: 3 }]);
  });

  it("counts a person once however many of a cluster's questions they asked", () => {
    const overlapping: DedupedQuestion[] = [
      { question: "a", askerKeys: new Set([1, 2]), copies: 2 },
      { question: "b", askerKeys: new Set([2, 1]), copies: 2 },
    ];
    expect(enforceFloor([{ label: "Thing", members: [0, 1] }], overlapping, 3)).toEqual([]);
  });

  it("reports everything at a floor of one", () => {
    const gaps = enforceFloor([{ label: "Trains", members: [1] }], deduped, 1);
    expect(gaps).toEqual([{ label: "Trains", questions: 1, askers: 1 }]);
  });

  it("drops a label that is one of the questions", () => {
    const gaps = enforceFloor(
      [{ label: "Expense a flight", members: [0] }],
      deduped,
      3,
    );
    expect(gaps).toEqual([]);
  });

  // Fix round 1, finding 3: a single short word is no longer dropped just
  // because it also appears in a question. The report's own line ("Expenses
  // — 5 questions, 3 people") already states this word; an admin who learns
  // it also occurred inside a question is told nothing new.
  it("keeps a short topic word even though it also occurs inside a question", () => {
    const gaps = enforceFloor([{ label: "flight", members: [0] }], deduped, 3);
    expect(gaps).toEqual([{ label: "flight", questions: 5, askers: 3 }]);
  });

  it("drops a label that wraps one single question in extra words", () => {
    const gaps = enforceFloor(
      [{ label: "about: expense a flight, please", members: [0] }],
      deduped,
      3,
    );
    expect(gaps).toEqual([]);
  });

  describe("the containment rule, split (fix round 1, finding 3)", () => {
    it("treats a plural and singular subject the same, unlike raw substring matching", () => {
      // Before the split: `"how do i expense a flight".includes("expense")`
      // is true and had no threshold, so "Expense" was dropped while
      // "Expenses" — not a substring of the same question — survived. Same
      // subject, opposite outcomes, decided by a model's choice of suffix.
      const singular: DedupedQuestion[] = [
        { question: "how do i expense a flight", askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(enforceFloor([{ label: "Expense", members: [0] }], singular, 3)).toEqual([
        { label: "Expense", questions: 3, askers: 3 },
      ]);
      expect(enforceFloor([{ label: "Expenses", members: [0] }], singular, 3)).toEqual([
        { label: "Expenses", questions: 3, askers: 3 },
      ]);
    });

    it("does not match a label against a larger word that happens to contain it", () => {
      // The review's own named example: a raw substring check matches "ai"
      // inside "email" and "hr" inside "hrs" with no word boundary.
      const d: DedupedQuestion[] = [
        { question: "can you forward that email", askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(enforceFloor([{ label: "AI", members: [0] }], d, 3)).toEqual([
        { label: "AI", questions: 3, askers: 3 },
      ]);
    });

    it("does not treat a label as a quotation when it only matches inside a larger word", () => {
      // A raw, boundary-ignorant substring check matches "pineapple torte
      // recipe ideas" here (it is literally `question.slice(1, -1)`) and, at
      // four words, would drop it. It is not a quotation: the question's
      // actual words are "xpineapple" and "ideasy", not these — the match
      // only exists because word boundaries were not checked.
      const d: DedupedQuestion[] = [
        { question: "xpineapple torte recipe ideasy", askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      const gaps = enforceFloor(
        [{ label: "pineapple torte recipe ideas", members: [0] }],
        d,
        3,
      );
      expect(gaps).toEqual([{ label: "pineapple torte recipe ideas", questions: 3, askers: 3 }]);
    });

    it("drops a short label when it embeds a whole question (direction B is unconditional)", () => {
      const d: DedupedQuestion[] = [
        { question: "when is payday", askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(enforceFloor([{ label: "FAQ: when is payday", members: [0] }], d, 3)).toEqual([]);
    });

    it("drops a quotation at exactly the word-count threshold, keeps one word short", () => {
      const d: DedupedQuestion[] = [
        {
          question: "please note aa bb cc dd for the record always",
          askerKeys: new Set([1, 2, 3]),
          copies: 3,
        },
      ];
      expect(enforceFloor([{ label: "aa bb cc dd", members: [0] }], d, 3)).toEqual([]);
      expect(enforceFloor([{ label: "aa bb cc", members: [0] }], d, 3)).toEqual([
        { label: "aa bb cc", questions: 3, askers: 3 },
      ]);
    });

    it("drops a quotation at exactly the character threshold, keeps one character short", () => {
      const atForty: DedupedQuestion[] = [
        { question: `intro ${"a".repeat(40)} outro`, askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(enforceFloor([{ label: "a".repeat(40), members: [0] }], atForty, 3)).toEqual([]);

      const atThirtyNine: DedupedQuestion[] = [
        { question: `intro ${"a".repeat(39)} outro`, askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(
        enforceFloor([{ label: "a".repeat(39), members: [0] }], atThirtyNine, 3),
      ).toEqual([{ label: "a".repeat(39), questions: 3, askers: 3 }]);
    });

    it("drops a quotation at exactly the ratio threshold, keeps it just below", () => {
      const fiveWords: DedupedQuestion[] = [
        { question: "aa bb cc dd ee", askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(enforceFloor([{ label: "aa bb cc", members: [0] }], fiveWords, 3)).toEqual([]);

      const sixWords: DedupedQuestion[] = [
        { question: "aa bb cc dd ee ff", askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(enforceFloor([{ label: "aa bb cc", members: [0] }], sixWords, 3)).toEqual([
        { label: "aa bb cc", questions: 3, askers: 3 },
      ]);
    });
  });

  it("checks containment against the untruncated label, not only the truncated one (fix round 1, finding 1)", () => {
    const berlin: DedupedQuestion[] = [
      {
        question: "how do i expense a flight to the berlin office",
        askerKeys: new Set([1, 2, 3]),
        copies: 3,
      },
    ];
    // Truncated to 80 characters this becomes "...how do i expense a flight
    // to th", which embeds no whole question and would pass the check if the
    // check ran only on the truncated label. It must run on the full label
    // too.
    const label =
      "Questions about the expense policy, for example: how do i expense a flight to the berlin office";
    expect(enforceFloor([{ label, members: [0] }], berlin, 3)).toEqual([]);
  });

  it("drops a label that quotes a question from a different cluster (fix round 1, finding 2)", () => {
    // Labelled over question 0 ("expense a flight") but written in question
    // 1's exact words ("expense a train"). A check scoped to this cluster's
    // own members would never see question 1 and would keep this; the model
    // saw every question, so the check must too.
    const gaps = enforceFloor([{ label: "expense a train", members: [0] }], deduped, 3);
    expect(gaps).toEqual([]);
  });

  it("refuses a floor that is not a positive integer rather than reporting everything (fix round 1, finding 4)", () => {
    const clusters = [{ label: "Expenses", members: [0] }];
    expect(enforceFloor(clusters, deduped, 0)).toEqual([]);
    expect(enforceFloor(clusters, deduped, Number.NaN)).toEqual([]);
    expect(enforceFloor(clusters, deduped, null)).toEqual([]);
  });

  it("does not let a repeated member index inflate a gap's count (fix round 1, finding 5)", () => {
    const gaps = enforceFloor([{ label: "Expenses", members: [0, 0, 0] }], deduped, 3);
    expect(gaps).toEqual([{ label: "Expenses", questions: 5, askers: 3 }]);
  });

  /** Review Focus 4. */
  it("drops an empty or whitespace label", () => {
    expect(enforceFloor([{ label: "", members: [0] }], deduped, 3)).toEqual([]);
    expect(enforceFloor([{ label: "   ", members: [0] }], deduped, 3)).toEqual([]);
  });

  it("truncates a label that ran away, keeping the prefix (fix round 1, finding 8)", () => {
    // Fix round 1, finding 8: every character was "x" before, so a prefix, a
    // suffix and a middle slice of the same length were indistinguishable.
    const longLabel = "0123456789".repeat(40);
    const gaps = enforceFloor([{ label: longLabel, members: [0] }], deduped, 3);
    expect(gaps[0].label).toBe(longLabel.slice(0, MAX_LABEL_CHARS));
    expect(gaps[0].label.length).toBe(MAX_LABEL_CHARS);
  });

  it("truncates by code point, so a surrogate pair at the boundary survives whole (fix round 1, finding 9)", () => {
    const label = "a".repeat(79) + "😀" + "b".repeat(50);
    const gaps = enforceFloor([{ label, members: [0] }], deduped, 3);
    expect([...gaps[0].label]).toHaveLength(MAX_LABEL_CHARS);
    expect(gaps[0].label.endsWith("😀")).toBe(true);
  });

  it("ignores a member index the model invented", () => {
    const gaps = enforceFloor([{ label: "Expenses", members: [0, 99, -1] }], deduped, 3);
    expect(gaps).toEqual([{ label: "Expenses", questions: 5, askers: 3 }]);
  });

  it("drops a cluster whose members are all invented", () => {
    expect(enforceFloor([{ label: "Nothing", members: [99] }], deduped, 3)).toEqual([]);
  });

  it("orders by how many questions are behind the gap", () => {
    const gaps = enforceFloor(
      [
        { label: "Payroll", members: [2] },
        { label: "Expenses", members: [0] },
      ],
      deduped,
      1,
    );
    expect(gaps.map((g) => g.label)).toEqual(["Expenses", "Payroll"]);
  });
});
