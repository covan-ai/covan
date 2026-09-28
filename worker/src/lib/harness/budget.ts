import type { RoutineEnv } from "../../types";
import { planLimits, type ChatLimits } from "../limits";

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
 * roughly the SQUARE of this number. Read `MAX_TOOL_OUTPUT_TOKENS` below before
 * raising either.
 *
 * **WHAT CHANGED, 2026-09-25.** The first of those two things happened: the
 * hosted deployment is on Workers Paid, where one invocation may make
 * **10,000** subrequests rather than fifty. (An earlier draft of this comment
 * said the Paid cap was 1,000. It is not, and the number mattered — 1,000
 * would have made a 24-step turn look like a quarter of the budget instead of
 * a fortieth.) A 24-step chat turn plans out at roughly 250 subrequests, so on
 * Paid this constant is simply no longer what the platform is asking about.
 * Paid also lifts the wall clock for as long as the client stays connected,
 * which is the other half of the licence: a long turn is now slow, not fatal.
 *
 * **It still does not move here.** Eight is the Workers FREE number and stays
 * it, because this file ships to self-hosters and `lib/background.ts` promises
 * their first deploy works without a plan upgrade. What the plan buys is spent
 * through `chatBudget` below, which asks the deployment which plan it is on.
 * Raising this line instead would keep covan.app working and break every
 * self-hosted deploy silently — in exactly the disguised way described above.
 *
 * The second thing on that list — the Worker counting its own subrequests — is
 * still worth building, and is now observability rather than a gate: at ~250
 * of 10,000, a second budget could only ever refuse turns that would have
 * finished.
 *
 * WHAT BINDS INSTEAD, on Paid: the context window. See `ChatLimits.extraLegs`
 * in `lib/limits.ts`, and read `MAX_TOOL_OUTPUT_TOKENS` below before raising
 * anything — it matters more now, not less.
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
 * than each route reading a constant: **neither route used to pass a budget at
 * all**, so both fell through to the same default and agreed by accident. The
 * moment one of them passes one they diverge in silence, and the one that
 * would diverge is the resume — a turn that paused at step seven and came back
 * with a fresh, bare ceiling.
 *
 * `SCHEDULED_MAX_STEPS` deliberately does NOT come through here. A scheduled
 * run gets no legs: `lib/routines/agent-run.ts` passes an explicit budget, and
 * `extraLegs` defaults to 0.
 */
export function chatBudget(env: Pick<RoutineEnv, "WORKER_PLAN">): ChatLimits {
  return planLimits(env).chat;
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
 * How much of a tool's answer the model is shown, in TOKENS.
 *
 * A query that returns ten thousand rows is not more useful to the model than
 * one that returns forty, and it costs input tokens on every remaining pass of
 * the turn — the transcript grows with each step, so an unbounded result is
 * paid for again and again. The tool says it was trimmed, so the model can ask
 * a narrower question rather than assume it saw everything.
 *
 * **Expressed in tokens since 2026-09-28. The character cap has not moved by one
 * character; what moved is the unit the ceiling is CHOSEN in.** It used to be
 * 12,000 characters with a comment converting that to tokens, and the conversion
 * was wrong by 1.7x — see `TOOL_OUTPUT_CHARS_PER_TOKEN` below for the measurement
 * that replaced it. The unit matters because every argument this number appears
 * in is an argument about tokens: what a turn can afford, and whether a long turn
 * fits its context window. The conversion in the middle was where the error lived.
 *
 * **Raised from 8,000 characters on 2026-09-25, and this time with both
 * arguments.** (`MAX_STEPS` above was moved that week on a cost argument alone,
 * with no runtime argument beside it, and had to be put straight back.)
 *
 * WHAT IT COSTS. A result produced at step k is re-sent on every later pass, so
 * the worst case is a full-size result at step 0 carried through the whole
 * budget: about **40,900 tokens** on Free's eight steps, and about **122,600** at
 * the 24 steps `lib/limits.ts` budgets a Paid turn. Both are roughly 1.7 times
 * what this comment used to claim. Measured against a real turn: "list my last
 * five meetings" charged 42,486 tokens in total, against a monthly allowance of a
 * million. The headroom is there.
 *
 * WHAT IT RISKS AT RUNTIME. On Free, nothing new: it is the same single `fetch`,
 * so it spends no extra subrequest — the ceiling that actually binds that plan.
 * On Paid the context window binds instead, and 122,600 tokens of tool results
 * does NOT fit inside the 128,000 that `gpt-4o` and `gpt-4o-mini` offer, both of
 * which are selectable per agent. What keeps a long turn inside its window is the
 * leg-boundary trim rather than this number; `ChatLimits.trimAbovePromptTokens`
 * carries that arithmetic, and it is thinner than it reads — a leg starting at the
 * 80,000 gate adds up to 40,900, landing at 120,900 with about 7,100 tokens spare.
 * The largest this cap could be and still leave that sum under 128,000 is 14,100
 * characters, so it has roughly 2,100 characters of headroom and no more.
 *
 * WHY IT WAS WORTH MOVING. Measured, not guessed: the same turn asked for a week
 * of calendar events with a `fields` list already narrowing the response —
 * following `run_tool`'s own advice — and still came back at 8,053 characters,
 * trimmed. The agent then told the person it could not be sure it had seen
 * everything. A cap that truncates a correctly-narrowed request is costing
 * correctness rather than saving money. That argument was made in characters and
 * is still sound in characters; changing the unit does not reopen it.
 */
export const MAX_TOOL_OUTPUT_TOKENS = 5_000;

/**
 * How many characters of a tool result go into one token, measured.
 *
 * **The four-to-one rule of thumb is wrong here, and it was in this file's own
 * comment until 2026-09-28, which said "12,000 characters is roughly 3,000
 * tokens".** Four characters per token is an average over English prose, and a
 * tool result is not English prose. It is JSON — quotes, braces, colons, uuids,
 * ISO timestamps, base64 — and the tokeniser fits far fewer characters into each
 * token. Every figure derived from 4:1 was wrong by 1.5 to 1.7 times, in the
 * expensive direction.
 *
 * MEASURED, and the only way it can be measured from here: by differencing
 * consecutive passes' reported `prompt` in `messages.pass_usage` against
 * `message_steps.result_chars` for the same `pass_index`, over the 118
 * single-step passes on record. (Both columns exist for exactly this. Migration
 * 0062 added `result_chars` saying "the tool-output budget has never been tuned
 * against anything".)
 *
 *     run_tool              2.35    25 samples
 *     http_request          2.76    17
 *     query_database        2.82     4
 *     describe_connection   3.52    18
 *     find_tool             4.01    29
 *     blended               2.59   118
 *
 * The spread is not five numbers, it is two populations. The dense three all
 * return JSON a foreign service wrote. The loose two return lines this harness
 * wrote itself — a schema listing, a shortlist of candidates — which is prose
 * with punctuation in it. The difference subtracts each pass's own completion
 * before dividing, so per-message overhead biases the ratio slightly LOW, which
 * makes 2.35 the conservative end of its own measurement.
 *
 * WHY THE DENSEST TOOL SETS IT, not the blend. `run_tool` is both the densest and
 * by a distance the highest-traffic, so a blended divisor would under-count the
 * tool doing most of the spending, and this number's whole job is to keep the
 * worst case honest. 2.4 rather than 2.35 because it is what keeps the character
 * cap below at exactly the 12,000 the 2026-09-25 measurement chose: a change made
 * to fix a comment must not move a ceiling as a side effect. The cost of that
 * rounding is named rather than hidden — a full-size `run_tool` result is 5,106
 * tokens against a stated budget of 5,000, two per cent over. That is inside the
 * noise of twenty-five samples and errs in the direction this file has already
 * chosen once, because a cap that truncates a correctly-narrowed request costs
 * correctness.
 *
 * WHY THERE IS NO PER-TOOL TABLE, having measured one. Per-tool divisors loosen
 * exactly the tools that cannot use the room. `find_tool`'s answer is bounded by
 * its own `MAX_RESULTS`, `MAX_DESCRIPTION_CHARS` and `MAX_SCHEMA_CHARS` long
 * before this cap — its worst case is about ten thousand characters and production
 * runs nearer three and a half thousand — so a 4.01 divisor would hand it eight
 * thousand characters it has no way to write. The other direction is worse: at a
 * 3,000-token budget `run_tool` would get 7,050 characters, below the 8,000 this
 * cap was raised past, which is the 2026-09-25 regression bought back. And nothing
 * has ever asked for more than 12,000 — the one measured incident asked for less
 * and was cut. So the table above is a derivation, not a configuration.
 *
 * WHY THERE IS NO `estimateTokens(text)` ANYWHERE, either, and must not be. The
 * turn budget MEASURES: `loop.ts` reads the provider's reported counts and never
 * guesses. An output cap has to decide before anything is sent, so it can only
 * estimate. Those are different jobs and one shared helper would hide that they
 * are. An estimate is wrong per tool by up to 1.7 times, and the only place this
 * codebase can afford to be that wrong is in choosing a constant once, where the
 * error is spent on headroom that was measured — never in deciding whether a
 * particular string fits, where it would be spent on a truncation the model reads
 * as an answer. So the conversion happens once, at module scope, in one direction.
 *
 * Named for tool output and not for text in general, because it is not true of
 * text in general: `HISTORY_CHAR_BUDGET` is conversation prose and nearer four.
 */
export const TOOL_OUTPUT_CHARS_PER_TOKEN = 2.4;

/**
 * The same ceiling in the unit `cap` actually cuts in.
 *
 * Derived rather than authored, so `MAX_TOOL_OUTPUT_TOKENS` is the number a person
 * moves and this is the number the code reads — the two cannot drift. All three
 * places the cap is applied read this one symbol: `loop.ts`, the confirmed-call
 * resume in `routes/chat.ts`, and `run_tool`'s own pre-compaction through
 * `compactForModel`. They agreed by reading one constant before and still do.
 *
 * 12,000 to the character, which is what it was before the unit changed.
 *
 * `Math.round` is not tidiness. `cap` puts this number into its notice and
 * `wasCapped` reads it back with `\d+`, so a value like 13,200.000000000002 —
 * which is what a token budget of 5,500 produces in floating point — would write a
 * notice nothing can match, and every capped result would become silently
 * re-cappable across a pause. 5,000 x 2.4 is exactly 12,000 today; the round is
 * for the budget somebody picks next.
 */
export const MAX_TOOL_OUTPUT_CHARS = Math.round(
  MAX_TOOL_OUTPUT_TOKENS * TOOL_OUTPUT_CHARS_PER_TOKEN,
);

/**
 * How large a transcript has to be before a leg boundary trims it.
 *
 * The harness default, matching both plans in `lib/limits.ts` — Free never
 * reaches it at eight steps, and a caller that forgets to pass one should get
 * the arithmetic rather than the old unconditional rewrite. The argument for
 * the number is on `ChatLimits.trimAbovePromptTokens`.
 */
export const TRIM_ABOVE_PROMPT_TOKENS = 80_000;

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

/**
 * Whether `cap` has already been applied to this text.
 *
 * Read off the text itself rather than remembered, because the thing that has
 * to know is on the other side of a pause: a turn parks its whole transcript in
 * `paused_turns.messages` and resumes in a fresh call with fresh variables, so
 * any set of "already done" indices is empty again while the capped text is
 * still there. Capping twice does not lose anything a reader can see, but it
 * rewrites the notice — `cap` puts the ORIGINAL length in it, so a second pass
 * reports the cut size as the original and tells the model a large result was
 * small.
 *
 * Anchored at the end and matched on the exact shape `cap` writes. A tool whose
 * own output happened to end this way would be left uncut, which costs some
 * transcript and breaks nothing.
 */
const CAPPED = /\n\n\[trimmed: (\d+) characters, showing the first \d+\]$/;

export function wasCapped(text: string): boolean {
  return CAPPED.test(text);
}

/**
 * Cut an already-cut text again, without losing what it originally was.
 *
 * `wasCapped` exists because capping twice rewrites the notice with the cut size
 * in place of the original — and for a while the only thing anybody did with that
 * knowledge was refuse to cut. `trimSpentResults` in `lib/harness/loop.ts` skipped
 * every result the notice appeared on, which is every result that reached
 * `MAX_TOOL_OUTPUT_CHARS`: **the largest results in the transcript, the only ones
 * the trim was written for, were the ones exempt from it.** Measured 2026-09-28;
 * only results between `MAX_STEP_EXCERPT_CHARS` and the output cap were ever cut.
 *
 * So the guard was right about the hazard and wrong about the remedy. This keeps
 * the original length — read back out of the notice the first cut wrote — and
 * reports the new cut against it, so a result that was 40,000 characters still
 * says 40,000 after being reduced to 2,000. The notice's SHAPE is unchanged, which
 * is what keeps `wasCapped` and everything that matches on it working, pause and
 * resume included.
 *
 * Falls through to `cap` for text that carries no notice, so one call site does
 * not have to ask which kind of text it is holding.
 */
export function recap(text: string, max: number): string {
  const seen = CAPPED.exec(text);
  if (!seen) return cap(text, max);
  const original = seen[1];
  const body = text.slice(0, text.length - seen[0].length);
  if (body.length <= max) return text;
  return `${body.slice(0, max)}\n\n[trimmed: ${original} characters, showing the first ${max}]`;
}
