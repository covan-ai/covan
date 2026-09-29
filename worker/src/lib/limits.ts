import type { RoutineEnv } from "../types";

/**
 * What this deployment's Cloudflare plan allows, and what Covan spends of it.
 *
 * WHY THIS FILE EXISTS. Every ceiling in this codebase was chosen against
 * **fifty subrequests per invocation**, which is what Workers Free allows and
 * what `lib/runtime-limit.ts` was written about. covan.app is on Workers Paid
 * and gets 10,000, so those ceilings cost it finished answers — but they are
 * not covan.app's numbers to raise. They ship to self-hosters, and
 * `lib/background.ts` makes the promise out loud: *"the open build has to work
 * on Free — a self-hoster's first deploy is the one that has to not need a
 * plan upgrade."*
 *
 * A flat raise keeps covan.app working and breaks every self-hosted deploy
 * silently, in exactly the disguised way the runtime limit already fails: the
 * platform's refusal arrives wearing the OpenAI SDK's `Connection error.` So
 * the numbers are plan-aware rather than simply bigger, and Free keeps today's
 * values to the digit.
 *
 * HOW A DEPLOYMENT SAYS WHICH IT IS. One optional var, `WORKER_PLAN`, and
 * **absent means `free`** — this codebase's convention for every optional var,
 * and the safe direction to be wrong in: a Paid deployment that forgets to set
 * it runs conservatively, where a Free deployment that had to opt out would
 * fail at a ceiling nothing reports.
 *
 * WHAT IS NOT HERE YET. The automation numbers — routine and connection batch
 * sizes, per-run document and removal caps, the tick deadline — belong in this
 * record and are not in it, because nothing reads them yet. They arrive with
 * their readers; this file is the agreed place for them.
 */

/** The two plans this codebase distinguishes. Absent means the first one. */
export type WorkerPlan = "free" | "paid";

/** What one chat turn may spend, on this plan. */
export type ChatLimits = {
  /**
   * How many tools one turn is budgeted, across every pass.
   *
   * A soft ceiling: crossing it starts a leg rather than stopping the turn.
   * The argument for the number itself lives in `lib/harness/budget.ts`, which
   * is also where the Free value's history is kept. This is only where the two
   * plans disagree about it.
   */
  maxSteps: number;
  /**
   * How many extra legs a turn may take past `maxSteps`, and how long each is.
   *
   * `extraLegs: 0` means the soft ceiling is the only ceiling — today's
   * behaviour, and what Free keeps.
   *
   * **On Paid the binding constraint is the context window, not the subrequest
   * cap.** Once the plan is Paid, subrequests stop being what binds: 24 steps
   * is roughly 250 of 10,000. What binds instead is the transcript. A step's
   * result is re-sent on every later pass, so at 24 steps
   * `MAX_TOOL_OUTPUT_TOKENS` alone would be **~122,600 tokens** of tool results,
   * and a turn that overflows gets a provider 400 wearing the same disguise the
   * subrequest cap does. That figure read ~72,000 until 2026-09-28, from a
   * four-characters-per-token rule of thumb that a tool result does not obey; the
   * measurement is in `budget.ts`. It does not weaken this paragraph, it makes it
   * starker — 122,600 does not fit a 128k window on its own, with nothing else in
   * the request at all.
   *
   * And "before the persona, the manifest, the history and the retrieval block"
   * used to end that sentence with no figure on any of them. Measured
   * 2026-09-29 (`count_tokens`, see `0069_what_the_prompt_was_made_of.sql`): the
   * persona, both manifests, the retrieval block and all eight tool schemas come
   * to **~11,000 tokens** together, of which the largest single item is not ours —
   * Anthropic's server-side web_search tool is 5,588 of it. `MAX_HISTORY_TOKENS`
   * in `lib/history.ts` is a further **~16,800** at its worst. So the fixed
   * envelope around a tool loop is on the order of 28,000 tokens before the first
   * result lands, which is what `trimAbovePromptTokens: 80_000` is really leaving
   * room for.
   *
   * That is why 2 was not allowed to ship first. It is allowed now because
   * `trimSpentResults` in `lib/harness/loop.ts` cuts the results the turn has
   * finished with at each boundary, so the transcript a 40-step turn carries
   * is closer to one leg at full size plus the rest at `MAX_STEP_EXCERPT_CHARS`
   * than to forty at full size. Raising this without that is the one ordering
   * mistake this whole file exists to prevent.
   */
  extraLegs: number;
  legSteps: number;
  /**
   * What one turn may spend, prompt plus completion, whatever the plan.
   *
   * **The same on both, and deliberately so: this is a runaway-loop guard, not
   * a billing one.** Billing is the monthly allowance, which already knows who
   * is paying and already lets a workspace carry its own key past it. This is
   * the stop for the turn that goes wrong — and a turn going wrong costs a
   * self-hoster their own OpenAI bill exactly as it costs the operator theirs.
   *
   * Why it is needed beside a step budget at all: steps bound how many times a
   * turn reaches outside, not what those calls cost. The incident this work
   * came from charged 131,868 prompt tokens inside an 8-step budget it never
   * exceeded, 88% of it cache reads of a transcript re-sent on every pass.
   *
   * **150,000, re-derived 2026-09-28 from the week of real numbers the previous
   * value asked for.** It was 500,000, chosen against a single measured
   * 42,486-token tool turn with a note to revisit after a week. The week came in
   * and 500,000 turned out to be sixteen times the median, high enough that it
   * has never once fired: the most expensive turn on record charged 446,532
   * tokens and passed underneath it.
   *
   * WHAT THE WEEK SAID. Fifty-two tool turns, 2026-09-21 to 09-28: median
   * 31,293, p90 132,836, p95 228,672, largest 586,932. But the distribution is
   * what decides the number, because it is not a curve — it is two groups:
   *
   *     turns at or under 150,000 tokens     4.5 steps on average
   *     turns over 150,000 tokens           18.0 steps on average
   *
   * So 150,000 sits in the gap rather than on a percentile. It catches four of
   * fifty-two turns (7.7%), leaves p90 untouched, and every turn it would have
   * stopped was already in the runaway shape this guard exists for — a turn
   * averaging eighteen steps is not a turn having a hard question, it is a turn
   * recovering from something. Picking a percentile instead would have been
   * picking a point on a line that is not there.
   *
   * Still the same on both plans, and still for the reason above: a runaway
   * turn spends a self-hoster's own key exactly as it spends the operator's.
   */
  maxTurnTokens: number;
  /**
   * How large the transcript has to get before a leg boundary trims it.
   *
   * Trimming old tool results invalidates the prompt cache from the first edit
   * — everything after it is re-written at the write rate and re-read at the
   * read rate — so the saving is the cut bytes multiplied by however many
   * passes still come, and the cost is paid once, immediately, on the whole
   * tail. Measured on the 583,139-token turn of 2026-09-25: pass 9 wrote
   * 11,547 tokens for a 210-character result and pass 14 wrote 6,796 for
   * 2,262 characters. At $3.75/M written against $0.30/M read that is about
   * $0.07 spent to save $0.004, and it only pays back if the cut bytes would
   * be re-read for more than twelve further passes on Anthropic or ten on
   * OpenAI. A leg is eight steps.
   *
   * So the trim is for the transcript that is genuinely large, where the
   * alternative is a provider 400 rather than a few cents.
   *
   * 80,000 rather than the 120,000 an earlier pass argued from a 200k window.
   * `legOf` gives a Paid turn only TWO boundaries — at 24 steps and at 32 —
   * and each is one-shot, so a gate the first one misses is eight more results
   * at `MAX_TOOL_OUTPUT_TOKENS`, roughly **40,900 tokens**, before the next
   * chance. `gpt-4o` and `gpt-4o-mini` are 128k and both are selectable per
   * agent: at 120,000 a first boundary measuring 112,000 would pass, then add
   * 40,900 for 152,900, and the turn would meet a provider 400 it used to
   * survive. 80,000 leaves that headroom on the smallest window the picker offers
   * and is still a transcript large enough for the rewrite to be worth its cache
   * write. The same number on both plans, because Free never gets near it at
   * eight steps.
   *
   * **The real margin is thinner than this paragraph used to imply, and it is
   * worth writing down even though the number does not move.** These figures were
   * derived from four characters per token; the measurement in `budget.ts` puts a
   * tool result at 2.35. So a leg starting exactly at this gate adds up to 40,900
   * rather than 24,000, landing at 120,900 against 128,000 — about **7,100 tokens
   * of slack**, not the ~24,000 the old arithmetic suggested. The rejection of
   * 120,000 gets stronger, so 80,000 survives on its own argument; but the largest
   * `MAX_TOOL_OUTPUT_CHARS` could be and still keep that sum under the window is
   * 14,100 characters, which is the real reason not to raise it again. A number
   * that STAYS has to stay for a true reason, the same as one that moves.
   */
  trimAbovePromptTokens: number;
};

export type PlanLimits = {
  /**
   * Subrequests one invocation may make, as Cloudflare documents them.
   *
   * Not enforced here and not enforceable here — the platform is what counts
   * them. It is recorded because it is the fact every number below was derived
   * from, and a derivation whose premise is written down somewhere else is how
   * `MAX_STEPS` was raised to sixteen on a cost argument with no runtime
   * argument beside it.
   */
  subrequests: number;
  chat: ChatLimits;
};

/**
 * Today's numbers, unchanged, and the ones a first deploy gets.
 *
 * Nothing in this column may move without the argument that moved it being
 * about Workers Free. It is the open build's contract.
 */
const FREE: PlanLimits = Object.freeze({
  subrequests: 50,
  chat: Object.freeze({
    maxSteps: 8,
    extraLegs: 0,
    legSteps: 8,
    maxTurnTokens: 150_000,
    trimAbovePromptTokens: 80_000,
  }),
});

/**
 * What a deployment that has paid for the headroom may spend.
 *
 * Every entry here is `FREE`'s until something needs it to differ and has the
 * arithmetic for it. A number in this column is a claim that the Free one was
 * chosen by the platform rather than by the product.
 */
const PAID: PlanLimits = Object.freeze({
  subrequests: 10_000,
  chat: Object.freeze({
    maxSteps: 24,
    extraLegs: 2,
    legSteps: 8,
    maxTurnTokens: 150_000,
    trimAbovePromptTokens: 80_000,
  }),
});

/** Which plan this environment says it is on. Anything but `"paid"` is Free. */
export function workerPlan(env: Pick<RoutineEnv, "WORKER_PLAN">): WorkerPlan {
  return env.WORKER_PLAN === "paid" ? "paid" : "free";
}

/** The whole set of ceilings for this environment, frozen. */
export function planLimits(env: Pick<RoutineEnv, "WORKER_PLAN">): PlanLimits {
  return workerPlan(env) === "paid" ? PAID : FREE;
}
