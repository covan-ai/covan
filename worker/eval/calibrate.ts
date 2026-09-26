/**
 * Check the judge before trusting it.
 *
 *   bun eval/calibrate.ts            # every case carrying a spoiled answer
 *   bun eval/calibrate.ts --only db- # a subset
 *
 * A rubric is prose handed to a model, so it cannot be unit-tested the usual
 * way. What can be tested is whether the judge behaves correctly on two pairs
 * whose answer is known in advance, and this runs both:
 *
 * **Separation.** The real answer against the hand-written spoiled one. The
 * real answer must win. A judge that cannot separate an answer with invented
 * figures from one without has no business grading the pairs where the
 * difference is subtle — which is every pair that matters.
 *
 * **Noise.** The same system sampled twice, judged against itself. It should
 * mostly tie. Every win here is the judge inventing a preference between two
 * answers from one unchanged system, and that rate is the floor under every
 * later number: a change that moves the win rate by less than this has not
 * been measured, it has been sampled.
 *
 * The second is the one worth running before Phase 1 is judged at all, because
 * Phase 1 claims to be output-neutral — a judge that ties reliably is what
 * makes that claim checkable, and a judge that does not would report a win or
 * a loss either way.
 *
 * Costs about $0.40 for six cases. It calls the model twice per case and the
 * judge twice per case.
 */
import { CASES } from "./cases";
import { runCase } from "./harness";
import { judgePair } from "./judge";
import { estimateCostUsd } from "../src/lib/pricing";
import { loadEnv, requireKeysFor, isAccountError } from "./env";

const MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-5";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "claude-opus-5";
/**
 * The per-case ceiling, five minutes rather than three.
 *
 * Three was measured against nothing and an eight-step turn went past it: each
 * pass re-sends a transcript that has grown by the last tool's output, so the
 * last pass of a long turn is the slowest one, and the turns that take eight
 * steps are exactly the turns this eval is for. A ceiling that fires on the
 * cases that matter most is worse than no ceiling.
 */
const CASE_TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS ?? 300_000);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const only = arg("only")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const selected = CASES.filter((c) => c.spoiled && (!only || only.some((p) => c.id.startsWith(p))));

const env = loadEnv();
requireKeysFor(env, [MODEL, JUDGE_MODEL]);

console.log(`${selected.length} case(s), model ${MODEL}, judge ${JUDGE_MODEL}\n`);

let spend = 0;
let separated = 0;
let tied = 0;

/*
 * `isAccountError` used to live here. It moved to `env.ts` when `run.ts` needed
 * the same test — see the comment there, which is this one.
 *
 * The original note, kept because it is the reason the function exists:
 *
 * These do not come right on the next case, and walking the whole set to
 * discover that is both slow and — on a key that is rate-limited rather than
 * empty — a way to spend money on requests that were always going to fail.
 * The first calibration run after the key was replaced hit "credit balance is
 * too low" six times in a row and printed a summary reading `0/0`, which is
 * the shape of a result without being one.
 *
 * Matched on the provider's own wording rather than on a status code, because
 * a 400 covers both this and a malformed request, and only one of the two is
 * worth abandoning the run over.
 */

let failed = 0;
let abandoned: string | null = null;
/**
 * Cases that produced two verdicts, counted rather than derived.
 *
 * It was `selected.length - failed`, which is right only when every case is
 * attempted. Abandoning the run early breaks that: the cases after the break
 * were neither scored nor failed, and the subtraction quietly counted them as
 * scored — a run that stopped on its first case reported `0/5`, which reads as
 * five judged pairs the real answer lost.
 */
let scored = 0;

for (const kase of selected) {
  try {
    await one(kase);
  } catch (err) {
    // One case that times out or errors must not take the run with it. The
    // cases already done cost real money and their verdicts are the output;
    // losing them to the ninth case's wall clock is the expensive way to find
    // out the ceiling was too low.
    failed += 1;
    console.log(`── ${kase.id}`);
    console.log(`   FAILED  ${err instanceof Error ? err.message : String(err)}\n`);
    if (isAccountError(err)) {
      abandoned = err instanceof Error ? err.message : String(err);
      break;
    }
  }
}

async function one(kase: (typeof selected)[number]): Promise<void> {
  // Two samples from the same unchanged system. Sequential rather than
  // concurrent so the two are as alike as the provider will make them.
  const first = await runCase(env, kase, MODEL, { timeoutMs: CASE_TIMEOUT_MS });
  const second = await runCase(env, kase, MODEL, { timeoutMs: CASE_TIMEOUT_MS });
  for (const r of [first, second]) {
    spend += estimateCostUsd(
      MODEL,
      r.turn.usage.promptTokens ?? 0,
      r.turn.usage.completionTokens ?? 0,
      r.turn.usage.cachedTokens ?? 0,
      r.turn.usage.cacheWriteTokens ?? 0,
    );
  }

  const firstSteps = first.turn.steps.map((s) => s.tool);
  const secondSteps = second.turn.steps.map((s) => s.tool);

  const separation = await judgePair(env, {
    kase,
    reference: kase.spoiled!,
    // The spoiled answer is handed the real turn's trajectory rather than an
    // empty one. It is hand-written and never ran anything, and an answer
    // shown with no tools beside one shown with five would tell the judge
    // which is which before it read a word — the blind would be gone and the
    // separation score would measure nothing.
    referenceTrajectory: firstSteps,
    candidate: first.turn.text,
    candidateTrajectory: firstSteps,
    judgeModel: JUDGE_MODEL,
    candidateIsA: Math.random() < 0.5,
  });
  const noise = await judgePair(env, {
    kase,
    reference: first.turn.text,
    referenceTrajectory: firstSteps,
    candidate: second.turn.text,
    candidateTrajectory: secondSteps,
    judgeModel: JUDGE_MODEL,
    candidateIsA: Math.random() < 0.5,
  });
  for (const v of [separation, noise]) {
    spend += estimateCostUsd(v.model, v.usage.input_tokens, v.usage.output_tokens);
  }

  scored += 1;
  if (separation.choice === "candidate") separated += 1;
  if (noise.choice === "tie" || noise.choice === "both_bad") tied += 1;

  console.log(`── ${kase.id}`);
  console.log(
    `   separation  ${separation.choice === "candidate" ? "PASS" : "FAIL"}  ` +
      `(judge chose: ${separation.choice})`,
  );
  console.log(`               ${separation.reasoning}`);
  console.log(
    `   same-vs-same ${noise.choice === "tie" || noise.choice === "both_bad" ? "tie " : "SPLIT"}  ` +
      `(judge chose: ${noise.choice})`,
  );
  console.log(`               ${noise.reasoning}`);
  console.log(
    `   steps ${first.turn.steps.length} / ${second.turn.steps.length}` +
      `   (the real turn took ${kase.realSteps})\n`,
  );
}

const skipped = selected.length - scored - failed;

if (scored === 0) {
  // No verdicts, so there is nothing to report and nothing to interpret.
  // Printing `separation 0/0` under the usual heading would put a number where
  // a measurement was supposed to be, and `0/0` reads like a failing score
  // rather than like an empty one.
  console.log(
    [
      `no verdicts — ${failed} case(s) errored and none was scored`,
      ...(skipped > 0 ? [`             ${skipped} case(s) were never attempted`] : []),
      `spend        $${spend.toFixed(3)}`,
      ...(abandoned ? ["", `Abandoned after an account error: ${abandoned}`] : []),
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  [
    `separation   ${separated}/${scored} — the real answer beat the spoiled one`,
    `tie rate     ${tied}/${scored} — same system judged against itself`,
    ...(failed > 0 ? [`failed       ${failed} case(s) errored and are not in either count`] : []),
    ...(skipped > 0 ? [`skipped      ${skipped} case(s) were never attempted`] : []),
    ...(abandoned ? [`abandoned    the run stopped early: ${abandoned}`] : []),
    `spend        $${spend.toFixed(3)}`,
  ].join("\n"),
);
console.log(
  "\nSeparation below full marks means the rubric is not naming what makes the bad\n" +
    "answer bad. A low tie rate means the judge is inventing preferences, and every\n" +
    "later win rate carries that as noise — read it before reading any result.",
);
if (abandoned) process.exit(1);
