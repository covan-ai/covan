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

  it("emits a label that is one of the questions without a name", () => {
    const gaps = enforceFloor([{ label: "Expense a flight", members: [0] }], deduped, 3);
    expect(gaps).toEqual([{ label: null, questions: 5, askers: 3 }]);
  });

  // Fix round 1, finding 3: a single short word is no longer dropped just
  // because it also appears in a question. The report's own line ("Expenses
  // — 5 questions, 3 people") already states this word; an admin who learns
  // it also occurred inside a question is told nothing new.
  it("keeps a short topic word even though it also occurs inside a question", () => {
    const gaps = enforceFloor([{ label: "flight", members: [0] }], deduped, 3);
    expect(gaps).toEqual([{ label: "flight", questions: 5, askers: 3 }]);
  });

  it("emits a label that wraps one single question in extra words without a name", () => {
    const gaps = enforceFloor(
      [{ label: "about: expense a flight, please", members: [0] }],
      deduped,
      3,
    );
    expect(gaps).toEqual([{ label: null, questions: 5, askers: 3 }]);
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
      // inside "email" and "hr" inside "hrs" with no word boundary. Fix
      // round 2: tokenising makes this stronger than a boundary check ever
      // was — "email" and "hrs" are each one indivisible token, so there is
      // no position at which "ai" or "hr" could appear as a token on their
      // own.
      const email: DedupedQuestion[] = [
        { question: "can you forward that email", askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(enforceFloor([{ label: "AI", members: [0] }], email, 3)).toEqual([
        { label: "AI", questions: 3, askers: 3 },
      ]);

      const hrs: DedupedQuestion[] = [
        { question: "the hrs are flexible this week", askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(enforceFloor([{ label: "HR", members: [0] }], hrs, 3)).toEqual([
        { label: "HR", questions: 3, askers: 3 },
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
      const gaps = enforceFloor([{ label: "pineapple torte recipe ideas", members: [0] }], d, 3);
      expect(gaps).toEqual([{ label: "pineapple torte recipe ideas", questions: 3, askers: 3 }]);
    });

    it("unnames a short label when it embeds a whole question (direction B is unconditional)", () => {
      const d: DedupedQuestion[] = [
        { question: "when is payday", askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(enforceFloor([{ label: "FAQ: when is payday", members: [0] }], d, 3)).toEqual([
        { label: null, questions: 3, askers: 3 },
      ]);
    });

    describe("fix round 2: terminal punctuation must not defeat direction B", () => {
      // The regression this round found: `containsAsWholeWords` matched with
      // a regex `\b` at each end of the needle. A needle ending in
      // punctuation — almost every real question, via "?" — can leave both
      // sides of that final `\b` non-word, so the boundary never fires and
      // the match silently fails. Reproduced and fixed by tokenising instead
      // of matching on a word-boundary regex.
      it("unnames when the question ends in '?' and the label is exactly the question", () => {
        const d: DedupedQuestion[] = [
          { question: "how do i expense a flight?", askerKeys: new Set([1, 2, 3]), copies: 3 },
        ];
        expect(enforceFloor([{ label: "How do I expense a flight?", members: [0] }], d, 3)).toEqual(
          [{ label: null, questions: 3, askers: 3 }],
        );
      });

      it("unnames when the question ends in '?' and the label embeds it in extra words", () => {
        const d: DedupedQuestion[] = [
          { question: "how do i expense a flight?", askerKeys: new Set([1, 2, 3]), copies: 3 },
        ];
        expect(
          enforceFloor(
            [{ label: "FAQ: how do I expense a flight? (see policy)", members: [0] }],
            d,
            3,
          ),
        ).toEqual([{ label: null, questions: 3, askers: 3 }]);
      });

      it("unnames when the question ends in '.'", () => {
        const d: DedupedQuestion[] = [
          { question: "how do i expense a flight.", askerKeys: new Set([1, 2, 3]), copies: 3 },
        ];
        expect(enforceFloor([{ label: "How do I expense a flight.", members: [0] }], d, 3)).toEqual(
          [{ label: null, questions: 3, askers: 3 }],
        );
      });

      it("unnames when the question has no terminal punctuation at all (control)", () => {
        const d: DedupedQuestion[] = [
          { question: "how do i expense a flight", askerKeys: new Set([1, 2, 3]), copies: 3 },
        ];
        expect(enforceFloor([{ label: "How do I expense a flight", members: [0] }], d, 3)).toEqual([
          { label: null, questions: 3, askers: 3 },
        ]);
      });
    });

    describe("fix round 3: direction B must catch scripts with no inter-word separators", () => {
      // `tokenise` splits on runs of non-letter/non-digit characters, so a
      // question glued directly onto a label — no space, no punctuation at
      // the seam — tokenises as part of ONE run with whatever it is glued
      // to. That run is a superstring of the question's own token, and
      // `containsTokenSequence` correctly refuses to call a superstring a
      // match. Gluing text straight onto a question with no separator is
      // the ordinary way a label wraps one in Japanese, Chinese or Thai —
      // unlike English, which needs a space or punctuation to glue anything
      // at all, which is why English never hit this. Each case below is
      // known-failing without the raw-substring disjunct added this round.
      it("unnames a label that wraps a Japanese question with no separator", () => {
        const d: DedupedQuestion[] = [
          { question: "経費精算はどうやるの", askerKeys: new Set([1, 2, 3]), copies: 3 },
        ];
        expect(
          enforceFloor([{ label: "経費精算はどうやるのという質問について", members: [0] }], d, 3),
        ).toEqual([{ label: null, questions: 3, askers: 3 }]);
      });

      it("unnames a label that wraps a Chinese question with no separator", () => {
        const d: DedupedQuestion[] = [
          { question: "报销流程是怎样的", askerKeys: new Set([1, 2, 3]), copies: 3 },
        ];
        expect(
          enforceFloor([{ label: "关于报销流程是怎样的这个问题", members: [0] }], d, 3),
        ).toEqual([{ label: null, questions: 3, askers: 3 }]);
      });

      it("unnames a label that wraps a Thai question with no separator", () => {
        const d: DedupedQuestion[] = [
          {
            question: "คำถามเกี่ยวกับการเบิกค่าใช้จ่าย",
            askerKeys: new Set([1, 2, 3]),
            copies: 3,
          },
        ];
        expect(
          enforceFloor(
            [{ label: "สรุปคำถามเกี่ยวกับการเบิกค่าใช้จ่ายทั้งหมด", members: [0] }],
            d,
            3,
          ),
        ).toEqual([{ label: null, questions: 3, askers: 3 }]);
      });

      it("unnames an English label that wraps a question with a separator (control)", () => {
        // English cannot reproduce the bug above — a label cannot glue
        // letters onto an English question without a space or punctuation —
        // so this exists to show the token-sequence path and the
        // raw-substring disjunct agree where both can fire.
        const d: DedupedQuestion[] = [
          { question: "when is payday", askerKeys: new Set([1, 2, 3]), copies: 3 },
        ];
        expect(enforceFloor([{ label: "FAQ: when is payday", members: [0] }], d, 3)).toEqual([
          { label: null, questions: 3, askers: 3 },
        ]);
      });

      it("does not let the raw-substring disjunct reach direction A's sub-word false positives", () => {
        // The new disjunct is added only to direction B's branch, before the
        // token-sequence check for direction A ever runs. If it leaked into
        // direction A, a short label would again match raw inside a larger
        // word — "ai" inside "email", "hr" inside "hrs" — which is the exact
        // defect that justified moving off raw substrings originally.
        const email: DedupedQuestion[] = [
          { question: "can you forward that email", askerKeys: new Set([1, 2, 3]), copies: 3 },
        ];
        expect(enforceFloor([{ label: "AI", members: [0] }], email, 3)).toEqual([
          { label: "AI", questions: 3, askers: 3 },
        ]);

        const hrs: DedupedQuestion[] = [
          { question: "the hrs are flexible this week", askerKeys: new Set([1, 2, 3]), copies: 3 },
        ];
        expect(enforceFloor([{ label: "HR", members: [0] }], hrs, 3)).toEqual([
          { label: "HR", questions: 3, askers: 3 },
        ]);
      });
    });

    describe("fix round 6: a sub-word match costs the name, not the row", () => {
      // Round 3 added a raw substring check to direction B for scripts
      // `tokenise` cannot segment. A substring match has no word boundary, so
      // on a two-letter question it censors not that question's topic but
      // every label containing those two letters anywhere — the "ai" inside
      // "email" defect, readmitted through direction B. Gap questions are
      // where junk lives, since they are by definition the ones that found
      // nothing, so a colleague typing "hi" at an agent was deleting a slice
      // of the week's report.
      //
      // Round 5 answered that with a five-character floor on the needle, and
      // that floor is what shipped the Critical: four characters in a script
      // with no inter-word separators is not a topic word, it is a whole
      // first-person sentence, and a label wrapping one reached the admin
      // verbatim. Round 6 answers it where the cost actually is instead. The
      // refusal no longer deletes the row, so a false positive costs a NAME
      // and not a gap, and the needle needs no length at all: the match is
      // absolute again, as it was before the threshold, and the rows below
      // survive — nameless, counted, and visible to the admin as a refusal.
      const anchor: DedupedQuestion[] = [
        {
          question: "what is the hiring process for contractors",
          askerKeys: new Set([1, 2, 3]),
          copies: 4,
        },
      ];
      const withJunk = (q: string): DedupedQuestion[] => [
        ...anchor,
        { question: q, askerKeys: new Set([7]), copies: 1 },
      ];

      it("keeps the row, without its name, when a junk question runs through a word", () => {
        const labels = [
          "Hiring process",
          "Shipping and delivery",
          "Rapid prototyping",
          "Latest releases",
        ];
        // Each junk question is a sub-word run of at least one label:
        // *hi*ring, s*hi*pping, r*api*d, la*test*. Each is also a single
        // asker, so it is never reported in its own right. What the admin
        // loses to one of these is a topic name; what they keep is the fact
        // that the topic was there, which is the whole point of the change.
        for (const junk of ["hi", "ok", "vpn", "api", "test"]) {
          for (const label of labels) {
            const gaps = enforceFloor([{ label, members: [0] }], withJunk(junk), 3);
            expect(
              gaps,
              `${JSON.stringify(junk)} must not delete ${JSON.stringify(label)}`,
            ).toHaveLength(1);
            // Named or unnamed, the row survives and its counts are intact.
            expect(gaps[0].questions).toBe(4);
            expect(gaps[0].askers).toBe(3);
          }
        }
      });

      it("unnames rather than deletes at four characters and at five alike", () => {
        // One label, two needles differing only in length. "price" is a
        // literal run inside "prices"; "pric" is the same run one character
        // shorter. Round 5 split them — the first deleted the row, the second
        // was ignored — and that split is exactly what the Critical rode in
        // on. Now neither length decides anything: both refuse the name and
        // neither takes the gap with it.
        for (const junk of ["price", "pric"]) {
          expect(
            enforceFloor([{ label: "Prices and discounts", members: [0] }], withJunk(junk), 3),
            `${JSON.stringify(junk)} must unname rather than delete`,
          ).toEqual([{ label: null, questions: 4, askers: 3 }]);
        }
      });

      it("unnames rather than deletes for every junk question measured", () => {
        // The five needles and the labels they run through, from the review
        // that produced this change. Each pair was either a deleted row
        // (five characters and up) or a kept, named one (below five); every
        // pair is now one unnamed row.
        const pairs: [string, string][] = [
          ["hi", "Hiring process"],
          ["hi", "Shipping and delivery"],
          ["api", "Rapid prototyping"],
          ["test", "Latest releases"],
          ["price", "Prices and discounts"],
          ["state", "Real estate listings"],
        ];
        for (const [junk, label] of pairs) {
          expect(
            enforceFloor([{ label, members: [0] }], withJunk(junk), 3),
            `${JSON.stringify(junk)} vs ${JSON.stringify(label)}`,
          ).toEqual([{ label: null, questions: 4, askers: 3 }]);
        }
      });
    });

    describe("fix round 6: four characters with no separator is a sentence, not a word", () => {
      /**
       * The Critical round 5's threshold shipped, and the reason the
       * containment check stopped deciding two questions at once.
       *
       * Each question below is four characters long, has no inter-word
       * separator anywhere in it, and is a complete first-person sentence —
       * "I'm pregnant", "I want to resign". `tokenise` cannot segment any of
       * them, so the token-sequence check sees the label as one indivisible
       * superstring and correctly refuses to call that a match; the raw
       * substring check was the only thing left that could catch it, and a
       * five-character floor on the needle switched it off at exactly the
       * length where the needle stops being a word. Measured before this
       * change: all six reached the admin inside the label, verbatim.
       *
       * They must now come back UNNAMED. Not kept — the sentence is in the
       * label. Not deleted — a deleted row is indistinguishable from a quiet
       * week, and the admin is owed the topic's existence even when they
       * cannot be given its name.
       */
      const sentences: [string, string, string][] = [
        ["Chinese", "我怀孕了", "关于我怀孕了的问题"],
        ["Chinese", "我要辞职", "关于我要辞职的问题"],
        ["Japanese", "妊娠した", "妊娠したという質問について"],
        ["Japanese", "離婚する", "離婚するという質問について"],
        ["Korean", "임신했다", "임신했다라는질문에대해"],
        ["Korean", "퇴사한다", "퇴사한다라는질문에대해"],
      ];

      for (const [script, question, label] of sentences) {
        it(`unnames a ${script} four-character sentence glued into a label`, () => {
          expect([...question]).toHaveLength(4);
          const d: DedupedQuestion[] = [{ question, askerKeys: new Set([1, 2, 3]), copies: 3 }];
          const gaps = enforceFloor([{ label, members: [0] }], d, 3);
          expect(gaps).toEqual([{ label: null, questions: 3, askers: 3 }]);
          // Belt and braces: whatever else happens, the question itself must
          // not be sitting in an emitted label. `?? ""` because a withheld
          // label is `null`, and `toContain` refuses a null subject — the
          // coalesce keeps this assertion meaningful for a named label and
          // vacuously true for a withheld one, which is the right reading.
          for (const gap of gaps) expect(gap.label ?? "").not.toContain(question);
        });
      }
    });

    describe("fix round 6: every other refusal is still a deletion", () => {
      // The amendment turns ONE refusal into an unnamed row. The rest stay
      // drops, and a row with no name is not a licence to emit a row with no
      // topic behind it.
      it("deletes a cluster below the floor rather than unnaming it", () => {
        expect(enforceFloor([{ label: "Payroll", members: [2] }], deduped, 3)).toEqual([]);
      });

      it("deletes a cluster whose member indices were all invented", () => {
        expect(enforceFloor([{ label: "Nothing", members: [99] }], deduped, 3)).toEqual([]);
      });

      it("deletes a label with no letter or digit rather than unnaming it", () => {
        // There is no topic here to withhold the name of — the label never
        // named anything. Withholding it would put a nameless row in the
        // report for a cluster whose only distinguishing feature was
        // punctuation.
        expect(enforceFloor([{ label: "???!!!", members: [0] }], deduped, 3)).toEqual([]);
        expect(enforceFloor([{ label: "😀😀", members: [0] }], deduped, 3)).toEqual([]);
        expect(enforceFloor([{ label: "   ", members: [0] }], deduped, 3)).toEqual([]);
      });

      it("still refuses every cluster when the floor itself is nonsense", () => {
        const quoting = [{ label: "Expense a flight", members: [0] }];
        expect(enforceFloor(quoting, deduped, 0)).toEqual([]);
        expect(enforceFloor(quoting, deduped, null)).toEqual([]);
        expect(enforceFloor(quoting, deduped, Number.NaN)).toEqual([]);
      });
    });

    it("unnames a quotation at exactly the word-count threshold, names one word short", () => {
      const d: DedupedQuestion[] = [
        {
          question: "please note aa bb cc dd for the record always",
          askerKeys: new Set([1, 2, 3]),
          copies: 3,
        },
      ];
      expect(enforceFloor([{ label: "aa bb cc dd", members: [0] }], d, 3)).toEqual([
        { label: null, questions: 3, askers: 3 },
      ]);
      expect(enforceFloor([{ label: "aa bb cc", members: [0] }], d, 3)).toEqual([
        { label: "aa bb cc", questions: 3, askers: 3 },
      ]);
    });

    it("unnames a quotation at exactly the character threshold, names one character short", () => {
      const atForty: DedupedQuestion[] = [
        { question: `intro ${"a".repeat(40)} outro`, askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(enforceFloor([{ label: "a".repeat(40), members: [0] }], atForty, 3)).toEqual([
        { label: null, questions: 3, askers: 3 },
      ]);

      const atThirtyNine: DedupedQuestion[] = [
        { question: `intro ${"a".repeat(39)} outro`, askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(enforceFloor([{ label: "a".repeat(39), members: [0] }], atThirtyNine, 3)).toEqual([
        { label: "a".repeat(39), questions: 3, askers: 3 },
      ]);
    });

    it("unnames a quotation at exactly the ratio threshold, names it just below", () => {
      const fiveWords: DedupedQuestion[] = [
        { question: "aa bb cc dd ee", askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(enforceFloor([{ label: "aa bb cc", members: [0] }], fiveWords, 3)).toEqual([
        { label: null, questions: 3, askers: 3 },
      ]);

      const sixWords: DedupedQuestion[] = [
        { question: "aa bb cc dd ee ff", askerKeys: new Set([1, 2, 3]), copies: 3 },
      ];
      expect(enforceFloor([{ label: "aa bb cc", members: [0] }], sixWords, 3)).toEqual([
        { label: "aa bb cc", questions: 3, askers: 3 },
      ]);
    });

    describe("fix round 2: the same boundaries, with punctuation in the question", () => {
      // Proves the match fires through punctuation rather than being
      // defeated by it, at each threshold's exact boundary. It does NOT by
      // itself distinguish token-based counting from a whitespace split:
      // these particular fixtures put exactly one space between each
      // punctuation mark and the next word, so a whitespace split and
      // `tokenise` land on the same word count either way. (Fix round 3,
      // minor finding: this comment previously overclaimed what this block
      // pins down.)
      it("word-count threshold still lands correctly with commas and a trailing '?'", () => {
        const q = "please note, aa bb cc dd, for the record, always?";
        const d: DedupedQuestion[] = [{ question: q, askerKeys: new Set([1, 2, 3]), copies: 3 }];
        expect(enforceFloor([{ label: "aa bb cc dd", members: [0] }], d, 3)).toEqual([
          { label: null, questions: 3, askers: 3 },
        ]);
        expect(enforceFloor([{ label: "aa bb cc", members: [0] }], d, 3)).toEqual([
          { label: "aa bb cc", questions: 3, askers: 3 },
        ]);
      });

      it("character threshold still lands correctly with commas, '!' and a trailing '?'", () => {
        const atForty: DedupedQuestion[] = [
          {
            question: `intro, ${"a".repeat(40)}! outro?`,
            askerKeys: new Set([1, 2, 3]),
            copies: 3,
          },
        ];
        expect(enforceFloor([{ label: "a".repeat(40), members: [0] }], atForty, 3)).toEqual([
          { label: null, questions: 3, askers: 3 },
        ]);

        const atThirtyNine: DedupedQuestion[] = [
          {
            question: `intro, ${"a".repeat(39)}! outro?`,
            askerKeys: new Set([1, 2, 3]),
            copies: 3,
          },
        ];
        expect(enforceFloor([{ label: "a".repeat(39), members: [0] }], atThirtyNine, 3)).toEqual([
          { label: "a".repeat(39), questions: 3, askers: 3 },
        ]);
      });

      it("ratio threshold still lands correctly with commas and a trailing '.' or '?'", () => {
        const fiveWords: DedupedQuestion[] = [
          { question: "aa, bb, cc, dd, ee?", askerKeys: new Set([1, 2, 3]), copies: 3 },
        ];
        expect(enforceFloor([{ label: "aa bb cc", members: [0] }], fiveWords, 3)).toEqual([
          { label: null, questions: 3, askers: 3 },
        ]);

        const sixWords: DedupedQuestion[] = [
          { question: "aa, bb, cc, dd, ee, ff.", askerKeys: new Set([1, 2, 3]), copies: 3 },
        ];
        expect(enforceFloor([{ label: "aa bb cc", members: [0] }], sixWords, 3)).toEqual([
          { label: "aa bb cc", questions: 3, askers: 3 },
        ]);
      });
    });
  });

  it("checks containment against the untruncated label, not only the truncated one (fix round 1, finding 1)", () => {
    // Round 6: the refusal is now a missing name rather than a missing row,
    // so the assertion is `label: null`. What the finding was about is
    // unchanged — the check must see the label the model wrote, not only the
    // eighty characters of it that survive truncation.
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
    expect(enforceFloor([{ label, members: [0] }], berlin, 3)).toEqual([
      { label: null, questions: 3, askers: 3 },
    ]);
  });

  it("unnames a label that quotes a question from a different cluster (fix round 1, finding 2)", () => {
    // Labelled over question 0 ("expense a flight") but written in question
    // 1's exact words ("expense a train"). A check scoped to this cluster's
    // own members would never see question 1 and would name this; the model
    // saw every question, so the check must too.
    const gaps = enforceFloor([{ label: "expense a train", members: [0] }], deduped, 3);
    expect(gaps).toEqual([{ label: null, questions: 5, askers: 3 }]);
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

  it("drops a label with no letter or digit in it (fix round 3, minor)", () => {
    // "???!!!" and an emoji string are both non-empty after trimming, so the
    // empty-label check above does not catch them, and `isQuotation` calls
    // either "not a quotation" — there is nothing in them to compare against
    // a question. Without its own refusal, either survives as a blank-
    // looking bullet in the admin's email.
    expect(enforceFloor([{ label: "???!!!", members: [0] }], deduped, 3)).toEqual([]);
    expect(enforceFloor([{ label: "😀😀", members: [0] }], deduped, 3)).toEqual([]);
  });

  describe("fix round 4: the no-letter refusal must judge the label that is emitted", () => {
    // The refusal asked `tokenise(fullLabel).length === 0`, but the value
    // pushed into `gaps` is `truncatedLabel`. A label whose only letters or
    // digits fall past character 80 therefore satisfied the check on the
    // strength of letters the admin never sees, and the report printed the
    // eighty characters that remained — a bullet of pure punctuation.
    it("drops a label whose only letters or digits fall past the truncation boundary", () => {
      expect(
        enforceFloor(
          [{ label: "!".repeat(MAX_LABEL_CHARS) + "real topic words here", members: [0] }],
          deduped,
          3,
        ),
      ).toEqual([]);
      // Code points, not UTF-16 units: eighty emoji fill the whole budget.
      expect(
        enforceFloor(
          [{ label: "😀".repeat(MAX_LABEL_CHARS) + "payroll onboarding", members: [0] }],
          deduped,
          3,
        ),
      ).toEqual([]);
    });

    it("keeps a label whose letters fall inside the boundary (control)", () => {
      // The same shape the other way round, so the new refusal cannot be
      // passing by dropping every punctuation-heavy label: here the words are
      // in the part that survives truncation, and the label is reported.
      const label = "Expense policy" + "!".repeat(200);
      const gaps = enforceFloor([{ label, members: [0] }], deduped, 3);
      expect(gaps).toEqual([
        {
          label: "Expense policy" + "!".repeat(MAX_LABEL_CHARS - "Expense policy".length),
          questions: 5,
          askers: 3,
        },
      ]);
    });

    it("still catches a question hidden behind the punctuation as a quotation", () => {
      // Why this finding was a Minor and not a disclosure: `isQuotation` runs
      // on the untruncated label too (fix round 1, finding 1), so a question
      // parked past character 80 was always dropped — what got through was
      // only ever the punctuation, never anybody's words.
      //
      // Round 6: still a deletion, and now for the no-letter reason rather
      // than the quotation one. The no-letter refusal is asked first and is
      // still a drop, so this row never reaches the containment check that
      // would have unnamed it — which is the right order. A cluster whose
      // emitted label is eighty exclamation marks has no topic to withhold
      // the name of.
      expect(
        enforceFloor(
          [{ label: "!".repeat(MAX_LABEL_CHARS) + "expense a flight", members: [0] }],
          deduped,
          3,
        ),
      ).toEqual([]);
    });
  });

  it("truncates a label that ran away, keeping the prefix (fix round 1, finding 8)", () => {
    // Fix round 1, finding 8: every character was "x" before, so a prefix, a
    // suffix and a middle slice of the same length were indistinguishable.
    const longLabel = "0123456789".repeat(40);
    const gaps = enforceFloor([{ label: longLabel, members: [0] }], deduped, 3);
    // `?? ""` rather than a non-null assertion: a run of digits quotes
    // nobody, so this label must be NAMED, and coalescing a withheld label to
    // the empty string makes the assertion below fail on the value rather
    // than crash on the type.
    const emitted = gaps[0].label ?? "";
    expect(emitted).toBe(longLabel.slice(0, MAX_LABEL_CHARS));
    expect(emitted.length).toBe(MAX_LABEL_CHARS);
  });

  it("does not emit the whitespace that truncation left at the end (fix round 5)", () => {
    // The label is trimmed before truncation, which says nothing about the
    // end of the prefix: a label padded with whitespace in the middle was
    // reported as one word followed by seventy-nine spaces.
    const gaps = enforceFloor(
      [{ label: "Expenses" + " ".repeat(200) + "and travel", members: [0] }],
      deduped,
      3,
    );
    expect(gaps).toEqual([{ label: "Expenses", questions: 5, askers: 3 }]);
  });

  it("truncates by code point, so a surrogate pair at the boundary survives whole (fix round 1, finding 9)", () => {
    const label = "a".repeat(79) + "😀" + "b".repeat(50);
    const gaps = enforceFloor([{ label, members: [0] }], deduped, 3);
    // As above: a label of a's, b's and an emoji quotes nobody, so a withheld
    // label here is a failure of this assertion and not a type error.
    const emitted = gaps[0].label ?? "";
    expect([...emitted]).toHaveLength(MAX_LABEL_CHARS);
    expect(emitted.endsWith("😀")).toBe(true);
  });

  it("ignores a member index the model invented", () => {
    const gaps = enforceFloor([{ label: "Expenses", members: [0, 99, -1] }], deduped, 3);
    expect(gaps).toEqual([{ label: "Expenses", questions: 5, askers: 3 }]);
  });

  it("drops a cluster whose members are all invented", () => {
    expect(enforceFloor([{ label: "Nothing", members: [99] }], deduped, 3)).toEqual([]);
  });

  describe("fix round 1: the order is a function of the input and nothing else", () => {
    // The comparator was rewritten by the round-6 amendment — a `null` label
    // cannot be handed to `localeCompare` — and the comment beside it claimed
    // determinism. A default collator does not provide it: it is scoped to
    // the runtime's locale and ICU data, so the same two labels can order
    // differently on two machines. The renderer's byte-identical promise
    // rests on this function, so the ordering has to be the input's and not
    // the host's.
    const tie: DedupedQuestion[] = [
      { question: "zzz one", askerKeys: new Set([1, 2, 3]), copies: 2 },
      { question: "zzz two", askerKeys: new Set([1, 2, 3]), copies: 2 },
    ];

    it("breaks a tie between two labels without consulting a locale", () => {
      // "apple" and "Banana" are the cheapest pair that separates the two
      // rules: an English collator puts "apple" first (it ignores case to
      // compare a against b), code-unit order puts "Banana" first ("B" is
      // 66, "a" is 97). The assertion is not that this order reads better —
      // it is that no collator is involved. Both labels tie at two
      // questions, so the label is the only key left.
      const gaps = enforceFloor(
        [
          { label: "apple", members: [0] },
          { label: "Banana", members: [1] },
        ],
        tie,
        3,
      );
      expect(gaps.map((g) => g.questions)).toEqual([2, 2]);
      expect(gaps.map((g) => g.label)).toEqual(["Banana", "apple"]);
    });

    it("puts a named row before an unnamed one at the same question count", () => {
      const d: DedupedQuestion[] = [
        { question: "zzz one", askerKeys: new Set([1, 2, 3]), copies: 2 },
        { question: "when is payday", askerKeys: new Set([1, 2, 3]), copies: 2 },
      ];
      const gaps = enforceFloor(
        [
          // Quotes question 1, so it is withheld — and it is listed second
          // even though the model sent it first.
          { label: "FAQ: when is payday", members: [0] },
          { label: "Zebras", members: [1] },
        ],
        d,
        3,
      );
      expect(gaps.map((g) => g.label)).toEqual(["Zebras", null]);
    });

    it("keeps two rows that tie on every key in the order they arrived", () => {
      // Both withheld, both two questions: nothing is left to order them by,
      // so the input order stands. `Array.prototype.sort` is specified as
      // stable, which is what makes that a guarantee rather than an accident.
      const d: DedupedQuestion[] = [
        { question: "when is payday", askerKeys: new Set([1, 2, 3]), copies: 2 },
        { question: "where is the handbook", askerKeys: new Set([1, 2, 3]), copies: 2 },
      ];
      const gaps = enforceFloor(
        [
          { label: "FAQ: when is payday", members: [0] },
          { label: "FAQ: where is the handbook", members: [1] },
        ],
        d,
        3,
      );
      expect(gaps).toEqual([
        { label: null, questions: 2, askers: 3 },
        { label: null, questions: 2, askers: 3 },
      ]);
    });
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
