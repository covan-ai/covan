import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { lostCases, type Report } from "./metrics";

/**
 * Two runs side by side, by category.
 *
 *   bun eval/retrieval/compare.ts baseline rerank-v1
 *
 * A category is flagged when it lost more than one case at recall@5 (pass
 * rate, for negatives) — the README's keep rule. One case is within noise.
 */
const MAX_LOST_CASES = 1;

const here = dirname(fileURLToPath(import.meta.url));
const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error("usage: bun eval/retrieval/compare.ts <label-a> <label-b>");
  process.exit(1);
}
const load = (label: string) =>
  JSON.parse(readFileSync(join(here, "results", `${label}.json`), "utf8")) as Report;
const ra = load(a);
const rb = load(b);

const signed = (x: number, digits = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`;
const rows: Record<string, Record<string, string>> = {};
for (const category of Object.keys({ ...ra.byCategory, ...rb.byCategory })) {
  const sa = ra.byCategory[category as keyof Report["byCategory"]];
  const sb = rb.byCategory[category as keyof Report["byCategory"]];
  if (!sa || !sb) {
    rows[category] = { note: "only in one run" };
  } else if ("passRate" in sa && "passRate" in sb) {
    const d = sb.passRate - sa.passRate;
    const lost = lostCases(sa.passRate, sb.passRate, sb.cases);
    rows[category] = { pass: signed(d), flag: lost > MAX_LOST_CASES ? "DROP" : "" };
  } else if (!("passRate" in sa) && !("passRate" in sb)) {
    const d5 = sb.recallAt5 - sa.recallAt5;
    rows[category] = {
      "R@5": signed(d5),
      "R@10": signed(sb.recallAt10 - sa.recallAt10),
      MRR: signed(sb.mrr - sa.mrr),
      flag: lostCases(sa.recallAt5, sb.recallAt5, sb.cases) > MAX_LOST_CASES ? "DROP" : "",
    };
  }
}
rows.overall = {
  "R@5": signed(rb.overall.recallAt5 - ra.overall.recallAt5),
  "R@10": signed(rb.overall.recallAt10 - ra.overall.recallAt10),
  MRR: signed(rb.overall.mrr - ra.overall.mrr),
  pass: signed(rb.overall.negativePassRate - ra.overall.negativePassRate),
};
console.log(`${a} → ${b}`);
console.table(rows);
console.log(
  `p50 ${ra.overall.p50ms} → ${rb.overall.p50ms} ms, p95 ${ra.overall.p95ms} → ${rb.overall.p95ms} ms`,
);
