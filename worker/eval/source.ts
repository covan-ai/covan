import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CASES as PUBLIC_CASES, type EvalCase } from "./cases";

/**
 * Which cases a run reads, and where what it writes goes.
 *
 * WHY THERE ARE TWO SOURCES. `cases.ts` is synthetic on purpose: this
 * repository is public, and the turns those cases were rewritten from carried
 * a customer list, a named colleague and a strategy note. That makes the set
 * good at "did this change break turns" and blind to "does it work on what a
 * real team asks" — and the second question is the one a deployment learns
 * from its own pilots. Those cases are made of people's data, so they cannot
 * live here, and neither can anything a run writes about them: a frozen
 * answer is a model's summary of somebody's documents.
 *
 * So `EVAL_CASES` names a module anywhere else that exports `CASES` in the
 * same shape, and a run that uses one writes beside that module rather than
 * into `.claude/hillclimb/`, whose `ref/` directories are tracked in this
 * repository. A path inside this repository is refused, because the mistake
 * this exists to prevent is precisely real data arriving in a public tree.
 * `EVAL_OUT` moves the results anywhere else outside it.
 */

const HERE = dirname(new URL(import.meta.url).pathname);
/** The repository root: `worker/eval/` is two levels down. */
export const REPO_ROOT = resolve(HERE, "..", "..");
const PUBLIC_OUT = join(REPO_ROOT, ".claude", "hillclimb", "agent-turn");

export class EvalSourceError extends Error {}

/** Whether `path` is this repository or anything inside it, links resolved. */
export function insideRepo(path: string, root = REPO_ROOT): boolean {
  const real = (p: string) => (existsSync(p) ? realpathSync(p) : resolve(p));
  const rel = relative(real(root), real(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Ids that are unique and non-empty, which is all the runner keys on. */
export function checkCases(cases: unknown, from: string): EvalCase[] {
  if (!Array.isArray(cases) || cases.length === 0) {
    throw new EvalSourceError(`${from} must export a non-empty CASES array`);
  }
  const seen = new Set<string>();
  for (const c of cases as EvalCase[]) {
    if (!c || typeof c.id !== "string" || !c.id) {
      throw new EvalSourceError(`${from}: every case needs an id`);
    }
    if (seen.has(c.id)) throw new EvalSourceError(`${from}: case id ${c.id} appears twice`);
    seen.add(c.id);
  }
  return cases as EvalCase[];
}

export async function loadCases(
  env: { EVAL_CASES?: string; EVAL_OUT?: string } = process.env,
): Promise<{ cases: EvalCase[]; out: string; external: boolean }> {
  const named = env.EVAL_CASES?.trim();
  if (!named) {
    if (env.EVAL_OUT?.trim()) {
      throw new EvalSourceError("EVAL_OUT is for EVAL_CASES; the public cases write to .claude/");
    }
    return { cases: PUBLIC_CASES, out: PUBLIC_OUT, external: false };
  }

  const path = resolve(named);
  if (!existsSync(path)) throw new EvalSourceError(`EVAL_CASES: no file at ${path}`);
  if (insideRepo(path)) {
    throw new EvalSourceError(
      `EVAL_CASES points inside this repository (${path}). Cases made from real ` +
        "data live outside it — see worker/eval/README.md.",
    );
  }
  const out = resolve(env.EVAL_OUT?.trim() || join(dirname(path), ".results", "agent-turn"));
  if (insideRepo(out)) {
    throw new EvalSourceError(`EVAL_OUT points inside this repository (${out}).`);
  }
  const mod = (await import(pathToFileURL(path).href)) as { CASES?: unknown };
  return { cases: checkCases(mod.CASES, path), out, external: true };
}
