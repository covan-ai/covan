import { describe, expect, it, vi } from "vitest";
import { encryptSecret } from "./secret-box";
import { withModelEndpoint } from "./model-endpoints";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) =>
    host === "inward.acme.test"
      ? [{ address: "10.0.0.5", family: 4 }]
      : [{ address: "93.184.216.34", family: 4 }],
  ),
}));

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const env: {
  ROUTINE_SECRET_KEY: string;
  ALLOWED_ORIGIN: string;
  MODEL_ENDPOINT?: { id: string; model: string; baseUrl: string; apiKey: string };
} = { ROUTINE_SECRET_KEY: KEY, ALLOWED_ORIGIN: "https://app.covan.test" };

function service(row: Record<string, unknown> | null) {
  const filters: Array<[string, unknown]> = [];
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = (c: string, v: unknown) => {
    filters.push([c, v]);
    return chain;
  };
  chain.is = () => chain;
  chain.maybeSingle = async () => ({ data: row, error: null });
  return { db: { from: () => chain } as never, filters };
}

describe("routing to a workspace endpoint", () => {
  it("opens the key for the workspace the request runs in", async () => {
    const { db, filters } = service({
      id: ID,
      model: "gpt-5-mini",
      base_url: "https://llm.acme.test/v1",
      api_key_ciphertext: await encryptSecret("sk-acme", KEY),
    });
    const out = await withModelEndpoint(env, db, "w1", `endpoint:${ID}`);
    expect(out.MODEL_ENDPOINT).toEqual({
      id: `endpoint:${ID}`,
      model: "gpt-5-mini",
      baseUrl: "https://llm.acme.test/v1",
      apiKey: "sk-acme",
    });
    expect(filters).toEqual([
      ["id", ID],
      ["workspace_id", "w1"],
    ]);
  });

  it("leaves the env alone for an ordinary model, a missing endpoint, or one pointing inward", async () => {
    expect(await withModelEndpoint(env, service(null).db, "w1", "gpt-4.1")).toBe(env);
    expect(
      (await withModelEndpoint(env, service(null).db, "w1", `endpoint:${ID}`)).MODEL_ENDPOINT,
    ).toBeUndefined();
    const inward = service({
      id: ID,
      model: "m",
      base_url: "https://inward.acme.test/v1",
      api_key_ciphertext: null,
    });
    expect(
      (await withModelEndpoint(env, inward.db, "w1", `endpoint:${ID}`)).MODEL_ENDPOINT,
    ).toBeUndefined();
  });
});
