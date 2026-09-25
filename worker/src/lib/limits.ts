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
   * `MAX_TOOL_OUTPUT_CHARS` alone would be ~72,000 tokens of tool results,
   * before the persona, the manifest, `HISTORY_CHAR_BUDGET`, the retrieval
   * block and two dozen assistant turns — and a turn that overflows gets a
   * provider 400 wearing the same disguise the subrequest cap does.
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
  chat: Object.freeze({ maxSteps: 8, extraLegs: 0, legSteps: 8 }),
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
  chat: Object.freeze({ maxSteps: 24, extraLegs: 2, legSteps: 8 }),
});

/** Which plan this environment says it is on. Anything but `"paid"` is Free. */
export function workerPlan(env: Pick<RoutineEnv, "WORKER_PLAN">): WorkerPlan {
  return env.WORKER_PLAN === "paid" ? "paid" : "free";
}

/** The whole set of ceilings for this environment, frozen. */
export function planLimits(env: Pick<RoutineEnv, "WORKER_PLAN">): PlanLimits {
  return workerPlan(env) === "paid" ? PAID : FREE;
}
