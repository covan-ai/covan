import { describe, it, expect } from "vitest";
import { resolveModel, DEFAULT_MODEL } from "./models";

describe("resolveModel", () => {
  it("keeps a model this build knows", () => {
    expect(resolveModel("gpt-4.1-mini")).toBe("gpt-4.1-mini");
  });

  it("falls back to the default for a model it does not know", () => {
    expect(resolveModel("claude-3-opus")).toBe(DEFAULT_MODEL);
  });

  it("falls back to the default when the agent has no model", () => {
    expect(resolveModel(null)).toBe(DEFAULT_MODEL);
  });

  describe("with OPENAI_MODEL configured", () => {
    const env = { OPENAI_MODEL: "llama3.3:70b" };

    it("uses the configured model, since the allowlist describes OpenAI's catalogue and not this endpoint's", () => {
      expect(resolveModel(null, env)).toBe("llama3.3:70b");
    });

    it("overrides a per-agent model the endpoint would not recognise either", () => {
      expect(resolveModel("gpt-4o", env)).toBe("llama3.3:70b");
    });

    it("is ignored when empty, so a blank line in .env does not select a nameless model", () => {
      expect(resolveModel("gpt-4o", { OPENAI_MODEL: "" })).toBe("gpt-4o");
    });
  });
});
