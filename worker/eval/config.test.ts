import { describe, expect, it } from "vitest";
import { resolvePlan, describeConfig, refsAtRisk, EvalConfigError } from "./config";
import { REASONING_EFFORTS } from "../src/lib/models";

/**
 * These are the two mistakes that cost money and report a number anyway, so
 * they are tested rather than trusted. Everything else in `run.ts` fails
 * loudly on its own.
 */
describe("resolvePlan", () => {
  const base = { variant: "v1", model: "claude-sonnet-5" };

  it("sends no effort by default, which is not the same request as medium", () => {
    // Nine production gpt-5 agents name no effort. A reference that sent
    // "medium" would be measuring something none of them do.
    expect(resolvePlan(base).effort).toBeNull();
    expect(resolvePlan({ ...base, effort: "" }).effort).toBeNull();
    expect(describeConfig("gpt-5", null)).toBe("gpt-5, effort unset (provider default)");
  });

  it("accepts every effort the rest of the product accepts", () => {
    for (const effort of REASONING_EFFORTS) {
      expect(resolvePlan({ ...base, model: "gpt-5", effort }).effort).toBe(effort);
    }
  });

  it("refuses an effort the model would silently drop", () => {
    // The failure this prevents: a full-price run whose "variant" is identical
    // to its reference, reporting a 50% win rate as a finding.
    expect(() => resolvePlan({ ...base, model: "gpt-4o", effort: "low" })).toThrow(EvalConfigError);
    expect(() => resolvePlan({ ...base, model: "gpt-4o", effort: "low" })).toThrow(
      /does not reason/,
    );
  });

  it("refuses an effort that is not one of the four", () => {
    expect(() => resolvePlan({ ...base, model: "gpt-5", effort: "maximum" })).toThrow(
      /minimal, low, medium, high/,
    );
  });

  it("lets an unknown model through with a warning rather than a refusal", () => {
    // Under `OPENAI_BASE_URL` every id is unknown to the table, and refusing a
    // self-hoster's model on no evidence would be worse than saying so.
    const plan = resolvePlan({ ...base, model: "some-local-model", effort: "low" });
    expect(plan.effort).toBe("low");
    expect(plan.warnings.join(" ")).toMatch(/not in the model table/);
  });

  it("keeps baseline freezing by name", () => {
    const plan = resolvePlan({ ...base, variant: "baseline", judge: true });
    expect(plan.freeze).toBe(true);
    // A reference is the opponent; it cannot also be a contender.
    expect(plan.judge).toBe(false);
    expect(plan.warnings.join(" ")).toMatch(/--judge ignored/);
  });

  it("freezes any variant that asks to", () => {
    const plan = resolvePlan({ ...base, variant: "gpt5-default", freeze: true });
    expect(plan.freeze).toBe(true);
  });

  it("judges against baseline unless told otherwise", () => {
    expect(resolvePlan({ ...base, judge: true }).against).toBe("baseline");
    expect(resolvePlan({ ...base, judge: true, against: "gpt5-default" }).against).toBe(
      "gpt5-default",
    );
  });

  it("refuses to judge a variant against its own reference", () => {
    expect(() => resolvePlan({ ...base, variant: "x", against: "x", judge: true })).toThrow(
      /against itself/,
    );
  });
});

describe("refsAtRisk", () => {
  it("names the frozen answers a run is about to overwrite", () => {
    expect(refsAtRisk(["a", "b", "c"], ["b", "c", "d"])).toEqual(["b", "c"]);
  });

  it("does not object to a resumed freeze", () => {
    // The cases already bought are not in the queue, so the files they wrote
    // are not at risk — only a re-run of a case that already has one is.
    expect(refsAtRisk(["c"], ["a", "b"])).toEqual([]);
  });

  it("counts a case queued twice once", () => {
    expect(refsAtRisk(["a", "a"], ["a"])).toEqual(["a"]);
  });
});
