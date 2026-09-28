import { describe, it, expect } from "vitest";
import { planLimits, workerPlan } from "./limits";
import {
  MAX_STEPS,
  MAX_TOOL_OUTPUT_CHARS,
  TRIM_ABOVE_PROMPT_TOKENS,
  chatBudget,
} from "./harness/budget";

/**
 * The open build's contract, pinned.
 *
 * `lib/background.ts` promises out loud that a self-hoster's first deploy works
 * on Workers Free without a plan upgrade. Every ceiling in this codebase was
 * chosen against that plan's fifty subrequests, and the whole reason this file
 * exists is that the hosted deployment wanted bigger numbers and could not
 * simply have them.
 *
 * So the thing to guard is not "Paid is bigger" — that is obvious and would be
 * noticed. It is that **Free does not move**, and that a deployment which says
 * nothing gets Free. Both failures are silent: a self-hosted Covan that starts
 * exceeding its subrequest cap reports it as `Connection error.`, which is the
 * exact disguise this work exists to remove.
 */
describe("what a deployment is allowed to spend", () => {
  describe("saying nothing means Free", () => {
    it("reads an absent WORKER_PLAN as free, like every other optional var", () => {
      expect(workerPlan({})).toBe("free");
      expect(planLimits({})).toEqual(planLimits({ WORKER_PLAN: "free" }));
    });

    it("reads anything it does not recognise as free, not as paid", () => {
      // The safe direction to be wrong in. A Paid deployment that fumbles this
      // runs conservatively and finishes fewer turns; a Free one that had to
      // opt *out* would fail at a ceiling nothing reports.
      expect(workerPlan({ WORKER_PLAN: "Paid" as "paid" })).toBe("free");
      expect(workerPlan({ WORKER_PLAN: "" as "free" })).toBe("free");
      expect(workerPlan({ WORKER_PLAN: "enterprise" as "paid" })).toBe("free");
    });
  });

  describe("Free keeps today's numbers, to the digit", () => {
    it("budgets a chat turn exactly what the shared constant says", () => {
      // Not "8" written out again — the constant itself. A test that repeated
      // the literal would keep passing while the two drifted apart, which is
      // the only way this can actually go wrong.
      expect(chatBudget({}).maxSteps).toBe(MAX_STEPS);
    });

    it("gives a chat turn no legs, so its ceiling is the one it has always had", () => {
      expect(chatBudget({}).extraLegs).toBe(0);
    });

    it("trims a transcript at the size the harness would have chosen anyway", () => {
      // Not the literal again: the harness has its own default for a caller
      // that passes no budget, and the two disagreeing would mean a route and
      // a routine trimming at different sizes for no stated reason.
      expect(chatBudget({}).trimAbovePromptTokens).toBe(TRIM_ABOVE_PROMPT_TOKENS);
    });

    it("still says fifty subrequests, which is what every Free number was derived from", () => {
      expect(planLimits({}).subrequests).toBe(50);
    });
  });

  describe("Paid spends the headroom it paid for", () => {
    const paid = { WORKER_PLAN: "paid" as const };

    it("has ten thousand subrequests, not one thousand", () => {
      // The number was wrong in `budget.ts`'s comment for a while, and it
      // mattered: at 1,000 a 24-step turn reads as a quarter of the budget
      // rather than a fortieth, which argues for a smaller step count.
      expect(planLimits(paid).subrequests).toBe(10_000);
    });

    it("budgets more steps than Free, and two legs past them", () => {
      expect(chatBudget(paid).maxSteps).toBe(24);
      expect(chatBudget(paid).extraLegs).toBe(2);
      expect(chatBudget(paid).legSteps).toBe(8);
    });

    it("stops at forty, which only trimming pays for", () => {
      // The hard ceiling is soft + legs × legSteps. What licenses 40 rather
      // than 32 is not subrequests — it is `trimSpentResults` cutting the
      // results the turn has finished with at each boundary. A turn that
      // overflows its context gets a provider 400 wearing the same disguise the
      // subrequest cap does, so the ordering matters more than the number.
      const chat = chatBudget(paid);
      expect(chat.maxSteps + chat.extraLegs * chat.legSteps).toBe(40);
    });
  });

  describe("what one turn may spend, which is the same on both plans", () => {
    it("stops a turn at the size the measured runaway starts, not at a percentile", () => {
      // 150,000, and the reason it is not a percentile is in `limits.ts`: the
      // week of 2026-09-21 split in two rather than tailing off — turns at or
      // under this size averaged 4.5 steps and turns over it averaged 18.0. The
      // number sits in that gap.
      expect(chatBudget({}).maxTurnTokens).toBe(150_000);
    });

    it("is the same on Paid, because a runaway spends a self-hoster's own key too", () => {
      // The one ceiling in this file that deliberately does NOT move with the
      // plan. Paid buys headroom for turns that are working; it does not buy
      // permission for a turn that has stopped working.
      expect(chatBudget({ WORKER_PLAN: "paid" }).maxTurnTokens).toBe(chatBudget({}).maxTurnTokens);
    });

    it("leaves room above the turns that were finishing normally", () => {
      // p90 of the same fifty-two tool turns was 132,836. A guard set below that
      // would be cutting turns that were about to answer, which is the failure
      // this number is most likely to be "tuned" into later. Measured, so it is
      // an assertion rather than a hope.
      expect(chatBudget({}).maxTurnTokens).toBeGreaterThan(132_836);
    });
  });

  /**
   * The arithmetic that was wrong, as an assertion.
   *
   * `trimAbovePromptTokens` is justified by a sum done in prose: a leg that starts
   * at the gate must still fit the smallest context window an agent can be put on.
   * That sum was computed at four characters per token and the measured figure is
   * 2.35, so it was out by 1.7x — in the direction that matters. The value still
   * holds, but only just, and nothing was checking it.
   *
   * This is the one test here that can catch a mistake nobody has made yet: it
   * fails if the output cap is raised past ~14,100 characters, if `legSteps` grows,
   * or if the trim gate is lifted towards the window.
   */
  it("lets a leg that starts at the trim gate still fit the smallest window offered", () => {
    // `run_tool`'s measured density — the densest, so the worst case. See
    // `budget.ts`, which carries the sample counts.
    const DENSEST_CHARS_PER_TOKEN = 2.35;
    // `gpt-4o` and `gpt-4o-mini`, both selectable per agent.
    const SMALLEST_WINDOW = 128_000;

    const paid = chatBudget({ WORKER_PLAN: "paid" });
    const oneLegOfResults = (paid.legSteps * MAX_TOOL_OUTPUT_CHARS) / DENSEST_CHARS_PER_TOKEN;

    expect(paid.trimAbovePromptTokens + oneLegOfResults).toBeLessThan(SMALLEST_WINDOW);
  });

  it("hands out a frozen record, so one route cannot retune another's turn", () => {
    // Shared, module-level and returned by reference to every caller on the
    // Worker. A route that wrote to it would change the ceiling for every
    // request the isolate serves afterwards.
    const limits = planLimits({ WORKER_PLAN: "paid" });
    expect(Object.isFrozen(limits)).toBe(true);
    expect(Object.isFrozen(limits.chat)).toBe(true);
  });
});
