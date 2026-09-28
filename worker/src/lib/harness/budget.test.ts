import { describe, it, expect } from "vitest";
import {
  MAX_STEP_EXCERPT_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  MAX_TOOL_OUTPUT_TOKENS,
  TOOL_OUTPUT_CHARS_PER_TOKEN,
  cap,
  recap,
  wasCapped,
} from "./budget";

/**
 * The tool-output ceiling, and the measurement underneath it.
 *
 * This file did not exist while the cap was a bare character count, which is how
 * `MAX_TOOL_OUTPUT_CHARS` came to be asserted nowhere at all and how a comment
 * converting it to tokens could be wrong by 1.7x for three days without anything
 * noticing. The conversion is now a constant, so it can be pinned.
 */
describe("what a tool result may cost", () => {
  it("keeps the character cap exactly where the 2026-09-25 measurement put it", () => {
    // The one place a literal is the right assertion. The whole claim of moving
    // this to a token unit is that NO ceiling moved; a test reading the constant
    // could not make that claim, because it would follow the constant anywhere.
    expect(MAX_TOOL_OUTPUT_CHARS).toBe(12_000);
  });

  it("derives the character cap from the token budget rather than restating it", () => {
    expect(MAX_TOOL_OUTPUT_CHARS).toBe(
      Math.round(MAX_TOOL_OUTPUT_TOKENS * TOOL_OUTPUT_CHARS_PER_TOKEN),
    );
  });

  it("lands on a whole number, because the cap goes into a notice a regex reads back", () => {
    // 5,500 x 2.4 is 13200.000000000002 in floating point, and `wasCapped`'s
    // `\d+` would not match a notice carrying that. Every capped result would
    // then become silently re-cappable across a pause.
    expect(Number.isInteger(MAX_TOOL_OUTPUT_CHARS)).toBe(true);
  });

  it("stays within a named margin of the stated budget for the densest tool", () => {
    // `run_tool` measured 2.35 characters per token and is the highest-traffic
    // tool, so it is the one the ceiling has to be honest about. 12,000 / 2.35 is
    // 5,106 against a stated 5,000 — two per cent, named here so a future divisor
    // change cannot quietly turn it into thirty.
    const densest = 2.35;
    expect(MAX_TOOL_OUTPUT_CHARS / densest).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_TOKENS * 1.05);
  });

  describe("cutting text, and cutting it again", () => {
    it("writes a notice wasCapped can read back, at the real cap", () => {
      const out = cap("x".repeat(MAX_TOOL_OUTPUT_CHARS + 1), MAX_TOOL_OUTPUT_CHARS);
      expect(wasCapped(out)).toBe(true);
      expect(out).toContain(`showing the first ${MAX_TOOL_OUTPUT_CHARS}`);
    });

    it("leaves text that already fits completely alone", () => {
      expect(cap("short", 100)).toBe("short");
      expect(wasCapped("short")).toBe(false);
    });

    it("keeps the ORIGINAL length when cutting an already-cut result", () => {
      // The whole point of `recap`. `trimSpentResults` cuts a spent result down to
      // the excerpt floor, and a plain second `cap` would report 12,000 as the
      // original — telling the model a 40,000-character answer had been small.
      const once = cap("x".repeat(40_000), MAX_TOOL_OUTPUT_CHARS);
      const twice = recap(once, MAX_STEP_EXCERPT_CHARS);

      expect(twice).toContain("[trimmed: 40000 characters");
      expect(twice).toContain(`showing the first ${MAX_STEP_EXCERPT_CHARS}`);
      expect(twice).not.toContain("[trimmed: 12000");
      // Still the shape everything downstream matches on.
      expect(wasCapped(twice)).toBe(true);
    });

    it("behaves like cap for text that carries no notice", () => {
      // So one call site does not have to ask which kind of text it holds.
      expect(recap("x".repeat(5_000), 2_000)).toBe(cap("x".repeat(5_000), 2_000));
    });

    it("leaves an already-cut result alone when its body already fits", () => {
      const once = cap("x".repeat(3_000), 2_500);
      expect(recap(once, 2_500)).toBe(once);
    });
  });
});
