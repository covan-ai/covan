import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { activeWorkspaceTables, fakeDb, type FakeDbSpec } from "../test-support/fake-db";
import { apiKeys } from "./api-keys";

const USER = { id: "user-1", email: "a@example.com" };
const WORKSPACE_ID = "workspace-1";

const KEY_ROW = {
  id: "key-1",
  name: "Nightly report",
  prefix: "covan_sk_ab12cd",
  created_at: "2026-08-01T00:00:00.000Z",
  last_used_at: null,
};

/**
 * @param apiKeyId set it to pretend the caller proved themselves with a key
 * rather than with a session — which is the whole subject of half this file.
 */
function appWith(spec: FakeDbSpec & { apiKeyId?: string; noJwtSecret?: boolean }) {
  const { apiKeyId, noJwtSecret, ...dbSpec } = spec;
  // A flag rather than `jwtSecret: undefined`, which a default parameter would
  // quietly fill back in — the absence is the thing being tested.
  const jwtSecret = noJwtSecret ? undefined : "a-signing-secret";
  const { db, calls, callsTo } = fakeDb({
    ...dbSpec,
    tables: { ...activeWorkspaceTables(USER.id, WORKSPACE_ID), ...(dbSpec.tables ?? {}) },
  });

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    if (apiKeyId) c.set("apiKeyId", apiKeyId);
    await next();
  });
  app.route("/", apiKeys);

  return { app, calls, callsTo, env: { SUPABASE_JWT_SECRET: jwtSecret } };
}

async function json(
  fixture: ReturnType<typeof appWith>,
  method: string,
  path: string,
  body?: unknown,
) {
  const res = await fixture.app.request(
    path,
    {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
    fixture.env,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("GET /api-keys", () => {
  it("asks only for the caller's own live keys", async () => {
    let filters: { column: string; value: unknown; kind: string }[] = [];
    const fixture = appWith({
      tables: {
        api_keys: {
          select: (ctx) => {
            filters = ctx.filters as typeof filters;
            return { data: [KEY_ROW], error: null };
          },
        },
      },
    });

    const { status, body } = await json(fixture, "GET", "/api-keys");

    expect(status).toBe(200);
    expect(body.available).toBe(true);
    // The policy in 0033 is own-keys-only, and this filter agrees with it rather
    // than leaning on it — the arrangement GET /invitations/incoming did not
    // have, which is how an admin met their own outgoing invitations.
    expect(filters).toContainEqual(expect.objectContaining({ column: "user_id", value: USER.id }));
    // `.is`, not `.eq`: eq(column, null) sends the string "null" and matches
    // nothing, which would quietly list revoked keys as live.
    expect(filters).toContainEqual({ column: "revoked_at", value: null, kind: "is" });
  });

  it("never returns the hash, and has no column to return the key from", async () => {
    const fixture = appWith({
      tables: { api_keys: { select: () => ({ data: [KEY_ROW], error: null }) } },
    });

    const { body } = await json(fixture, "GET", "/api-keys");

    expect(JSON.stringify(body)).not.toContain("token_hash");
    expect((body.keys as Record<string, unknown>[])[0]).not.toHaveProperty("token");
  });

  it("says the feature is unavailable rather than that you have no keys", async () => {
    // Two different sentences. Without a signing secret nothing could honour a
    // key, so offering an empty list with a create button would be a lie.
    const fixture = appWith({ noJwtSecret: true, tables: {} });

    const { status, body } = await json(fixture, "GET", "/api-keys");

    expect(status).toBe(200);
    expect(body.available).toBe(false);
    expect(body.keys).toEqual([]);
  });
});

describe("POST /api-keys", () => {
  it("returns the key once, and stores only its hash", async () => {
    let inserted: Record<string, unknown> = {};
    const fixture = appWith({
      tables: {
        api_keys: {
          insert: (ctx) => {
            inserted = ctx.values ?? {};
            return { data: [KEY_ROW], error: null };
          },
        },
      },
    });

    const { status, body } = await json(fixture, "POST", "/api-keys", { name: "Nightly report" });

    expect(status).toBe(201);
    expect(String(body.token)).toMatch(/^covan_sk_/);
    // The row must not carry it. This is the assertion that would fail if
    // somebody ever "helpfully" added a plaintext column to make listing easier.
    expect(inserted).not.toHaveProperty("token");
    expect(Object.values(inserted)).not.toContain(body.token);
    expect(String(inserted.token_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(inserted.user_id).toBe(USER.id);
    expect(inserted.workspace_id).toBe(WORKSPACE_ID);
  });

  it.each([
    ["an empty name", { name: "   " }],
    ["no name at all", {}],
    ["a name longer than the column allows", { name: "x".repeat(61) }],
  ])("refuses %s", async (_label, payload) => {
    const fixture = appWith({
      tables: { api_keys: { insert: () => ({ data: [], error: null }) } },
    });

    const { status } = await json(fixture, "POST", "/api-keys", payload);

    expect(status).toBe(400);
  });

  it("treats a policy refusal as forbidden, not as a fault", async () => {
    const fixture = appWith({
      tables: { api_keys: { insert: () => ({ data: [], error: null }) } },
    });

    const { status } = await json(fixture, "POST", "/api-keys", { name: "Nightly report" });

    expect(status).toBe(403);
  });

  // The rule this whole feature rests on. A key that can create keys cannot be
  // revoked: it writes successors the moment it leaks, and taking down the
  // original leaves every one of them working.
  it("refuses to mint a key for a caller who is already using one", async () => {
    const fixture = appWith({
      apiKeyId: "key-1",
      tables: {
        api_keys: {
          insert: () => {
            throw new Error("the route reached the database, which it must not");
          },
        },
      },
    });

    const { status, body } = await json(fixture, "POST", "/api-keys", { name: "Another" });

    expect(status).toBe(403);
    expect(String(body.error)).toContain("sign in");
  });

  it("refuses when the deployment cannot sign a token to honour the key with", async () => {
    const fixture = appWith({ noJwtSecret: true, tables: {} });

    const { status } = await json(fixture, "POST", "/api-keys", { name: "Nightly report" });

    expect(status).toBe(501);
  });
});

describe("DELETE /api-keys/:id", () => {
  it("revokes by writing a timestamp rather than removing the row", async () => {
    let values: Record<string, unknown> = {};
    let filters: { column: string; value: unknown; kind: string }[] = [];
    const fixture = appWith({
      tables: {
        api_keys: {
          update: (ctx) => {
            values = ctx.values ?? {};
            filters = ctx.filters as typeof filters;
            return { data: [{ id: "key-1" }], error: null };
          },
          delete: () => {
            throw new Error("revocation must not delete the row");
          },
        },
      },
    });

    const { status } = await json(fixture, "DELETE", "/api-keys/key-1");

    expect(status).toBe(200);
    expect(values).toHaveProperty("revoked_at");
    expect(filters).toContainEqual(expect.objectContaining({ column: "id", value: "key-1" }));
    // Already-revoked rows are excluded, so a second revocation is a 404 rather
    // than a silent success that moves the timestamp — 0033's trigger would
    // refuse it anyway, and a route that relied on that would surface a 500.
    expect(filters).toContainEqual({ column: "revoked_at", value: null, kind: "is" });
  });

  it("reports a key that is not the caller's as missing", async () => {
    // RLS returns no rows rather than an error, and the route must not read that
    // as success.
    const fixture = appWith({
      tables: { api_keys: { update: () => ({ data: [], error: null }) } },
    });

    const { status } = await json(fixture, "DELETE", "/api-keys/somebody-elses");

    expect(status).toBe(404);
  });

  it("refuses a caller who is using a key", async () => {
    // The other half of the rule above: a leaked key must not be able to revoke
    // the keys somebody is still relying on.
    const fixture = appWith({
      apiKeyId: "key-1",
      tables: {
        api_keys: {
          update: () => {
            throw new Error("the route reached the database, which it must not");
          },
        },
      },
    });

    const { status } = await json(fixture, "DELETE", "/api-keys/key-2");

    expect(status).toBe(403);
  });
});
