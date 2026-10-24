import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { embeddingModel } from "../../src/lib/embeddings";
import { retrieveForAgent, type RetrievalConfig } from "../../src/lib/retrieval";
import { isAccountError, loadEnv } from "../env";
import { CASES, loadCorpus } from "./cases";
import { cachedEmbedder } from "./embed-cache";
import { rankOf, score, type CaseResult, type Report } from "./metrics";
import { invalidRetrieval, missingStackVars } from "./preflight";
import { seedCorpus, teardown } from "./stack";

/**
 * The retrieval benchmark. See README.md beside this file for how to bring the
 * stack up and what the numbers can and cannot say.
 *
 *   bun eval/retrieval/run.ts --label baseline
 */

const here = dirname(fileURLToPath(import.meta.url));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const label = arg("label");
if (!label || !/^[\w.-]+$/.test(label)) {
  console.error("usage: bun eval/retrieval/run.ts --label <name>   (letters, digits, . _ -)");
  process.exit(1);
}

const env: RetrievalConfig = {
  ...loadEnv(),
  EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL,
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL,
  EMBEDDING_DIMENSIONS: process.env.EMBEDDING_DIMENSIONS,
  RAG_MIN_SIMILARITY: process.env.RAG_MIN_SIMILARITY,
  RAG_LEXICAL: process.env.RAG_LEXICAL,
};

const missing = missingStackVars({ ...process.env, OPENAI_API_KEY: env.OPENAI_API_KEY });
if (missing.length > 0) {
  console.error(`missing: ${missing.join(", ")} — see eval/retrieval/README.md`);
  process.exit(1);
}

function printTable(report: Report) {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const rows: Record<string, Record<string, string | number>> = {};
  for (const [category, s] of Object.entries(report.byCategory)) {
    rows[category] =
      "passRate" in s
        ? { cases: s.cases, pass: pct(s.passRate), "block chars": Math.round(s.meanBlockChars) }
        : {
            cases: s.cases,
            "R@5": pct(s.recallAt5),
            "R@10": pct(s.recallAt10),
            MRR: s.mrr.toFixed(3),
          };
  }
  const o = report.overall;
  rows.overall = {
    "R@5": pct(o.recallAt5),
    "R@10": pct(o.recallAt10),
    MRR: o.mrr.toFixed(3),
    pass: pct(o.negativePassRate),
  };
  for (const lang of ["tr", "en"] as const) {
    rows[`lang ${lang}`] = {
      "R@5": pct(report.byLang[lang].recallAt5),
      MRR: report.byLang[lang].mrr.toFixed(3),
    };
  }
  console.table(rows);
  console.log(`retrieval p50 ${o.p50ms} ms, p95 ${o.p95ms} ms`);
}

async function main() {
  const seeded = await seedCorpus(loadCorpus(), cachedEmbedder(env, join(here, ".cache")));
  console.log(`indexed ${seeded.passages} passages`);

  const results: CaseResult[] = [];
  for (const c of CASES) {
    const history = c.history ? [...c.history, { role: "user" as const, content: c.question }] : [];
    const started = performance.now();
    const r = await retrieveForAgent(seeded.user.db, env, seeded.agentId, c.question, history);
    const ms = Math.round(performance.now() - started);
    const invalid = invalidRetrieval(r, c.id);
    if (invalid) throw new Error(invalid);
    results.push({
      id: c.id,
      category: c.category,
      lang: c.lang,
      rank: rankOf(r.passages, c.expect),
      cited: r.sources.length,
      blockChars: r.ragBlock.length,
      ms,
    });
  }

  const report = score(label as string, embeddingModel(env), results);
  mkdirSync(join(here, "results"), { recursive: true });
  const file = join(here, "results", `${label}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  printTable(report);
  console.log(`wrote ${file}`);
}

try {
  await main();
} catch (err) {
  if (isAccountError(err)) console.error("the embedding account refused the call (key or credit):");
  console.error(err);
  process.exitCode = 1;
} finally {
  await teardown();
}
