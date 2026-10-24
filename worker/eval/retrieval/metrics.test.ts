import { describe, expect, it } from "vitest";
import { lostCases, rankOf, score, type CaseResult } from "./metrics";
import type { RetrievedChunk } from "../../src/lib/rag";

const passage = (content: string): RetrievedChunk => ({
  documentId: "d",
  documentName: "doc.md",
  content,
  similarity: 0.5,
});

const result = (over: Partial<CaseResult>): CaseResult => ({
  id: "c",
  category: "paraphrase",
  lang: "en",
  rank: null,
  cited: 0,
  blockChars: 0,
  ms: 10,
  ...over,
});

describe("rankOf", () => {
  const passages = ["alpha", "beta", "gamma marker here", "delta"].map(passage);

  it("is the 1-based position of the first passage holding a marker", () => {
    expect(rankOf(passages, ["marker"])).toBe(3);
  });

  it("is null when no passage holds any marker", () => {
    expect(rankOf(passages, ["nowhere"])).toBeNull();
  });

  it("takes whichever marker appears first", () => {
    expect(rankOf(passages, ["gamma", "alpha"])).toBe(1);
  });
});

describe("score", () => {
  it("measures recall at 5 and 10 and the mean reciprocal rank", () => {
    const report = score(
      "x",
      "m",
      [1, 3, 7, null].map((rank, i) => result({ id: `c${i}`, rank })),
    );
    const s = report.byCategory.paraphrase as {
      recallAt5: number;
      recallAt10: number;
      mrr: number;
    };
    expect(s.recallAt5).toBe(0.5);
    expect(s.recallAt10).toBe(0.75);
    expect(s.mrr).toBeCloseTo((1 + 1 / 3 + 1 / 7 + 0) / 4);
    expect(report.overall.mrr).toBeCloseTo(s.mrr);
  });

  it("passes a negative case only when nothing was cited", () => {
    const report = score(
      "x",
      "m",
      [0, 0, 2].map((cited, i) => result({ id: `n${i}`, category: "negative", cited })),
    );
    const s = report.byCategory.negative as { passRate: number };
    expect(s.passRate).toBeCloseTo(2 / 3);
    expect(report.overall.negativePassRate).toBeCloseTo(2 / 3);
  });

  it("leaves negative cases out of overall recall", () => {
    const report = score("x", "m", [
      result({ id: "a", rank: 1 }),
      result({ id: "n", category: "negative", rank: null }),
    ]);
    expect(report.overall.recallAt5).toBe(1);
  });

  it("reports retrieval time at the 50th and 95th percentile by nearest rank", () => {
    const report = score(
      "x",
      "m",
      [10, 20, 30, 40, 1000].map((ms, i) => result({ id: `t${i}`, rank: 1, ms })),
    );
    expect(report.overall.p50ms).toBe(30);
    expect(report.overall.p95ms).toBe(1000);
  });
});

/**
 * A category of seven or eight cases moves 0.125–0.143 when one case flips,
 * and the baseline run twice flipped one by noise alone. So a category is
 * flagged for losing more than one case, not for a fraction a single case
 * already exceeds.
 */
describe("lostCases", () => {
  it("counts how many cases a category lost at recall@5", () => {
    expect(lostCases(0.625, 0.5, 8)).toBe(1);
    expect(lostCases(0.625, 0.375, 8)).toBe(2);
  });

  it("is zero or negative when the category held or gained", () => {
    expect(lostCases(0.5, 0.5, 8)).toBe(0);
    expect(lostCases(0.5, 0.625, 8)).toBe(-1);
  });
});
