import { describe, expect, it } from "vitest";
import { ceilingReason, passageCeiling } from "./knowledge-ceiling";

describe("passageCeiling", () => {
  it("is no ceiling when unset or empty", () => {
    expect(passageCeiling({})).toBeNull();
    expect(passageCeiling({ WORKSPACE_MAX_PASSAGES: " " })).toBeNull();
  });

  it("reads a whole number", () => {
    expect(passageCeiling({ WORKSPACE_MAX_PASSAGES: "5000" })).toBe(5000);
  });

  // Read at start-up by `loadEnv`, so a typo is an error at `docker compose
  // up` rather than a ceiling of NaN that refuses nothing.
  it("refuses anything else, naming the variable", () => {
    for (const raw of ["0", "-1", "2.5", "lots"]) {
      expect(() => passageCeiling({ WORKSPACE_MAX_PASSAGES: raw })).toThrow(
        /WORKSPACE_MAX_PASSAGES/,
      );
    }
  });
});

describe("ceilingReason", () => {
  it("says what is held, what is needed and what to do", () => {
    const reason = ceilingReason(4800, 350, 5000);
    expect(reason).toContain("4,800 passages");
    expect(reason).toContain("needs 350");
    expect(reason).toContain("limit is 5,000");
    expect(reason).toContain("Remove documents");
  });
});
