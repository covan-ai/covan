import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { activeWorkspaceTables, fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { decryptSecret } from "../lib/secret-box";

const engine = vi.hoisted(() => ({ deliverWebhookNow: vi.fn() }));
vi.mock("../lib/webhooks/dispatcher", () => ({ deliverWebhookNow: engine.deliverWebhookNow }));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

const { webhooks } = await import("./webhooks");

const USER = { id: "user-1", email: "ada@acme.test" };
const WORKSPACE_ID = "workspace-1";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const ENV = {
  ROUTINE_SECRET_KEY: KEY,
  ALLOWED_ORIGIN: "https://app.covan.test",
  WORKER_HOST: "api.covan.test",
};

const ENDPOINT = {
  id: "e1",
  url: "https://hooks.acme.test/covan",
  events: ["thread.finished", "agent.needs_you"],
  created_by: USER.id,
  created_at: "2026-10-22T09:00:00Z",
  disabled_at: null,
};

function appWith(spec: FakeDbSpec = {}, key?: string) {
  const { db, calls } = fakeDb({
    ...spec,
    tables: { ...activeWorkspaceTables(USER.id, WORKSPACE_ID), ...(spec.tables ?? {}) },
  });
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    if (key) {
      c.set("apiKeyId", key);
      c.set("apiKeyWorkspaceId", WORKSPACE_ID);
    }
    await next();
  });
  app.route("/", webhooks);
  const call = async (method: string, path: string, body?: unknown) => {
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
  return { call, calls };
}

beforeEach(() => engine.deliverWebhookNow.mockReset());

describe("GET /webhooks", () => {
  it("lists the endpoints and the last day's deliveries, never a secret", async () => {
    const { call } = appWith({
      tables: {
        webhook_endpoints: { select: () => ({ data: [ENDPOINT], error: null }) },
        webhook_deliveries: {
          select: () => ({
            data: [
              {
                id: "d1",
                endpoint_id: "e1",
                event: "thread.finished",
                status: "failed",
                attempt: 4,
                status_code: 503,
                latency_ms: 120,
                last_error: "answered 503",
                created_at: "2026-10-21T10:00:00Z",
                delivered_at: null,
              },
            ],
            error: null,
          }),
        },
      },
    });
    const res = await call("GET", "/webhooks");
    expect(res.status).toBe(200);
    expect(res.body.endpoints).toEqual([
      {
        id: "e1",
        url: ENDPOINT.url,
        events: ["thread.finished", "agent.needs_you"],
        createdBy: USER.id,
        createdAt: Date.parse(ENDPOINT.created_at),
        enabled: true,
      },
    ]);
    expect(res.body.deliveries[0]).toMatchObject({ status: "failed", attempt: 4, statusCode: 503 });
    expect(JSON.stringify(res.body)).not.toContain("secret");
  });
});

describe("POST /webhooks", () => {
  it("seals a new secret, writes through the caller, and shows the secret once", async () => {
    let written: Record<string, unknown> = {};
    const { call } = appWith({
      tables: {
        webhook_endpoints: {
          insert: (ctx) => {
            written = ctx.values!;
            return { data: ENDPOINT, error: null };
          },
        },
      },
    });
    const res = await call("POST", "/webhooks", {
      url: ENDPOINT.url,
      events: ["thread.finished", "thread.finished"],
    });
    expect(res.status).toBe(201);
    expect(res.body.secret).toMatch(/^whsec_/);
    expect(written).toMatchObject({
      workspace_id: WORKSPACE_ID,
      url: ENDPOINT.url,
      events: ["thread.finished"],
      created_by: USER.id,
    });
    expect(await decryptSecret(written.secret_ciphertext as string, KEY)).toBe(res.body.secret);
  });

  it("refuses http, this install's own host, and an API key", async () => {
    const { call } = appWith();
    expect((await call("POST", "/webhooks", { url: "http://hooks.acme.test/x" })).status).toBe(400);
    expect((await call("POST", "/webhooks", { url: "https://api.covan.test/x" })).status).toBe(400);
    const keyed = appWith({}, "key-1");
    expect((await keyed.call("POST", "/webhooks", { url: ENDPOINT.url })).status).toBe(403);
  });

  it("is the admins': the policy's refusal is a 403", async () => {
    const { call } = appWith({
      tables: {
        webhook_endpoints: {
          insert: () => ({ data: null, error: { message: "denied", code: "42501" } }),
        },
      },
    });
    expect((await call("POST", "/webhooks", { url: ENDPOINT.url })).status).toBe(403);
  });
});

describe("changing one", () => {
  it("turns it off, and a row nobody may change reads as not found", async () => {
    let patch: Record<string, unknown> = {};
    const { call } = appWith({
      tables: {
        webhook_endpoints: {
          update: (ctx) => {
            patch = ctx.values!;
            return { data: { ...ENDPOINT, disabled_at: "2026-10-22T10:00:00Z" }, error: null };
          },
        },
      },
    });
    const res = await call("PATCH", "/webhooks/e1", { enabled: false });
    expect(res.body.enabled).toBe(false);
    expect(patch.disabled_at).toEqual(expect.any(String));

    const member = appWith({
      tables: { webhook_endpoints: { update: () => ({ data: null, error: null }) } },
    });
    expect((await member.call("PATCH", "/webhooks/e1", { enabled: false })).status).toBe(404);
  });

  it("rotates to a new secret, shown once", async () => {
    let sealed = "";
    const { call } = appWith({
      tables: {
        webhook_endpoints: {
          update: (ctx) => {
            sealed = ctx.values!.secret_ciphertext as string;
            return { data: ENDPOINT, error: null };
          },
        },
      },
    });
    const res = await call("POST", "/webhooks/e1/rotate");
    expect(await decryptSecret(sealed, KEY)).toBe(res.body.secret);
  });
});

describe("a test and a resend", () => {
  it("queues a test through the caller and has the engine send that row", async () => {
    engine.deliverWebhookNow.mockResolvedValue({
      status: "ok",
      statusCode: 200,
      latencyMs: 84,
      error: null,
    });
    const { call } = appWith({
      rpc: { enqueue_webhook_test: () => ({ data: "d9", error: null }) },
    });
    const res = await call("POST", "/webhooks/e1/test");
    expect(res.body).toMatchObject({ deliveryId: "d9", status: "ok", statusCode: 200 });
    expect(engine.deliverWebhookNow).toHaveBeenCalledWith(ENV, "d9");
  });

  it("maps the functions' refusals", async () => {
    const { call } = appWith({
      rpc: {
        enqueue_webhook_test: () => ({
          data: null,
          error: { message: "only admins", code: "42501" },
        }),
        resend_webhook_delivery: () => ({
          data: null,
          error: { message: "only a delivery that gave up can be sent again", code: "22023" },
        }),
      },
    });
    expect((await call("POST", "/webhooks/e1/test")).status).toBe(403);
    expect(engine.deliverWebhookNow).not.toHaveBeenCalled();
    expect((await call("POST", "/webhooks/deliveries/d1/resend")).status).toBe(400);
  });
});
