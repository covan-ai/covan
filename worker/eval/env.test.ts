import { describe, expect, it } from "vitest";
import { isAccountError } from "./env";

/**
 * The retrieval benchmark embeds with OpenAI, so its account errors have to be
 * recognised too — a rotated key there was reported as a raw stack trace.
 */
describe("isAccountError", () => {
  it("recognises OpenAI's wrong-key error", () => {
    expect(isAccountError(new Error("401 Incorrect API key provided: sk-proj-****FtQA."))).toBe(
      true,
    );
  });

  it("recognises OpenAI's out-of-credit error", () => {
    expect(
      isAccountError(new Error("429 You exceeded your current quota (insufficient_quota)")),
    ).toBe(true);
  });

  it("still recognises Anthropic's", () => {
    expect(isAccountError(new Error("Your credit balance is too low"))).toBe(true);
  });

  it("leaves an ordinary request error alone", () => {
    expect(isAccountError(new Error("400 input must be a string"))).toBe(false);
  });
});
