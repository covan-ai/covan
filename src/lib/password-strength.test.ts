import { describe, it, expect } from "vitest";
import { passwordStrength } from "./password-strength";

describe("passwordStrength", () => {
  it("asks for length first, and rewards it most", () => {
    expect(passwordStrength("")).toEqual({ segments: 0, words: "At least 12 characters." });
    expect(passwordStrength("short1").segments).toBe(1);
    expect(passwordStrength("aaaaaaaaaaaaaa")).toEqual({
      segments: 2,
      words: "Fair. 14 characters; longer beats stranger.",
    });
    expect(passwordStrength("correct horse 1")).toEqual({
      segments: 3,
      words: "Good. 15 characters; longer beats stranger.",
    });
    expect(passwordStrength("correct horse battery").segments).toBe(4);
  });
});
