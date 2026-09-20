import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { lookup } from "node:dns/promises";
import type { AppEnv } from "../types";
import { activeWorkspaceTables, fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { decryptSecret } from "../lib/secret-box";
import { parseWebhookSecret } from "../lib/routines/webhook";
import { resetRateLimiters } from "../lib/ratelimit";

// The delivery path runs the resolving half of the URL guard before it sends.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async () => [{ address: "93.184.216.34", family: 4 }]),
}));

/**
 * Creating, rotating and testing a channel all need the service role: the row
 * holds a secret the route encrypts, and `delivery_channels` grants the client
 * neither an INSERT nor sight of `secret_ciphertext`. That exemption is
 * argued for in `service-client.static.test.ts`; here it just has to be stubbed.
 */
const serviceFrom = vi.fn();
vi.mock("../lib/supabase", () => ({ serviceClient: () => ({ from: serviceFrom }) }));

const { routines } = await import("./routines");

const USER = { id: "user-1", email: "a@example.com" };
const WORKSPACE_ID = "workspace-1";
const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const ENV = {
  ROUTINE_SECRET_KEY: KEY,
  ALLOWED_ORIGIN: "https://app.example.com",
  WORKER_HOST: "api.example.com",
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Routines <routines@example.com>",
  RATE_LIMIT_EXPENSIVE_PER_MINUTE: "20",
};

beforeEach(() => {
  serviceFrom.mockReset();
  resetRateLimiters();
  vi.mocked(lookup).mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
});

function appWith(spec: FakeDbSpec = {}, env: Partial<typeof ENV> = {}) {
  const { db } = fakeDb({
    ...spec,
    tables: { ...activeWorkspaceTables(USER.id, WORKSPACE_ID), ...(spec.tables ?? {}) },
  });

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", routines);

  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(
      path,
      {
        method,
        headers: {
          "CF-Connecting-IP": "203.0.113.9",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      },
      { ...ENV, ...env } as never,
    );
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
}

/** The service-role chain the create path uses: insert → select → single. */
function insertReturning(row: Record<string, unknown>) {
  const captured: { values?: Record<string, unknown> } = {};
  serviceFrom.mockReturnValue({
    insert: (values: Record<string, unknown>) => {
      captured.values = values;
      return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
    },
  });
  return captured;
}

/** The service-role chain rotate and test use: select → eq → eq → maybeSingle. */
function channelRow(row: Record<string, unknown> | null, onUpdate?: (v: unknown) => void) {
  serviceFrom.mockReturnValue({
    select: () => ({
      eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
    }),
    update: (values: unknown) => {
      onUpdate?.(values);
      return { eq: () => ({ eq: async () => ({ error: null }) }) };
    },
  });
}

const CREATED = {
  id: "channel-1",
  kind: "webhook",
  label: "receiver.example.com/…ovan",
  created_at: "2026-09-20T00:00:00.000Z",
};

describe("POST /delivery-channels, kind webhook", () => {
  it("mints a signing secret and returns it exactly once", async () => {
    const captured = insertReturning(CREATED);
    const request = appWith();

    const { status, body } = await request("POST", "/delivery-channels", {
      kind: "webhook",
      secret: "https://receiver.example.com/covan",
    });

    expect(status).toBe(201);
    expect(body.signingSecret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);

    // What was stored is the URL and that same secret, as one encrypted object.
    const stored = parseWebhookSecret(
      await decryptSecret(captured.values!.secret_ciphertext as string, KEY),
    );
    expect(stored).toEqual({
      url: "https://receiver.example.com/covan",
      signingSecret: body.signingSecret,
    });
  });

  it("stores the caller's own id and workspace, never the body's", async () => {
    const captured = insertReturning(CREATED);
    const request = appWith();

    await request("POST", "/delivery-channels", {
      kind: "webhook",
      secret: "https://receiver.example.com/covan",
      user_id: "somebody-else",
      workspace_id: "another-workspace",
    });

    expect(captured.values).toMatchObject({ user_id: USER.id, workspace_id: WORKSPACE_ID });
  });

  it("labels the row with a mask rather than the URL", async () => {
    const captured = insertReturning(CREATED);
    const request = appWith();

    await request("POST", "/delivery-channels", {
      kind: "webhook",
      secret: "https://receiver.example.com/covan/aB3x",
    });

    expect(captured.values!.label).toBe("receiver.example.com/…aB3x");
    expect(captured.values!.label).not.toContain("/covan/");
  });

  // The generic kind gets the generic guard, which is the whole guard: scheme,
  // private address, and this service's own hosts.
  it.each([
    ["a private address", "http://169.254.169.254/latest/meta-data/"],
    ["localhost", "http://localhost:8787/hook"],
    ["a non-http scheme", "file:///etc/passwd"],
    ["this service", "https://api.example.com/hook"],
    ["the frontend", "https://app.example.com/hook"],
  ])("refuses %s", async (_case, url) => {
    insertReturning(CREATED);
    const request = appWith();

    const { status } = await request("POST", "/delivery-channels", {
      kind: "webhook",
      secret: url,
    });

    expect(status).toBe(400);
    expect(serviceFrom).not.toHaveBeenCalled();
  });

  // The Slack kind formats its body the way Slack expects and would post
  // nonsense anywhere else, so its narrower rule survives the widening.
  it("still holds slack_webhook to hooks.slack.com", async () => {
    insertReturning(CREATED);
    const request = appWith();

    const { status, body } = await request("POST", "/delivery-channels", {
      kind: "slack_webhook",
      secret: "https://receiver.example.com/covan",
    });

    expect(status).toBe(400);
    expect(body.error).toBe("not a slack webhook url");
  });

  it("gives a non-webhook kind no signing secret", async () => {
    insertReturning({ ...CREATED, kind: "email", label: "d…z@example.com" });
    const request = appWith();

    const { status, body } = await request("POST", "/delivery-channels", {
      kind: "email",
      secret: "deniz@example.com",
    });

    expect(status).toBe(201);
    expect(body).not.toHaveProperty("signingSecret");
  });
});

describe("POST /delivery-channels/:id/rotate", () => {
  const existing = async () => ({
    kind: "webhook",
    secret_ciphertext: await (async () => {
      const { encryptSecret } = await import("../lib/secret-box");
      const { serialiseWebhookSecret } = await import("../lib/routines/webhook");
      return encryptSecret(
        serialiseWebhookSecret({
          url: "https://receiver.example.com/covan",
          signingSecret: "whsec_OLD",
        }),
        KEY,
      );
    })(),
  });

  it("replaces the secret and keeps the destination", async () => {
    let written: unknown;
    channelRow(await existing(), (v) => (written = v));
    const request = appWith();

    const { status, body } = await request("POST", "/delivery-channels/channel-1/rotate");

    expect(status).toBe(200);
    expect(body.signingSecret).toMatch(/^whsec_/);
    expect(body.signingSecret).not.toBe("whsec_OLD");

    const stored = parseWebhookSecret(
      await decryptSecret((written as { secret_ciphertext: string }).secret_ciphertext, KEY),
    );
    // The URL is carried over rather than re-sent: rotation must not be a way
    // to repoint a channel past the guard that runs on create.
    expect(stored.url).toBe("https://receiver.example.com/covan");
    expect(stored.signingSecret).toBe(body.signingSecret);
  });

  it("is a 404 for a channel that is not the caller's", async () => {
    channelRow(null);
    const request = appWith();

    const { status } = await request("POST", "/delivery-channels/someone-elses/rotate");

    expect(status).toBe(404);
  });

  it("refuses a kind that has no signature", async () => {
    channelRow({ kind: "email", secret_ciphertext: "x" });
    const request = appWith();

    const { status, body } = await request("POST", "/delivery-channels/channel-1/rotate");

    expect(status).toBe(400);
    expect(body.error).toMatch(/only a webhook channel/);
  });
});

describe("POST /delivery-channels/:id/test", () => {
  const slackChannel = async () => {
    const { encryptSecret } = await import("../lib/secret-box");
    return {
      kind: "slack_webhook",
      secret_ciphertext: await encryptSecret("https://hooks.slack.com/services/E/E/E", KEY),
    };
  };

  it("sends through the channel and answers 204", async () => {
    channelRow(await slackChannel());
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    const request = appWith();

    const { status } = await request("POST", "/delivery-channels/channel-1/test");

    expect(status).toBe(204);
    expect(fetchImpl).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });

  // The button exists to report what the receiver said. "Could not deliver"
  // would be worth less than not having the button.
  it("passes the receiver's own words back on a failure", async () => {
    channelRow(await slackChannel());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_token", { status: 403 })),
    );
    const request = appWith();

    const { status, body } = await request("POST", "/delivery-channels/channel-1/test");

    expect(status).toBe(502);
    expect(body.error).toContain("invalid_token");
    vi.unstubAllGlobals();
  });

  it("is a 404 for a channel that is not the caller's", async () => {
    channelRow(null);
    const request = appWith();

    expect((await request("POST", "/delivery-channels/nope/test")).status).toBe(404);
  });

  // Not mounted behind rateLimit("expensive") — that mount list is what
  // ratelimit.static.test.ts compares against the endpoints which buy a
  // completion, and this buys none. It takes the same limiter by hand.
  it("is rate limited even though it is not mounted as expensive", async () => {
    channelRow(await slackChannel());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
    const request = appWith({}, { RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1" });

    expect((await request("POST", "/delivery-channels/channel-1/test")).status).toBe(204);
    const refused = await request("POST", "/delivery-channels/channel-1/test");

    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    vi.unstubAllGlobals();
  });
});
