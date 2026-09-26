/**
 * What a run is, resolved from its flags before anything is spent.
 *
 * This lives apart from `run.ts` because `run.ts` is a script: it reads argv,
 * makes directories and starts buying answers at import time, so nothing in it
 * can be reached by a test. The rules below are the ones that fail silently
 * and expensively, which is why they are here instead:
 *
 * - An effort the model cannot act on. `--effort low` against `gpt-4o` is
 *   accepted by the request builder and dropped on the floor; the run costs
 *   full price and produces a "variant" identical to the thing it was meant to
 *   differ from. Its 50% win rate would then be read as evidence that effort
 *   does not matter.
 * - A freeze over a reference that already exists. `ref/` is the only part of
 *   a run that is committed, and `results.jsonl` — the file resume reads — is
 *   not. So in a fresh clone the resume set is empty and the first
 *   `--variant baseline` silently overwrites the reviewed fixture every
 *   published number was measured against. The README has always said not to
 *   do that. Nothing stopped it.
 */
import {
  modelSpec,
  reasonsBeforeAnswering,
  REASONING_EFFORTS,
  type ReasoningEffort,
} from "../src/lib/models";

export class EvalConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalConfigError";
  }
}

export type RunFlags = {
  variant: string;
  model: string;
  /** Absent and `"medium"` are different requests — see `REASONING_EFFORTS`. */
  effort?: string | null;
  /** The variant whose `ref/` this run is judged against. */
  against?: string | null;
  freeze?: boolean;
  refreeze?: boolean;
  judge?: boolean;
};

export type RunPlan = {
  variant: string;
  model: string;
  /** `null` means send no effort at all, which is what production sends. */
  effort: ReasoningEffort | null;
  against: string;
  freeze: boolean;
  refreeze: boolean;
  judge: boolean;
  /** Printed before the run: things the operator should know, not errors. */
  warnings: string[];
};

/**
 * How a configuration reads in a header or in a provenance file.
 *
 * Takes a plain string because one caller reads the effort back out of a JSON
 * file written by an earlier run, where it is whatever that run wrote.
 */
export function describeConfig(model: string, effort: string | null): string {
  return `${model}, effort ${effort ?? "unset (provider default)"}`;
}

export function resolvePlan(flags: RunFlags): RunPlan {
  const warnings: string[] = [];
  const variant = flags.variant.trim();
  if (!variant) throw new EvalConfigError("--variant needs a name.");

  const effort = resolveEffort(flags.model, flags.effort, warnings);

  // `baseline` freezes by its name, because it did so before there was a flag
  // and the README, the gitignore and every committed path say `baseline`.
  const freeze = flags.freeze === true || variant === "baseline";

  // A freeze has nothing to be judged against: it *is* the opponent. That was
  // already true of `baseline` and stays true of every later reference.
  const judge = flags.judge === true && !freeze;
  if (flags.judge === true && freeze) {
    warnings.push(
      `--judge ignored: ${variant} writes a reference, so there is nothing to judge it against.`,
    );
  }

  const against = (flags.against ?? "baseline").trim();
  if (judge && against === variant) {
    throw new EvalConfigError(
      `--against ${against} is this run's own variant, so every case would be judged against itself.`,
    );
  }

  return {
    variant,
    model: flags.model,
    effort,
    against,
    freeze,
    refreeze: flags.refreeze === true,
    judge,
    warnings,
  };
}

function resolveEffort(
  model: string,
  raw: string | null | undefined,
  warnings: string[],
): ReasoningEffort | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  const effort = raw.trim();
  if (!(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new EvalConfigError(`--effort ${effort} is not one of ${REASONING_EFFORTS.join(", ")}.`);
  }
  if (modelSpec(model) === undefined) {
    // Unknown ids are legitimate: under `OPENAI_BASE_URL` every id is unknown
    // to the table. We cannot tell whether this one reasons, so the run goes
    // ahead and says so rather than refusing work on no grounds.
    warnings.push(
      `${model} is not in the model table, so whether it acts on --effort ${effort} is unknown.`,
    );
  } else if (!reasonsBeforeAnswering(model)) {
    throw new EvalConfigError(
      `${model} does not reason, so --effort ${effort} would be dropped and this variant ` +
        `would be identical to the reference it is measured against.`,
    );
  }
  return effort as ReasoningEffort;
}

/**
 * Cases whose frozen reference this run is about to overwrite.
 *
 * Takes ids rather than reading the directory, because the one subtlety
 * belongs to the caller: only cases this invocation is about to *run* count. A
 * resumed freeze legitimately finds every earlier case's file already on disk,
 * and those are not in its queue.
 */
export function refsAtRisk(queuedIds: readonly string[], frozenIds: readonly string[]): string[] {
  const frozen = new Set(frozenIds);
  return [...new Set(queuedIds)].filter((id) => frozen.has(id)).sort();
}
