import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { lookup } from "node:dns/promises";
import type { AppEnv } from "../types";
import { activeWorkspaceTables, fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { decryptSecret } from "../lib/secret-box";
import { maskSecret } from "../lib/routines/crypto";
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

describe("the ingest trigger endpoints", () => {
  /** The caller's own client sees the routine; the service client writes the hash. */
  function withRoutine(routine: Record<string, unknown> | null, onWrite?: (v: unknown) => void) {
    serviceFrom.mockReturnValue({
      upsert: (values: unknown) => {
        onWrite?.(values);
        return Promise.resolve({ error: null });
      },
    });
    return appWith({
      tables: {
        routines: { select: async () => ({ data: routine, error: null }) },
        routine_triggers: {
          select: async () => ({ data: null, error: null }),
          delete: async () => ({ data: null, error: null }),
        },
      },
    });
  }

  it("mints a token and returns it exactly once, with the path to use it", async () => {
    let written: unknown;
    const request = withRoutine({ id: "r1", trigger_kind: "webhook" }, (v) => (written = v));

    const { status, body } = await request("POST", "/routines/r1/trigger");

    expect(status).toBe(201);
    expect(body.token).toMatch(/^covan_whk_[A-Za-z0-9_-]{43}$/);
    expect(body.path).toBe(`/routine-hooks/${body.token}`);

    // What is stored is the digest, never the token.
    const stored = written as { token_hash: string };
    expect(stored.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(written)).not.toContain(body.token);
  });

  it("rotating clears the last-used mark, so a stale one cannot look live", async () => {
    let written: unknown;
    const request = withRoutine({ id: "r1", trigger_kind: "both" }, (v) => (written = v));

    await request("POST", "/routines/r1/trigger");

    expect(written).toMatchObject({ routine_id: "r1", last_used_at: null });
  });

  // Refused rather than switched on the caller's behalf: changing how an
  // unattended thing is started is not a side effect of pressing a button.
  it("refuses to mint one for a routine that does not accept pokes", async () => {
    const request = withRoutine({ id: "r1", trigger_kind: "schedule" });

    const { status, body } = await request("POST", "/routines/r1/trigger");

    expect(status).toBe(400);
    expect(body.error).toMatch(/not set to accept webhook triggers/);
  });

  it("is a 404 for a routine the caller cannot see", async () => {
    const request = withRoutine(null);

    expect((await request("POST", "/routines/nope/trigger")).status).toBe(404);
  });

  it("reports that there is no trigger without inventing one", async () => {
    const request = withRoutine({ id: "r1", trigger_kind: "webhook" });

    const { status, body } = await request("GET", "/routines/r1/trigger");

    expect(status).toBe(200);
    expect(body).toEqual({ configured: false });
  });

  it("never returns the hash when reporting one", async () => {
    const request = appWith({
      tables: {
        routine_triggers: {
          select: async () => ({
            data: {
              routine_id: "r1",
              created_at: "2026-09-20T00:00:00.000Z",
              last_used_at: "2026-09-21T00:00:00.000Z",
            },
            error: null,
          }),
        },
      },
    });

    const { body } = await request("GET", "/routines/r1/trigger");

    expect(body).toEqual({
      configured: true,
      createdAt: Date.parse("2026-09-20T00:00:00.000Z"),
      lastUsedAt: Date.parse("2026-09-21T00:00:00.000Z"),
    });
    expect(JSON.stringify(body)).not.toContain("token");
  });

  // 0055 grants authenticated a DELETE and scopes it to the owner, so the
  // database is the whole check and the service role has nothing to do here.
  it("turns one off through the caller's own client", async () => {
    const request = withRoutine({ id: "r1", trigger_kind: "webhook" });

    const { status } = await request("DELETE", "/routines/r1/trigger");

    expect(status).toBe(204);
    expect(serviceFrom).not.toHaveBeenCalled();
  });
});

describe("POST /routines, creating a delivery channel inline", () => {
  const AGENT_ID = "11111111-1111-4111-8111-111111111111";
  const CHANNEL_ID = "22222222-2222-4222-8222-222222222222";

  const ROUTINE_BODY = {
    agentId: AGENT_ID,
    name: "First week",
    sourceKind: "none",
    instruction: "say something",
    scheduleCron: "0 9 * * *",
    timezone: "UTC",
  };

  /**
   * `POST /routines` writes two tables: `routines` through the caller's own
   * client, and — only when an address arrives instead of a channel id —
   * `delivery_channels` through the service role. Both are captured here,
   * keyed by table, the way a real database would hand rows back: with their
   * generated `id` included. `deletedIds` captures the service role's deletes
   * too, for the rollback-on-failure case below.
   */
  function requestWith() {
    const byTable: Record<string, Array<Record<string, unknown>>> = {};
    const deletedIds: string[] = [];

    serviceFrom.mockImplementation((table: string) => ({
      insert: (values: Record<string, unknown>) => {
        const row = { id: `${table}-generated`, ...values };
        (byTable[table] ??= []).push(row);
        return { select: () => ({ single: async () => ({ data: { id: row.id }, error: null }) }) };
      },
      delete: () => ({
        eq: async (_column: string, value: string) => {
          deletedIds.push(value);
          return { error: null };
        },
      }),
    }));

    const request = appWith({
      tables: {
        agents: {
          select: async () => ({ data: { workspace_id: WORKSPACE_ID }, error: null }),
        },
        routines: {
          insert: async (ctx) => {
            const row = {
              id: "routine-1",
              visibility: "private",
              status: "active",
              paused_reason: null,
              last_run_at: null,
              created_at: "2026-09-20T00:00:00.000Z",
              ...ctx.values,
            };
            (byTable.routines ??= []).push(row);
            return { data: row, error: null };
          },
        },
      },
    });

    return { request, inserted: (table: string) => byTable[table] ?? [], deletedIds };
  }

  it("creates a channel from an address when the caller has none", async () => {
    const { request, inserted } = requestWith();

    const { status } = await request("POST", "/routines", {
      ...ROUTINE_BODY,
      deliveryEmail: "me@example.com",
    });

    expect(status).toBe(201);
    // The channel exists, belongs to the caller, in the agent's workspace, and
    // its label is masked.
    const channels = inserted("delivery_channels");
    expect(channels).toHaveLength(1);
    expect(channels[0].kind).toBe("email");
    expect(channels[0].user_id).toBe(USER.id);
    expect(channels[0].workspace_id).toBe(WORKSPACE_ID);
    expect(channels[0].label).toBe(maskSecret("email", "me@example.com"));
    expect(channels[0].secret_ciphertext).not.toContain("me@example.com");
    expect(inserted("routines")[0].delivery_channel_id).toBe(channels[0].id);
  });

  it("refuses both an address and a channel id in one request", async () => {
    const { request } = requestWith();

    const { status } = await request("POST", "/routines", {
      ...ROUTINE_BODY,
      name: "Both",
      deliveryChannelId: CHANNEL_ID,
      deliveryEmail: "me@example.com",
    });

    expect(status).toBe(400);
  });

  it("refuses neither an address nor a channel id", async () => {
    const { request } = requestWith();

    const { status } = await request("POST", "/routines", {
      ...ROUTINE_BODY,
      name: "Neither",
    });

    expect(status).toBe(400);
  });

  it("refuses an address that is not one", async () => {
    const { request } = requestWith();

    const { status } = await request("POST", "/routines", {
      ...ROUTINE_BODY,
      name: "Bad",
      deliveryEmail: "not-an-address",
    });

    expect(status).toBe(400);
  });

  // The pre-existing happy path, now flowing through the `let deliveryChannelId`
  // branch this task added: an id arrives, nothing is created or touched on
  // the service role at all.
  it("creates the routine directly against an existing channel id", async () => {
    const { request, inserted } = requestWith();

    const { status } = await request("POST", "/routines", {
      ...ROUTINE_BODY,
      name: "Existing channel",
      deliveryChannelId: CHANNEL_ID,
    });

    expect(status).toBe(201);
    expect(inserted("delivery_channels")).toHaveLength(0);
    expect(inserted("routines")[0].delivery_channel_id).toBe(CHANNEL_ID);
    expect(serviceFrom).not.toHaveBeenCalled();
  });

  // Finding 3: the channel is minted before the routine insert is attempted,
  // so a failure on the routine's own terms — here, a schedule the parser
  // cannot read — must not leave it behind. Otherwise correcting the field and
  // resubmitting mints a second one on top of the orphan.
  it("deletes the channel it just created when the routine insert fails", async () => {
    const { request, inserted, deletedIds } = requestWith();

    const { status } = await request("POST", "/routines", {
      ...ROUTINE_BODY,
      scheduleCron: "not a cron",
      deliveryEmail: "me@example.com",
    });

    expect(status).toBe(400);
    const channels = inserted("delivery_channels");
    expect(channels).toHaveLength(1);
    expect(deletedIds).toEqual([channels[0].id]);
    expect(inserted("routines")).toHaveLength(0);
  });

  // 0073 bounds a series at 1–365 delivered runs — a year is not a series, and
  // 0 is not a bound at all. Caught by `createSchema` itself, before anything
  // is written, unlike the cron check above: no channel is minted and nothing
  // needs rolling back.
  describe("endsAfterRuns bounds", () => {
    it.each([0, 366])("refuses %i", async (endsAfterRuns) => {
      const { request, inserted } = requestWith();

      const { status } = await request("POST", "/routines", {
        ...ROUTINE_BODY,
        deliveryChannelId: CHANNEL_ID,
        endsAfterRuns,
      });

      expect(status).toBe(400);
      expect(inserted("routines")).toHaveLength(0);
    });

    it.each([1, 365])("accepts %i", async (endsAfterRuns) => {
      const { request, inserted } = requestWith();

      const { status } = await request("POST", "/routines", {
        ...ROUTINE_BODY,
        deliveryChannelId: CHANNEL_ID,
        endsAfterRuns,
      });

      expect(status).toBe(201);
      expect(inserted("routines")[0].ends_after_runs).toBe(endsAfterRuns);
    });
  });

  // Task 17's blocker (b): `createSchema`'s `sourceKind` enum did not list
  // `workspace`, so this request 400'd on the zod parse, before `createRoutine`
  // — and therefore (c) and (d) below it — ever ran.
  describe("sourceKind workspace", () => {
    it("is accepted with no url and no connection, and gets the report slug server-side", async () => {
      const { request, inserted } = requestWith();

      const { status } = await request("POST", "/routines", {
        ...ROUTINE_BODY,
        name: "Coverage gaps",
        sourceKind: "workspace",
        deliveryChannelId: CHANNEL_ID,
      });

      expect(status).toBe(201);
      const row = inserted("routines")[0];
      expect(row.source_kind).toBe("workspace");
      // (d): the slug is decided in `createRoutine`, not sent by this request
      // — `ROUTINE_BODY` carries no report field at all. Matched against
      // 0075's own pattern, not just equality.
      const config = row.source_config as Record<string, unknown>;
      expect(config.report).toBe("coverage_gaps");
      expect(String(config.report)).toMatch(/^[a-z][a-z0-9_]{0,63}$/);
    });
  });
});
