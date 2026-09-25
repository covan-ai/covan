import type { RoutineEnv } from "../../types";
import { planLimits } from "../limits";

/**
 * What one agent turn is allowed to spend, and why each number is the number.
 *
 * A tool loop has no natural end. The model decides whether to call something
 * again, and "again" is a decision it can make forever — so every one of these
 * is a stop that does not depend on the model agreeing to stop.
 */

/**
 * How many tools one turn may run in total, across every pass.
 *
 * Eight was right when a turn meant describe, query, query again, answer, and
 * connected applications strained it: finding an operation costs a step before
 * running one costs another, so the first real question — "list my last five
 * meetings" — used seven of eight.
 *
 * **It was raised to sixteen on 2026-09-24 and put back the same evening,
 * because sixteen does not fit on this runtime.** That is the number worth
 * keeping, so the next person does not repeat it.
 *
 * WHY IT DOES NOT FIT. Workers Free allows **fifty subrequests per
 * invocation**, and on this Worker a database read, a model call and a
 * connected-app call are each one. A chat turn spends roughly ten before the
 * loop starts (session, agent, history, retrieval, quota, the tool list), one
 * per pass, several per tool call, and a handful persisting the reply. At
 * eight steps that lands under the cap; at sixteen it does not, and what the
 * person sees is "The assistant hit an error."
 *
 * The failure is also disguised, which is why this comment is long. Once the
 * cap is hit every `fetch` fails, and the OpenAI SDK reports any failed fetch
 * as `Connection error.` — so the log says the network broke when what broke
 * was the budget. `lib/routines/dispatcher.ts` does this arithmetic for the
 * cron Worker and always has; nothing was doing it for this one.
 *
 * The other half of the argument, unchanged and still true: each step's result
 * joins the transcript and is re-sent on every later pass, so cost grows with
 * roughly the SQUARE of this number. Read `MAX_TOOL_OUTPUT_CHARS` below before
 * raising either.
 *
 * TO RAISE IT, one of two things has to happen first — not a guess, which is
 * how it went wrong: Workers Paid (the cap becomes 1000), or the Worker
 * counting its own subrequests so the loop can stop honestly instead of
 * failing at a ceiling nothing reports.
 *
 * Counted in tool executions, not in round trips: a pass that asks for three
 * tools at once spends three.
 */
export const MAX_STEPS = 8;

/**
 * The same budget, asked of the deployment rather than read off the constant.
 *
 * `MAX_STEPS` above is the Free number and stays the Free number — see
 * `lib/limits.ts` for why raising it flat would break every self-hosted deploy
 * silently. This is what a chat route passes so that a deployment with the
 * headroom can be given more of it without the open build moving at all.
 *
 * Both chat routes go through it, and that is the point of it existing rather
 * than each route reading a constant: **neither route passes a budget today**,
 * so both fall through to the same default and agree by accident. The moment
 * one of them passes one they diverge in silence, and the one that would
 * diverge is the resume — a turn that paused at step seven and came back with
 * the bare default.
 */
export function chatBudget(env: Pick<RoutineEnv, "WORKER_PLAN">): { maxSteps: number } {
  return { maxSteps: planLimits(env).chat.maxSteps };
}

/**
 * The same budget for a run nobody is watching, and its own reason for it.
 *
 * It equals `MAX_STEPS` again now that chat is back at eight, and it is still
 * a separate constant on purpose: the two arrived at the same number by
 * different routes, and only one of them can ever move. A scheduled run
 * shares its fifty subrequests with the whole batch — `dispatcher.ts` sizes
 * `BATCH_SIZE` on exactly that, at 2 + 3 x 12 = 38 — so even on Workers Paid,
 * where chat could take far more, this one still cannot follow it up without
 * that arithmetic being redone.
 *
 * It is also the cheaper half of the argument. Nobody is reading a scheduled
 * run as it happens, so a run that stops short and says what it could not
 * finish costs somebody a look in the morning; a run that spends several
 * times the tokens costs money every night.
 */
export const SCHEDULED_MAX_STEPS = 8;

/**
 * How long one tool may take before the turn gives up on it.
 *
 * Matched to `DELIVERY_TIMEOUT_MS` and the source fetch timeout rather than
 * chosen freshly — everything in this codebase that reaches outside gets ten
 * seconds, and two tools here reach outside through exactly those code paths.
 * Doubled, because a database query behind PostgREST is a slower thing than
 * fetching a feed and the target's own `statement_timeout` is the real stop.
 */
export const TOOL_TIMEOUT_MS = 20_000;

/**
 * How much of a tool's answer the model is shown.
 *
 * A query that returns ten thousand rows is not more useful to the model than
 * one that returns forty, and it costs input tokens on every remaining pass of
 * the turn — the transcript grows with each step, so an unbounded result is
 * paid for again and again. The tool says it was trimmed, so the model can ask
 * a narrower question rather than assume it saw everything.
 *
 * **Raised from 8,000 on 2026-09-25, and this time with both arguments.**
 * (`MAX_STEPS` above was moved that week on a cost argument alone, with no
 * runtime argument beside it, and had to be put straight back.)
 *
 * WHAT IT COSTS. A result produced at step k is re-sent on every later pass,
 * so the worst case is a full-size result at step 0 carried through all eight
 * — 12,000 characters is roughly 3,000 tokens, so about 24,000 tokens of
 * re-sent transcript. Measured against a real turn: "list my last five
 * meetings" charged 42,486 tokens in total, against a monthly allowance of a
 * million. The headroom is there.
 *
 * WHAT IT RISKS AT RUNTIME. Nothing new. It is the same single `fetch`, so it
 * spends no extra subrequest — which is the ceiling that actually binds this
 * Worker. Eight steps at this size is ~24,000 tokens of tool results inside a
 * context window of 128,000, so it cannot crowd the transcript out either.
 *
 * WHY IT WAS WORTH MOVING. Measured, not guessed: the same turn asked for a
 * week of calendar events with a `fields` list already narrowing the response
 * — following `run_tool`'s own advice — and still came back at 8,053
 * characters, trimmed. The agent then told the person it could not be sure it
 * had seen everything. A cap that truncates a correctly-narrowed request is
 * costing correctness rather than saving money.
 */
export const MAX_TOOL_OUTPUT_CHARS = 12_000;

/**
 * How much of it is kept in `message_steps.result_excerpt`.
 *
 * Smaller than what the model sees, deliberately. The row exists so a person
 * can tell what the agent actually did, which needs the shape of the answer
 * and not the whole of it — and these rows are read back by the transcript
 * query on every message load.
 */
export const MAX_STEP_EXCERPT_CHARS = 2_000;

/** Trim to `max`, saying so, so nothing downstream mistakes a cut for the end. */
export function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[trimmed: ${text.length} characters, showing the first ${max}]`;
}
