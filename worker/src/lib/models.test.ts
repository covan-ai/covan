import { describe, it, expect } from "vitest";
import {
  resolveModel,
  providerFor,
  acceptsTemperature,
  availableModels,
  modelSpec,
  DEFAULT_MODEL,
  MODEL_IDS,
} from "./models";

const WITH_KEY = { ANTHROPIC_API_KEY: "sk-ant-test" };

describe("the catalogue", () => {
  it("describes every id it offers", () => {
    // `SPECS` is keyed by ModelId so tsc already enforces this, but the tuple
    // and the record are two lists and only one of them is what the picker
    // renders. This is the runtime half of that guarantee.
    for (const id of MODEL_IDS) expect(modelSpec(id), id).toBeDefined();
  });

  it("keeps the default servable with no key but OPENAI_API_KEY", () => {
    expect(availableModels()).toContain(DEFAULT_MODEL);
    expect(providerFor(DEFAULT_MODEL)).toBe("openai");
  });
});

describe("providerFor", () => {
  it("routes the Claude ids to Anthropic and the GPT ids to OpenAI", () => {
    expect(providerFor("claude-sonnet-4-5")).toBe("anthropic");
    expect(providerFor("claude-haiku-4-5")).toBe("anthropic");
    expect(providerFor("gpt-5-mini")).toBe("openai");
  });

  it("treats an unknown id as OpenAI's, because that is what a custom endpoint serves", () => {
    // Under OPENAI_BASE_URL every id is unknown to this list by design.
    expect(providerFor("llama3.3:70b")).toBe("openai");
    expect(providerFor(null)).toBe("openai");
  });
});

describe("acceptsTemperature", () => {
  it("refuses one for the GPT-5 family, which rejects any value but its own", () => {
    // Brainstorm mode is the only caller that sets a temperature. Sending 0.9
    // to a reasoning model is a 400, so this is the difference between "that
    // agent brainstorms" and "that agent errors".
    expect(acceptsTemperature("gpt-5")).toBe(false);
    expect(acceptsTemperature("gpt-5-mini")).toBe(false);
    expect(acceptsTemperature("gpt-5-nano")).toBe(false);
  });

  it("allows one everywhere else, unknown endpoints included", () => {
    expect(acceptsTemperature("gpt-4o")).toBe(true);
    expect(acceptsTemperature("claude-sonnet-4-6")).toBe(true);
    expect(acceptsTemperature("llama3.3:70b")).toBe(true);
  });
});

describe("availableModels", () => {
  it("hides the Claude ids from a deployment with no Anthropic key", () => {
    const offered = availableModels();
    expect(offered).toContain("gpt-5-mini");
    expect(offered.filter((m) => m.startsWith("claude-"))).toEqual([]);
  });

  it("offers everything once the key is set", () => {
    expect(availableModels(WITH_KEY)).toEqual([...MODEL_IDS]);
  });
});

describe("resolveModel", () => {
  it("keeps a model this build knows", () => {
    expect(resolveModel("gpt-4.1-mini")).toBe("gpt-4.1-mini");
    expect(resolveModel("gpt-5-nano")).toBe("gpt-5-nano");
  });

  it("falls back to the default for a model it does not know", () => {
    expect(resolveModel("claude-3-opus")).toBe(DEFAULT_MODEL);
  });

  it("falls back to the default when the agent has no model", () => {
    expect(resolveModel(null)).toBe(DEFAULT_MODEL);
  });

  describe("for a Claude model", () => {
    it("keeps it when there is a key to serve it with", () => {
      expect(resolveModel("claude-sonnet-4-5", WITH_KEY)).toBe("claude-sonnet-4-5");
    });

    it("falls back to the default when there is not, instead of failing the turn", () => {
      // A key rotated out must not stop every agent that was on Claude from
      // answering. The pick stops resolving; the conversation continues.
      expect(resolveModel("claude-sonnet-4-5")).toBe(DEFAULT_MODEL);
      expect(resolveModel("claude-haiku-4-5", { ANTHROPIC_API_KEY: "" })).toBe(DEFAULT_MODEL);
    });
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

    it("does not reach a Claude pick, which is not served over that endpoint at all", () => {
      expect(resolveModel("claude-sonnet-4-6", { ...env, ...WITH_KEY })).toBe("claude-sonnet-4-6");
    });

    it("still catches a Claude pick this deployment cannot serve", () => {
      // No Anthropic key: the pick is unserveable, so it falls through to the
      // override rather than to gpt-4o — which the local endpoint has never
      // heard of either. This ordering is what keeps an Ollama-only install
      // from ever addressing api.anthropic.com.
      expect(resolveModel("claude-sonnet-4-6", env)).toBe("llama3.3:70b");
    });
  });
});
