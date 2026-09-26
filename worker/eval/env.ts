import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompletionEnv } from "../src/lib/completion";
import { providerFor } from "../src/lib/models";

/**
 * The keys, from the environment or from `.dev.vars`.
 *
 * `.dev.vars` is where this repository already keeps local secrets — it is
 * gitignored, `.dev.vars.example` documents it, and it is what `wrangler dev`
 * reads. Reading it here means the eval is set up the same way running the
 * Worker locally is, rather than needing a second arrangement that exists only
 * for this script and that somebody has to be told about.
 *
 * The environment still wins, so a one-off run against a different key is
 * `ANTHROPIC_API_KEY=… bun eval/run.ts` with nothing to undo afterwards.
 */
export function loadEnv(): CompletionEnv {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = join(here, "..", ".dev.vars");
  const fromFile: Record<string, string> = {};

  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      // Values are taken raw apart from surrounding quotes. `.dev.vars` is not
      // a shell script and wrangler does not expand anything in it, so neither
      // does this — a key containing a `$` must survive.
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (value) fromFile[key] = value;
    }
  }

  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? fromFile.OPENAI_API_KEY ?? "",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? fromFile.ANTHROPIC_API_KEY ?? "",
  };
}

/**
 * Whether an error is about the account rather than about the case.
 *
 * A credit balance, a revoked key, a permission: none of them gets better on
 * the next case, so a run that meets one should stop rather than walk the same
 * wall once per case. `calibrate.ts` learnt this on a credit balance and
 * `run.ts` learnt it again on a rotated key — ten cases, ten identical 401s,
 * and a variant directory half-populated with failures.
 *
 * Matched on the provider's own wording rather than on a status code, because
 * a 400 covers both this and a malformed request, and only one of the two is
 * worth abandoning the run over.
 */
export function isAccountError(err: unknown): boolean {
  const text = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    text.includes("credit balance is too low") ||
    text.includes("authentication_error") ||
    text.includes("permission_error") ||
    text.includes("invalid x-api-key")
  );
}

/**
 * Stop before spending anything if a key some model in this run needs is absent.
 *
 * Not "the Anthropic key", which is what this checked when every case was a
 * Claude case and the judge was the only other model. A run now names its own
 * model — `EVAL_MODEL=gpt-5` is the whole point of an effort variant — so the
 * keys a run needs are a property of the run, and checking the wrong one both
 * refuses work that would have succeeded and lets a run start that cannot.
 *
 * Every model is asked for at once so a missing pair is one message rather
 * than two runs.
 */
export function requireKeysFor(env: CompletionEnv, models: readonly string[]): void {
  const needed = new Map<string, string[]>();
  for (const model of models) {
    const provider = providerFor(model);
    const key = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
    if (env[key as keyof CompletionEnv]) continue;
    const already = needed.get(key) ?? [];
    if (!already.includes(model)) already.push(model);
    needed.set(key, already);
  }
  if (needed.size === 0) return;

  const lines = ["Missing API keys for the models this run uses:", ""];
  for (const [key, users] of needed) lines.push(`  ${key}   needed by ${users.join(", ")}`);
  lines.push(
    "",
    "Either export them, or add a line each to worker/.dev.vars (gitignored):",
    "",
    ...[...needed.keys()].map(
      (k) => `    ${k}=${k === "ANTHROPIC_API_KEY" ? "sk-ant-..." : "sk-..."}`,
    ),
  );
  console.error(lines.join("\n"));
  process.exit(1);
}
