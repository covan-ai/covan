import { describe, expect, it, vi } from "vitest";
import { complete, type CompletionEnv } from "./completion";
import { estimateCostUsd } from "./pricing";
import {
  ENDPOINT_MODEL_PATTERN,
  endpointModelId,
  isEndpointModel,
  modelSpec,
  resolveModel,
  supportsTools,
} from "./models";

/**
 * A workspace's own endpoint (0135), from the model id to the wire: Covan
 * calls it `endpoint:<id>` everywhere, and only the completion call sends the
 * model's own name, to the endpoint's address, with its key.
 */
const made: Array<{ apiKey?: string; baseURL?: string }> = [];
const create = vi.fn(async () => ({
  choices: [{ message: { content: "hello" } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
}));
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create } };
    constructor(options: { apiKey?: string; baseURL?: string }) {
      made.push(options);
    }
  },
}));

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MODEL = endpointModelId(ID);
const house: CompletionEnv = { OPENAI_API_KEY: "sk-house" };
const routed: CompletionEnv = {
  ...house,
  MODEL_ENDPOINT: {
    id: MODEL,
    model: "gpt-5-mini",
    baseUrl: "https://llm.acme.test/v1",
    apiKey: "sk-acme",
  },
};

describe("an endpoint's model id", () => {
  it("is recognised, served only once routed, takes tools and costs nothing here", () => {
    expect(isEndpointModel(MODEL)).toBe(true);
    expect(ENDPOINT_MODEL_PATTERN.test(MODEL)).toBe(true);
    expect(isEndpointModel("endpoint:not-a-uuid")).toBe(false);
    expect(resolveModel(MODEL, { MODEL_ENDPOINT: { id: MODEL } })).toBe(MODEL);
    expect(resolveModel(MODEL, {})).toBe(resolveModel(null, {}));
    expect(modelSpec(MODEL)?.provider).toBe("openai");
    expect(supportsTools(MODEL)).toBe(true);
    expect(estimateCostUsd(MODEL, 1_000_000, 1_000_000)).toBe(0);
  });
});

describe("a completion on it", () => {
  it("goes to the endpoint, with its key, under the model's own name", async () => {
    made.length = 0;
    const out = await complete(routed, {
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.text).toBe("hello");
    expect(made.at(-1)).toMatchObject({ apiKey: "sk-acme", baseURL: "https://llm.acme.test/v1" });
    expect((create.mock.calls.at(-1) as unknown[])[0]).toMatchObject({ model: "gpt-5-mini" });
  });

  it("is refused unrouted, rather than sent to the install's provider", async () => {
    await expect(
      complete(house, { model: MODEL, messages: [{ role: "user", content: "hi" }] }),
    ).rejects.toThrow(/endpoint is not available/);
  });
});
