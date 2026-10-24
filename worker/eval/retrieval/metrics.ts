import type { RetrievedChunk } from "../../src/lib/rag";
import type { Category } from "./cases";

/** One case, as the runner saw it. */
export type CaseResult = {
  id: string;
  category: Category;
  lang: "tr" | "en";
  /** 1-based rank of the first passage containing any marker, or null. */
  rank: number | null;
  /** How many sources `citable` kept. */
  cited: number;
  /** `ragBlock.length`: what the model would have read. */
  blockChars: number;
  /** Retrieval wall time. */
  ms: number;
};

export type AnsweredScore = { cases: number; recallAt5: number; recallAt10: number; mrr: number };
export type NegativeScore = { cases: number; passRate: number; meanBlockChars: number };
export type CategoryScore = AnsweredScore | NegativeScore;

export type Report = {
  label: string;
  ranAt: string;
  model: string;
  overall: {
    recallAt5: number;
    recallAt10: number;
    mrr: number;
    negativePassRate: number;
    p50ms: number;
    p95ms: number;
  };
  byCategory: Partial<Record<Category, CategoryScore>>;
  byLang: Record<"tr" | "en", { recallAt5: number; mrr: number }>;
  cases: CaseResult[];
};

export function rankOf(passages: RetrievedChunk[], expect: string[]): number | null {
  const i = passages.findIndex((p) => expect.some((marker) => p.content.includes(marker)));
  return i === -1 ? null : i + 1;
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const within = (k: number) => (r: CaseResult) => (r.rank !== null && r.rank <= k ? 1 : 0);
const reciprocal = (r: CaseResult) => (r.rank === null ? 0 : 1 / r.rank);

function answered(results: CaseResult[]): AnsweredScore {
  return {
    cases: results.length,
    recallAt5: mean(results.map(within(5))),
    recallAt10: mean(results.map(within(10))),
    mrr: mean(results.map(reciprocal)),
  };
}

function negative(results: CaseResult[]): NegativeScore {
  return {
    cases: results.length,
    passRate: mean(results.map((r) => (r.cited === 0 ? 1 : 0))),
    meanBlockChars: mean(results.map((r) => r.blockChars)),
  };
}

/** Nearest-rank percentile: the smallest value at or above `p` of the sorted list. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function score(label: string, model: string, results: CaseResult[]): Report {
  const positives = results.filter((r) => r.category !== "negative");
  const negatives = results.filter((r) => r.category === "negative");

  const byCategory: Partial<Record<Category, CategoryScore>> = {};
  for (const category of new Set(results.map((r) => r.category))) {
    const these = results.filter((r) => r.category === category);
    byCategory[category] = category === "negative" ? negative(these) : answered(these);
  }

  const lang = (l: "tr" | "en") => {
    const s = answered(positives.filter((r) => r.lang === l));
    return { recallAt5: s.recallAt5, mrr: s.mrr };
  };

  const overall = answered(positives);
  const ms = results.map((r) => r.ms);
  return {
    label,
    ranAt: new Date().toISOString(),
    model,
    overall: {
      recallAt5: overall.recallAt5,
      recallAt10: overall.recallAt10,
      mrr: overall.mrr,
      negativePassRate: negative(negatives).passRate,
      p50ms: percentile(ms, 50),
      p95ms: percentile(ms, 95),
    },
    byCategory,
    byLang: { tr: lang("tr"), en: lang("en") },
    cases: results,
  };
}
