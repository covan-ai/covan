/**
 * Run the eval.
 *
 *   bun eval/run.ts --variant baseline            # freeze today's answers
 *   bun eval/run.ts --variant v1 --judge          # score v1 against baseline
 *   bun eval/run.ts --variant v1 --only db-,doc-  # a subset, by id prefix
 *
 * A change that is not to the code but to what is asked of the model — a
 * different model, a different reasoning effort — needs a reference of its
 * own, because the frozen one answers a different question. `--freeze` writes
 * one and `--against` names which one to score against:
 *
 *   EVAL_MODEL=gpt-5 bun eval/run.ts --variant gpt5-default --freeze
 *   EVAL_MODEL=gpt-5 bun eval/run.ts --variant gpt5-minimal --effort minimal \
 *       --judge --against gpt5-default
 *
 * Every invocation spends real money. The script prints what it is about to
 * run and what the last run cost before it starts, and `--dry` stops there.
 *
 * Results land in `.claude/hillclimb/agent-turn/<variant>/`:
 *
 *   results.jsonl   one row per (case, rep), written as it completes
 *   errors.jsonl    one row per attempt that never produced a scorable answer
 *   traces/         the full exchange per (case, rep)
 *   ref/            the frozen answers, written by the baseline variant only
 *
 * `ref/` is the reason a baseline run is a different thing from any other run.
 * A pairwise win rate only means something against a fixed opponent: regenerate
 * the reference and "60% wins" silently changes what it is 60% of. So the
 * baseline writes `ref/<id>.json` once and every later variant is judged
 * against those files, never against a fresh baseline pass. Each holds the
 * answer *and* the tools that turn ran, because the judge is shown both — half
 * of every rubric here is about process, and a reference without its
 * trajectory would put the candidate's process against nothing.
 */
import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, type EvalCase } from "./cases";
import { runCase, toTrace } from "./harness";
import { judgePair } from "./judge";
import { estimateCostUsd } from "../src/lib/pricing";
import { totalTokens } from "../src/lib/completion";
import { loadEnv, requireKeysFor, isAccountError } from "./env";
import { resolvePlan, describeConfig, refsAtRisk, EvalConfigError } from "./config";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", ".claude", "hillclimb", "agent-turn");

const MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-5";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "claude-opus-5";
const CONCURRENCY = Number(process.env.EVAL_CONCURRENCY ?? 4);
const REPS = Number(process.env.EVAL_REPS ?? 1);
/**
 * Five minutes rather than three, matching `calibrate.ts`.
 *
 * Three was measured against nothing, and calibration has now shown the turns
 * that go past it are real: `budget-exhausted` took eight steps on one sample
 * and nine on the next, and every pass of such a turn re-sends a transcript
 * the last tool's output has grown, so its slowest pass is its last one.
 *
 * The ceiling matters more here than in calibration. A timeout there costs one
 * verdict; a timeout in the baseline run leaves that case with no `ref/` file,
 * and a case absent from the frozen reference is absent from every comparison
 * made against it afterwards — silently, because a win rate over the cases
 * that survived looks exactly like a win rate over all of them.
 */
const CASE_TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS ?? 300_000);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const plan = (() => {
  try {
    return resolvePlan({
      variant: arg("variant") ?? "baseline",
      model: MODEL,
      effort: arg("effort") ?? process.env.EVAL_EFFORT ?? null,
      against: arg("against") ?? null,
      freeze: has("freeze"),
      refreeze: has("refreeze"),
      judge: has("judge"),
    });
  } catch (err) {
    if (!(err instanceof EvalConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
})();

const variant = plan.variant;
const shouldJudge = plan.judge;
const only = arg("only")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const selected = only ? CASES.filter((c) => only.some((p) => c.id.startsWith(p))) : CASES;

const dir = join(ROOT, variant);
const tracesDir = join(dir, "traces");
/** Where a freeze writes: its own variant directory, not a fixed `baseline`. */
const freezeDir = join(dir, "ref");
/** Where a judged run reads: the variant named by `--against`. */
const refDir = join(ROOT, plan.against, "ref");
mkdirSync(tracesDir, { recursive: true });
if (plan.freeze) mkdirSync(freezeDir, { recursive: true });

const resultsPath = join(dir, "results.jsonl");
const errorsPath = join(dir, "errors.jsonl");

/**
 * What is already on disk, so a crashed run resumes instead of re-buying.
 *
 * Keyed on (case, rep) rather than on case: with `--reps 3` a partial run has
 * some reps of some cases, and skipping the whole case would lose the rest
 * while skipping nothing would pay for the ones already bought twice.
 */
const done = new Set<string>();
if (existsSync(resultsPath)) {
  for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as { prompt_id: string; rep: number };
      done.add(`${row.prompt_id}#${row.rep}`);
    } catch {
      // A torn last line from a kill mid-write. Ignoring it re-runs that one
      // (case, rep), which is the safe direction: a duplicate row is visible,
      // a silently skipped one is not.
    }
  }
}

const env = loadEnv();
requireKeysFor(env, plan.judge ? [MODEL, JUDGE_MODEL] : [MODEL]);

const todo: Array<{ kase: EvalCase; rep: number }> = [];
for (const kase of selected) {
  for (let rep = 0; rep < REPS; rep++) {
    if (!done.has(`${kase.id}#${rep}`)) todo.push({ kase, rep });
  }
}

/**
 * What the reference was produced with, from beside the reference itself.
 *
 * A comparison between two configurations is meaningless unless both are on
 * screen, and the flag that sets one of them (`--against`) is the flag most
 * easily left off: forget it on a gpt-5 run and every case is scored against
 * Claude's answers, which reports "gpt-5 is unlike Claude" in the shape of a
 * quality regression. Written since this file could freeze more than one
 * reference, so an older one honestly reports that it did not say.
 */
function referenceConfig(): string {
  const path = join(refDir, "CONFIG.json");
  if (!existsSync(path)) return "not recorded (frozen before this was written)";
  try {
    const c = JSON.parse(readFileSync(path, "utf8")) as { model?: string; effort?: string | null };
    return describeConfig(c.model ?? "unknown", c.effort ?? null);
  } catch {
    return "unreadable";
  }
}

console.log(
  [
    `variant   ${variant}${plan.freeze ? "  (writes the frozen reference)" : ""}`,
    `candidate ${describeConfig(MODEL, plan.effort)}`,
    shouldJudge ? `reference ${plan.against}  (${referenceConfig()})` : "reference  —",
    shouldJudge ? `judge     ${JUDGE_MODEL}` : "judge     off",
    `cases     ${selected.length} × ${REPS} rep(s) = ${selected.length * REPS}`,
    `to run    ${todo.length}${done.size > 0 ? `  (${done.size} already on disk)` : ""}`,
    `output    ${dir}`,
  ].join("\n"),
);
for (const warning of plan.warnings) console.log(`\n!! ${warning}`);

if (todo.length === 0) {
  // And writes nothing. This branch used to re-emit the provenance record on
  // the theory that a reference produced before that file existed should get
  // one — which is true once and wrong every time after, because the date and
  // commit it writes are this invocation's and the answers are not. It was
  // caught doing exactly that: `--variant baseline --dry`, on a complete
  // reference, restamped the committed fixture with a later commit and a
  // dirty-tree warning. A flag documented as "stops before spending anything"
  // had edited the repository. A reference that genuinely lacks a record gets
  // a hand-written one, which is reviewable; a generated one that quietly
  // contradicts the answers beside it is not.
  console.log("\nNothing to run.");
  // A finished variant's tally, without buying it again. Reading a result back
  // is the one thing a complete run should still be able to do.
  if (shouldJudge) summarise();
  process.exit(0);
}
if (shouldJudge && !existsSync(refDir)) {
  console.error(
    `\nNo frozen reference at ${refDir} — run \`--variant ${plan.against} --freeze\` first.`,
  );
  process.exit(1);
}

/**
 * Refuse to overwrite a reference that already exists.
 *
 * `ref/` is committed and `results.jsonl` is not, so in a fresh clone the
 * resume set is empty while the fixture is fully present — and the first
 * `--variant baseline` would rewrite every answer every published number was
 * measured against, with no error and no diff anybody reads. A resumed freeze
 * is unaffected: the cases it already bought are not in its queue.
 */
if (plan.freeze && !plan.refreeze && existsSync(freezeDir)) {
  const frozen = readdirSync(freezeDir)
    .filter((f) => f.endsWith(".json") && f !== "CONFIG.json")
    .map((f) => f.slice(0, -".json".length));
  const risk = refsAtRisk(
    todo.map((t) => t.kase.id),
    frozen,
  );
  if (risk.length > 0) {
    console.error(
      [
        ``,
        `${risk.length} case(s) already have a frozen reference in ${freezeDir}:`,
        ``,
        ...risk.map((id) => `  ${id}`),
        ``,
        `A reference is a fixed opponent; replacing it silently changes what every`,
        `win rate measured against it was a rate of. Freeze a new variant instead,`,
        `or pass --refreeze if replacing this one is genuinely what you mean.`,
      ].join("\n"),
    );
    process.exit(1);
  }
}

if (has("dry")) {
  console.log("\n--dry: stopping before spending anything.");
  process.exit(0);
}
type Row = {
  prompt_id: string;
  rep: number;
  prompt: string;
  tags: string[];
  model: string;
  /** `null` is "no effort was sent", which is a different row from "medium". */
  effort: string | null;
  status: "ok" | "truncated";
  stop_reason: string | null;
  grade: Record<string, number>;
  explanation?: Record<string, string>;
  latency_s: number;
  tool_calls: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  judge_model?: string;
  judge_usage?: { input_tokens: number; output_tokens: number };
  meta: Record<string, unknown>;
};

let ran = 0;
let spend = 0;
/**
 * Cases this invocation started, counted rather than derived.
 *
 * `ran` counts the ones that produced a row, so `todo.length - ran` calls a
 * case that was attempted and failed "never attempted". That subtraction is
 * the exact mistake `calibrate.ts` made with `scored` — a measuring tool
 * reporting a number it made up — and it reappeared here the first time this
 * file had to report a short run.
 */
let attempted = 0;
/** Why the run stopped early, if it did. */
let abandoned: string | null = null;

async function one({ kase, rep }: { kase: EvalCase; rep: number }): Promise<void> {
  attempted += 1;
  const key = `${kase.id}_rep${rep}`;
  try {
    const run = await runCase(env, kase, MODEL, {
      timeoutMs: CASE_TIMEOUT_MS,
      reasoningEffort: plan.effort,
    });
    const { turn } = run;

    if (!turn.text.trim()) {
      // An empty answer is a real failure of this flow and is scored as one —
      // it is exactly what the budget fallback in `loop.ts` exists to prevent,
      // so it must reach the results file rather than the error sidecar.
      appendFileSync(
        errorsPath,
        JSON.stringify({
          prompt_id: kase.id,
          rep,
          failure: "empty_answer",
          model: MODEL,
          steps: turn.steps.length,
        }) + "\n",
      );
    }

    const usage = {
      input_tokens: (turn.usage.promptTokens ?? 0) - (turn.usage.cachedTokens ?? 0),
      output_tokens: turn.usage.completionTokens ?? 0,
      cache_read_input_tokens: turn.usage.cachedTokens ?? 0,
      cache_creation_input_tokens: turn.usage.cacheWriteTokens ?? 0,
    };

    let grade: Record<string, number> = {};
    let explanation: Record<string, string> | undefined;
    let judgeModel: string | undefined;
    let judgeUsage: Verdict["usage"] | undefined;

    if (plan.freeze) {
      writeFileSync(
        join(freezeDir, `${kase.id}.json`),
        JSON.stringify({ text: turn.text, trajectory: turn.steps.map((s) => s.tool) }, null, 2),
      );
      // The reference cannot win against itself, and a missing primary metric
      // on the baseline rows breaks every comparison built on them. 0.5 is the
      // neutral value: it says "no comparison was made", not "it drew".
      grade = { win: 0.5, steps: turn.steps.length };
    } else if (shouldJudge) {
      const refPath = join(refDir, `${kase.id}.json`);
      if (!existsSync(refPath)) throw new Error(`no frozen reference for ${kase.id}`);
      const ref = JSON.parse(readFileSync(refPath, "utf8")) as {
        text: string;
        trajectory: string[];
      };
      const verdict = await judgePair(env, {
        kase,
        reference: ref.text,
        referenceTrajectory: ref.trajectory,
        candidate: turn.text,
        candidateTrajectory: turn.steps.map((s) => s.tool),
        judgeModel: JUDGE_MODEL,
        candidateIsA: Math.random() < 0.5,
      });
      grade = { win: verdict.win, steps: turn.steps.length };
      explanation = { win: `${verdict.choice}: ${verdict.reasoning}` };
      judgeModel = verdict.model;
      judgeUsage = verdict.usage;
    } else {
      grade = { win: 0.5, steps: turn.steps.length };
    }

    const row: Row = {
      prompt_id: kase.id,
      rep,
      prompt: kase.question,
      tags: kase.tags,
      model: MODEL,
      effort: plan.effort,
      status: turn.finishReason === "length" ? "truncated" : "ok",
      stop_reason: turn.finishReason,
      grade,
      ...(explanation ? { explanation } : {}),
      latency_s: Number(run.latencyS.toFixed(2)),
      tool_calls: turn.steps.length,
      usage,
      ...(judgeModel ? { judge_model: judgeModel } : {}),
      ...(judgeUsage ? { judge_usage: judgeUsage } : {}),
      meta: {
        real_steps: kase.realSteps,
        step_delta: turn.steps.length - kase.realSteps,
        trajectory: turn.steps.map((s) => s.tool).join(" → "),
        passes: turn.passes.length,
        // A call the fixture had no canned answer for. Not an error — the real
        // tools say "nothing found" too — but a case where it happens a lot is
        // a case whose fixture has stopped describing the turn.
        unreplayed: run.toolCalls.filter((c) => !c.replayed).length,
        answer_chars: turn.text.length,
      },
    };

    appendFileSync(resultsPath, JSON.stringify(row) + "\n");
    writeFileSync(join(tracesDir, `${key}.json`), JSON.stringify(toTrace(run), null, 2));

    spend +=
      estimateCostUsd(
        MODEL,
        turn.usage.promptTokens ?? 0,
        turn.usage.completionTokens ?? 0,
        turn.usage.cachedTokens ?? 0,
        turn.usage.cacheWriteTokens ?? 0,
      ) +
      (judgeUsage && judgeModel
        ? estimateCostUsd(judgeModel, judgeUsage.input_tokens, judgeUsage.output_tokens)
        : 0);

    ran += 1;
    const w = grade.win;
    process.stdout.write(
      `  ${key.padEnd(28)} ${String(turn.steps.length).padStart(2)} steps  ` +
        `${String(totalTokens(turn.usage)).padStart(7)} tok  ` +
        `${shouldJudge ? (w === 1 ? "win " : w === 0 ? "loss" : "tie ") : "    "}  ` +
        `${turn.text.trim() ? "" : "EMPTY ANSWER"}\n`,
    );
  } catch (err) {
    // A harness failure never occupies the (case, rep) slot in results.jsonl —
    // a row there would make resume skip it forever and would score plumbing
    // as a model failure.
    appendFileSync(
      errorsPath,
      JSON.stringify({
        prompt_id: kase.id,
        rep,
        failure: err instanceof Error && err.name === "TimeoutError" ? "timeout" : "harness",
        message: err instanceof Error ? err.message : String(err),
      }) + "\n",
    );
    process.stdout.write(`  ${key.padEnd(28)} FAILED  ${String(err)}\n`);
    // An account error is not this case's problem and the next case will not
    // fix it. Set once; the workers below check it before pulling more work,
    // so the four in flight finish and nothing new starts.
    if (isAccountError(err)) abandoned ??= err instanceof Error ? err.message : String(err);
  }
}

console.log("");
const queue = [...todo];
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      if (abandoned) return;
      const next = queue.shift();
      if (!next) return;
      await one(next);
    }
  }),
);

console.log(`\n${ran}/${todo.length} completed.  Estimated spend this run: $${spend.toFixed(3)}`);
if (abandoned) {
  // Loud, and before the paths. A run that stopped at case two of eighteen
  // otherwise reads as a run of two cases, and the next thing somebody does is
  // compare a win rate over the wrong denominator.
  console.log(`\nAbandoned after an account error: ${abandoned}`);
  console.log(
    `${attempted - ran} attempted and failed, ${todo.length - attempted} never attempted.`,
  );
}
if (shouldJudge) summarise();
console.log(`Results: ${resultsPath}`);
// `ran > 0` for the same reason: a freeze where every case failed has
// produced no answers, and stamping a record over the previous run's would
// describe a reference that is not there.
if (plan.freeze && ran > 0) {
  writeProvenance();
  console.log(`Frozen reference: ${freezeDir}`);
}

/**
 * The four numbers a judged run is read for, so nobody has to derive them.
 *
 * Derived by hand the first time this eval scored a change, and the counts
 * that mattered most were the ones the judge does not produce: steps against
 * the reference's, and the failures that are not a matter of opinion. An
 * answer that came back empty or stopped at the token ceiling is a regression
 * whatever a grader thinks of its prose, and a run whose win rate looks fine
 * while two cases returned nothing has not passed.
 *
 * Read back from `results.jsonl` rather than accumulated in memory, because a
 * run is resumable and the totals belong to the variant, not to the last
 * invocation of it.
 */
function summarise(): void {
  if (!existsSync(resultsPath)) return;
  const rows: Row[] = [];
  for (const line of readFileSync(resultsPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as Row);
    } catch {
      // Same torn-last-line case the resume set tolerates.
    }
  }
  if (rows.length === 0) return;

  let win = 0;
  let loss = 0;
  let tie = 0;
  let steps = 0;
  let refSteps = 0;
  let missingRef = 0;
  const empty: string[] = [];
  const truncated: string[] = [];

  for (const row of rows) {
    const w = row.grade.win;
    if (w === 1) win += 1;
    else if (w === 0) loss += 1;
    else tie += 1;
    steps += row.tool_calls;
    const refPath = join(refDir, `${row.prompt_id}.json`);
    if (existsSync(refPath)) {
      const ref = JSON.parse(readFileSync(refPath, "utf8")) as { trajectory: string[] };
      refSteps += ref.trajectory.length;
    } else {
      missingRef += 1;
    }
    if (row.meta.answer_chars === 0) empty.push(row.prompt_id);
    if (row.status === "truncated") truncated.push(row.prompt_id);
  }

  const delta = refSteps === 0 ? 0 : Math.round(((steps - refSteps) / refSteps) * 100);
  console.log(
    [
      "",
      `${win} win / ${tie} tie / ${loss} loss   over ${rows.length} judged case(s)`,
      `steps ${refSteps} -> ${steps}  (${delta >= 0 ? "+" : ""}${delta}%)` +
        (missingRef > 0 ? `  — ${missingRef} case(s) had no reference to compare against` : ""),
      // Not a matter of opinion, and the judge is not asked about them.
      `empty answers ${empty.length}${empty.length ? `: ${empty.join(", ")}` : ""}`,
      `hit the token ceiling ${truncated.length}${truncated.length ? `: ${truncated.join(", ")}` : ""}`,
      "",
      // The set resolves a gross regression and nothing finer. Printed with the
      // result rather than left in the README, where it is read once.
      "Calibrated as a tripwire: ~19-point standard error over eighteen cases,",
      "so read this for broken turns, not for a few points either way.",
    ].join("\n"),
  );
}

/**
 * What produced the fixture, written beside it.
 *
 * `ref/` is committed and `results.jsonl` is not, so without this the one part
 * of a run that survives into the repository is the one part that says nothing
 * about where it came from. The question it answers is not hypothetical: these
 * answers were frozen while the branch sat behind `main`, and settling whether
 * that mattered meant diffing four files by hand to find out which tools the
 * model had been offered. A reviewer a month from now would have to repeat
 * that, with less to go on.
 *
 * It records the commit rather than the diff, and says plainly when the tree
 * was dirty: a sha plus uncommitted edits does not identify the code that ran,
 * and claiming it does would be worse than admitting it does not.
 *
 * No spend figure, on purpose. A run is resumable, so the counter in memory is
 * this invocation's cost and not the freeze's — a reference assembled over two
 * invocations would record the second one's bill, and a reference re-emitted
 * after a complete run would record $0.000. Cost belongs in `results.jsonl`,
 * which holds every row; provenance is what produced the answers, not what
 * they cost.
 */
function writeProvenance(): void {
  const sh = (args: string[]): string => {
    try {
      return execFileSync(args[0], args.slice(1), { cwd: HERE, encoding: "utf-8" }).trim();
    } catch {
      return "";
    }
  };
  const sha = sh(["git", "rev-parse", "HEAD"]) || "unknown";
  const dirty = sh(["git", "status", "--porcelain"]) !== "";
  // From disk rather than from `todo`, because provenance describes the
  // fixture and not the invocation: a resumed run's queue is short, and a
  // re-emit after a complete run has an empty one. Either would report a
  // reference far smaller than the one sitting next to the file.
  const frozen = readdirSync(freezeDir)
    .filter((f) => f.endsWith(".json") && f !== "CONFIG.json")
    .map((f) => f.slice(0, -".json".length))
    .sort();
  const partial = frozen.length < CASES.length;
  // The same two facts a judged run has to print, in a form it can read. A
  // reference that cannot say what produced it can be compared against
  // anything, and the mistake looks exactly like a result.
  writeFileSync(
    join(freezeDir, "CONFIG.json"),
    JSON.stringify({ model: MODEL, effort: plan.effort }, null, 2) + "\n",
  );
  writeFileSync(
    join(freezeDir, "PROVENANCE.md"),
    [
      "# What generated this reference",
      "",
      "Written by `eval/run.ts --variant baseline`. Do not edit by hand.",
      "",
      `- **Date** ${new Date().toISOString()}` +
        " — when this record was written; a reference assembled over more than one" +
        " invocation records the last one to add to it",
      `- **Commit** \`${sha}\`` +
        (dirty
          ? " — **with uncommitted changes in the tree**, so this sha does not fully identify the code that ran"
          : ""),
      `- **Model** \`${MODEL}\``,
      `- **Reasoning effort** ` +
        (plan.effort === null
          ? "none sent — the provider's own default, which is what production sends"
          : `\`${plan.effort}\``),
      `- **Reps** ${REPS}`,
      `- **Cases** ${frozen.length} of ${CASES.length}` +
        (partial ? " — a partial freeze; every case not listed below has no reference at all" : ""),
      "",
      "Frozen:",
      "",
      ...frozen.map((id) => `- \`${id}\``),
      "",
    ].join("\n"),
  );
}

type Verdict = Awaited<ReturnType<typeof judgePair>>;
