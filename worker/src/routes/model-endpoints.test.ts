import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { activeWorkspaceTables, fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { decryptSecret } from "../lib/secret-box";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const { modelEndpoints } = await import("./model-endpoints");

const USER = { id: "user-1", email: "ada@acme.test" };
const WORKSPACE_ID = "workspace-1";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = { ROUTINE_SECRET_KEY: KEY, ALLOWED_ORIGIN: "https://app.covan.test" };
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ROW = {
  id: ID,
  label: "acme-openai-proxy",
  model: "gpt-5-mini",
  base_url: "https://llm.acme.test/v1",
  created_by: USER.id,
  created_at: "2026-10-22T09:00:00Z",
};

function appWith(spec: FakeDbSpec = {}, key?: string) {
  const { db } = fakeDb({
    ...spec,
    tables: { ...activeWorkspaceTables(USER.id, WORKSPACE_ID), ...(spec.tables ?? {}) },
  });
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    if (key) c.set("apiKeyId", key);
    await next();
  });
  app.route("/", modelEndpoints);
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(
      path,
      {
        method,
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      },
      ENV as never,
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

describe("model endpoints", () => {
  it("lists them as a picker needs them: the id to store, the label and the host", async () => {
    const call = appWith({
      tables: { workspace_model_endpoints: { select: () => ({ data: [ROW], error: null }) } },
    });
    const res = await call("GET", "/model-endpoints");
    expect(res.body).toEqual([
      {
        id: ID,
        modelId: `endpoint:${ID}`,
        label: "acme-openai-proxy",
        model: "gpt-5-mini",
        host: "llm.acme.test",
        createdBy: USER.id,
        createdAt: Date.parse(ROW.created_at),
      },
    ]);
  });

  it("seals the key and writes through the caller", async () => {
    let written: Record<string, unknown> = {};
    const call = appWith({
      tables: {
        workspace_model_endpoints: {
          insert: (ctx) => {
            written = ctx.values!;
            return { data: ROW, error: null };
          },
        },
      },
    });
    const res = await call("POST", "/model-endpoints", {
      label: "acme-openai-proxy",
      model: "gpt-5-mini",
      baseUrl: "https://llm.acme.test/v1/",
      apiKey: "sk-acme",
    });
    expect(res.status).toBe(201);
    expect(written).toMatchObject({
      workspace_id: WORKSPACE_ID,
      base_url: "https://llm.acme.test/v1",
      created_by: USER.id,
    });
    expect(await decryptSecret(written.api_key_ciphertext as string, KEY)).toBe("sk-acme");
    expect(JSON.stringify(res.body)).not.toContain("sk-acme");
  });

  it("refuses http, credentials in the URL, a member, and an API key", async () => {
    const call = appWith({
      tables: {
        workspace_model_endpoints: {
          insert: () => ({ data: null, error: { message: "no", code: "42501" } }),
        },
      },
    });
    const base = { label: "x", model: "m" };
    expect(
      (await call("POST", "/model-endpoints", { ...base, baseUrl: "http://llm.acme.test" })).status,
    ).toBe(400);
    expect(
      (await call("POST", "/model-endpoints", { ...base, baseUrl: "https://a:b@llm.acme.test" }))
        .status,
    ).toBe(400);
    expect(
      (await call("POST", "/model-endpoints", { ...base, baseUrl: "https://llm.acme.test" }))
        .status,
    ).toBe(403);
    const keyed = appWith({}, "key-1");
    expect(
      (await keyed("POST", "/model-endpoints", { ...base, baseUrl: "https://llm.acme.test" }))
        .status,
    ).toBe(403);
  });

  it("removes one by marking it, and a row nobody may change is not found", async () => {
    let patch: Record<string, unknown> = {};
    const call = appWith({
      tables: {
        workspace_model_endpoints: {
          update: (ctx) => {
            patch = ctx.values!;
            return { data: [{ id: ID }], error: null };
          },
        },
      },
    });
    expect((await call("DELETE", `/model-endpoints/${ID}`)).status).toBe(204);
    expect(patch.deleted_at).toEqual(expect.any(String));

    const member = appWith({
      tables: { workspace_model_endpoints: { update: () => ({ data: [], error: null }) } },
    });
    expect((await member("DELETE", `/model-endpoints/${ID}`)).status).toBe(404);
  });
});
