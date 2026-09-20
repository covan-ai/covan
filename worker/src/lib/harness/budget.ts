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
 * Eight rather than three because a real question genuinely takes several:
 * describe the connection, query it, query it again having seen the schema,
 * then answer. Eight rather than twenty because the failure mode of a loop
 * that is too generous is not a slow answer, it is a bill — and a model that
 * has not finished in eight steps is usually repeating itself rather than
 * making progress.
 *
 * Counted in tool executions, not in round trips: a pass that asks for three
 * tools at once spends three.
 */
export const MAX_STEPS = 8;

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
