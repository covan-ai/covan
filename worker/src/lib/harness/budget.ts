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
 * Eight was right when a turn meant describe, query, query again, answer.
 * Connected applications made it wrong: finding an operation costs a step
 * before running one costs another, so a question that touches two services
 * spends four steps before it has learned anything. The first real one —
 * "list my last five meetings" — used seven of eight, and the eighth would
 * have been the budget notice rather than the answer.
 *
 * Sixteen rather than thirty-two, because the failure mode of a generous loop
 * is not a slow answer, it is a bill. **And the bill is worse than it looks.**
 * Each step's result joins the transcript and is re-sent on every later pass,
 * so cost grows with roughly the SQUARE of this number, not with the number
 * itself. Doubling it does not double the ceiling — it roughly quadruples the
 * worst case. Read `MAX_TOOL_OUTPUT_CHARS` below as the other half of that
 * multiplication before raising either.
 *
 * Counted in tool executions, not in round trips: a pass that asks for three
 * tools at once spends three.
 */
export const MAX_STEPS = 16;

/**
 * The same budget for a run nobody is watching, and deliberately the old one.
 *
 * A scheduled run cannot be given the chat ceiling, for a reason that is not
 * taste: on the cron Worker every database read and every outbound call is a
 * subrequest, and Workers Free allows fifty per invocation.
 * `lib/routines/dispatcher.ts` does that arithmetic against `BATCH_SIZE`, and
 * a sixteen-step routine would break it three routines into a tick — failing
 * the last ones at the ceiling, recording them as failures, and backing them
 * off geometrically for a reason nothing in the run log would explain.
 *
 * It is also the cheaper half of the argument. Nobody is reading a scheduled
 * run as it happens, so a run that stops short and says what it could not
 * finish costs somebody a look in the morning; a run that spends four times
 * the tokens costs money every night.
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
 */
export const MAX_TOOL_OUTPUT_CHARS = 8_000;

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
