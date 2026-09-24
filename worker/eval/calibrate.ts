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
import { loadEnv, requireAnthropicKey } from "./env";

const MODEL = process.env.EVAL_MODEL ?? "claude-sonnet-5";
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? "claude-opus-5";

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
requireAnthropicKey(env);

console.log(`${selected.length} case(s), model ${MODEL}, judge ${JUDGE_MODEL}\n`);

let spend = 0;
let separated = 0;
let tied = 0;

for (const kase of selected) {
  // Two samples from the same unchanged system. Sequential rather than
  // concurrent so the two are as alike as the provider will make them.
  const first = await runCase(env, kase, MODEL, { timeoutMs: 180_000 });
  const second = await runCase(env, kase, MODEL, { timeoutMs: 180_000 });
  for (const r of [first, second]) {
    spend += estimateCostUsd(
      MODEL,
      r.turn.usage.promptTokens ?? 0,
      r.turn.usage.completionTokens ?? 0,
      r.turn.usage.cachedTokens ?? 0,
      r.turn.usage.cacheWriteTokens ?? 0,
    );
  }

  const separation = await judgePair(env, {
    kase,
    reference: kase.spoiled!,
    candidate: first.turn.text,
    judgeModel: JUDGE_MODEL,
    candidateIsA: Math.random() < 0.5,
  });
  const noise = await judgePair(env, {
    kase,
    reference: first.turn.text,
    candidate: second.turn.text,
    judgeModel: JUDGE_MODEL,
    candidateIsA: Math.random() < 0.5,
  });
  for (const v of [separation, noise]) {
    spend += estimateCostUsd(v.model, v.usage.input_tokens, v.usage.output_tokens);
  }

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

console.log(
  [
    `separation   ${separated}/${selected.length} — the real answer beat the spoiled one`,
    `tie rate     ${tied}/${selected.length} — same system judged against itself`,
    `spend        $${spend.toFixed(3)}`,
  ].join("\n"),
);
console.log(
  "\nSeparation below full marks means the rubric is not naming what makes the bad\n" +
    "answer bad. A low tie rate means the judge is inventing preferences, and every\n" +
    "later win rate carries that as noise — read it before reading any result.",
);
