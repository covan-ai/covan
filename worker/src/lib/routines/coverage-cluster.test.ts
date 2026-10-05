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
    expect(enforceFloor([{ label: "Payday", members: [2] }], deduped, 3)).toEqual([]);
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

  // The equality case above passes even with a naive `===` check. These two
  // prove the actual rule is containment: a label need not match a question
  // exactly to identify its asker, just appear inside one or wrap one.
  it("drops a label that is a fragment of one single question", () => {
    const gaps = enforceFloor([{ label: "flight", members: [0] }], deduped, 3);
    expect(gaps).toEqual([]);
  });

  it("drops a label that wraps one single question in extra words", () => {
    const gaps = enforceFloor(
      [{ label: "about: expense a flight, please", members: [0] }],
      deduped,
      3,
    );
    expect(gaps).toEqual([]);
  });

  /** Review Focus 4. */
  it("drops an empty or whitespace label", () => {
    expect(enforceFloor([{ label: "", members: [0] }], deduped, 3)).toEqual([]);
    expect(enforceFloor([{ label: "   ", members: [0] }], deduped, 3)).toEqual([]);
  });

  it("truncates a label that ran away", () => {
    const gaps = enforceFloor(
      [{ label: "x".repeat(400), members: [0] }],
      deduped,
      3,
    );
    expect(gaps[0].label.length).toBe(MAX_LABEL_CHARS);
  });

  it("ignores a member index the model invented", () => {
    const gaps = enforceFloor([{ label: "Expenses", members: [0, 99, -1] }], deduped, 3);
    expect(gaps).toEqual([{ label: "Expenses", questions: 5, askers: 3 }]);
  });

  it("drops a cluster whose members are all invented", () => {
    expect(enforceFloor([{ label: "Nothing", members: [99] }], deduped, 3)).toEqual([]);
  });

  it("orders by how many questions are behind the gap", () => {
    // "Payroll", not "Payday": the brief's original fixture, "Payday", is a
    // literal substring of deduped[2]'s question ("when is payday") and the
    // containment check above correctly drops it — a collision with the
    // fixture, not with the ordering this test means to check.
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
