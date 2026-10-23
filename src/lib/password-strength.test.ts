import { describe, it, expect } from "vitest";
import { i18n } from "@/i18n";
import { passwordStrength } from "./password-strength";

/** The real translator, so the sentences come back with their numbers in. */
const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts);

describe("passwordStrength", () => {
  it("asks for length first, and rewards it most", () => {
    expect(passwordStrength("", t)).toEqual({ segments: 0, words: "At least 12 characters." });
    expect(passwordStrength("short1", t).segments).toBe(1);
    expect(passwordStrength("aaaaaaaaaaaaaa", t)).toEqual({
      segments: 2,
      words: "Fair. 14 characters; longer beats stranger.",
    });
    expect(passwordStrength("correct horse 1", t)).toEqual({
      segments: 3,
      words: "Good. 15 characters; longer beats stranger.",
    });
    expect(passwordStrength("correct horse battery", t).segments).toBe(4);
  });
});
