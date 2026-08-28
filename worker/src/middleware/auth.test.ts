import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";

/**
 * `authMiddleware` is 33 lines and stands in front of every authenticated route
 * in the API. It does two things that matter: it refuses anything without a
 * valid bearer token, and — for the tokens it accepts — it hands the rest of the
 * request a Supabase client built from *that* token, which is what makes
 * `auth.uid()` (and therefore every RLS policy) resolve to the caller.
 *
 * The second half is the quiet one. A change that attached the anon client, or
 * the service-role client, to `c.set("db")` would leave every route working and
 * every tenant boundary gone. So these tests assert not just the 401s but which
 * client ends up on the context, and with which token.
 */

const authGetUser = vi.fn();
const authClient = vi.fn((_env: unknown) => ({ auth: { getUser: authGetUser } }));
const userClient = vi.fn((_env: unknown, token: string) => ({ marker: "user-client", token }));

vi.mock("../lib/supabase", () => ({
  authClient: (env: unknown) => authClient(env),
  userClient: (env: unknown, token: string) => userClient(env, token),
}));

const resolveApiKey = vi.fn(async (..._args: unknown[]): Promise<unknown> => null);
const mintUserToken = vi.fn(async (..._args: unknown[]) => "minted-jwt");
const touchApiKey = vi.fn(async (..._args: unknown[]) => {});

vi.mock("../lib/api-keys", async () => {
  // `looksLikeApiKey` is the real one: the branch it decides is the subject of
  // half these tests, and a mocked predicate would be asserting on the mock.
  const actual = await vi.importActual<typeof import("../lib/api-keys")>("../lib/api-keys");
  return {
    ...actual,
    resolveApiKey: (...args: unknown[]) => resolveApiKey(...args),
    mintUserToken: (...args: unknown[]) => mintUserToken(...args),
    touchApiKey: (...args: unknown[]) => touchApiKey(...args),
  };
});

const { authMiddleware } = await import("./auth");
const { API_KEY_PREFIX } = await import("../lib/api-keys");

/** Records what the middleware put on the context, if it let the request past. */
function app() {
  const seen: { user?: unknown; db?: unknown; apiKeyId?: unknown; reached: boolean } = {
    reached: false,
  };

  const server = new Hono<AppEnv>();
  server.use("/*", authMiddleware);
  server.get("/probe", (c) => {
    seen.reached = true;
    seen.user = c.get("user");
    seen.db = c.get("db");
    seen.apiKeyId = c.get("apiKeyId");
    return c.json({ ok: true });
  });

  return { server, seen };
}

/** Stands in for the Worker bindings; only its identity is asserted on. */
const ENV = { SUPABASE_URL: "https://example.supabase.co" };

/** The same, for a deployment that can mint tokens for API keys. */
const KEYED_ENV = { ...ENV, SUPABASE_JWT_SECRET: "a-signing-secret" };

const get = (server: Hono<AppEnv>, headers: Record<string, string> = {}) =>
  server.request("/probe", { headers }, ENV);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authMiddleware", () => {
  it("refuses a request with no Authorization header", async () => {
    const { server, seen } = app();

    const res = await get(server);

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(seen.reached).toBe(false);
    // Never worth a round trip to Supabase.
    expect(authGetUser).not.toHaveBeenCalled();
  });

  it.each([
    ["a scheme that is not Bearer", "Basic dXNlcjpwYXNz"],
    ["a lowercase scheme", "bearer abc123"],
    ["Bearer with nothing after it", "Bearer "],
    ["Bearer with only whitespace", "Bearer    "],
    ["the raw token with no scheme", "abc123"],
  ])("refuses %s", async (_label, header) => {
    const { server, seen } = app();

    const res = await get(server, { Authorization: header });

    expect(res.status).toBe(401);
    expect(seen.reached).toBe(false);
    expect(authGetUser).not.toHaveBeenCalled();
  });

  it("refuses a token Supabase rejects", async () => {
    authGetUser.mockResolvedValue({ data: null, error: { message: "invalid JWT" } });
    const { server, seen } = app();

    const res = await get(server, { Authorization: "Bearer expired-token" });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "unauthorized" });
    expect(seen.reached).toBe(false);
    // The rejected token must not have been used to build a data client.
    expect(userClient).not.toHaveBeenCalled();
  });

  it("refuses a token that comes back without a user", async () => {
    // Supabase reporting no error and no user is not a licence to continue with
    // `undefined` as the caller.
    authGetUser.mockResolvedValue({ data: { user: null }, error: null });
    const { server, seen } = app();

    const res = await get(server, { Authorization: "Bearer ghost" });

    expect(res.status).toBe(401);
    expect(seen.reached).toBe(false);
    expect(userClient).not.toHaveBeenCalled();
  });

  it("lets a valid token through, carrying the caller's identity", async () => {
    const user = { id: "user-1", email: "a@example.com" };
    authGetUser.mockResolvedValue({ data: { user }, error: null });
    const { server, seen } = app();

    const res = await get(server, { Authorization: "Bearer good-token" });

    expect(res.status).toBe(200);
    expect(seen.reached).toBe(true);
    expect(seen.user).toEqual(user);
  });

  it("builds the request's data client from the caller's own token", async () => {
    // This is the assertion that keeps RLS wired up: the client on `db` has to
    // be the token-scoped one, not the anon client used to validate the token.
    authGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    const { server, seen } = app();

    await get(server, { Authorization: "Bearer good-token" });

    expect(userClient).toHaveBeenCalledWith(ENV, "good-token");
    expect(seen.db).toEqual({ marker: "user-client", token: "good-token" });
  });

  it("trims padding around the token rather than passing it on", async () => {
    authGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    const { server } = app();

    await get(server, { Authorization: "Bearer   padded-token  " });

    expect(authGetUser).toHaveBeenCalledWith("padded-token");
    expect(userClient).toHaveBeenCalledWith(ENV, "padded-token");
  });
});

/**
 * The API-key branch.
 *
 * A key is not a second authorization model — it is a way to become the person
 * who owns it, so that everything downstream, and every policy in Postgres, goes
 * on working exactly as it does for a browser. These tests are about the seam:
 * that a key is told apart from a session token without either being parsed,
 * that the client handed on is built from the *minted* token rather than from
 * the key, and that nothing gets through when the key does not resolve.
 */
describe("authMiddleware, with an API key", () => {
  const KEY = `${API_KEY_PREFIX}0123456789abcdef`;
  const USER = { id: "user-1", email: "a@example.com" };
  const RESOLVED = { keyId: "key-1", workspaceId: "ws-1", user: USER, lastUsedAt: null };

  const withKey = (server: Hono<AppEnv>, env: Record<string, unknown> = KEYED_ENV) =>
    server.request("/probe", { headers: { Authorization: `Bearer ${KEY}` } }, env);

  it("does not send a key to Supabase as if it were a session token", async () => {
    resolveApiKey.mockResolvedValue(RESOLVED);
    const { server } = app();

    await withKey(server);

    // getUser would answer 401 for a `covan_sk_` string, which is the right
    // answer to the wrong question and would make every key look invalid.
    expect(authGetUser).not.toHaveBeenCalled();
    expect(resolveApiKey).toHaveBeenCalledWith(KEYED_ENV, KEY);
  });

  it("builds the data client from the minted token, never from the key", async () => {
    resolveApiKey.mockResolvedValue(RESOLVED);
    const { server, seen } = app();

    await withKey(server);

    expect(mintUserToken).toHaveBeenCalledWith("a-signing-secret", USER);
    expect(userClient).toHaveBeenCalledWith(KEYED_ENV, "minted-jwt");
    expect(seen.db).toEqual({ marker: "user-client", token: "minted-jwt" });
    // The key is a credential, not a token any database would accept.
    expect(userClient).not.toHaveBeenCalledWith(expect.anything(), KEY);
  });

  it("carries the key's owner as the caller", async () => {
    resolveApiKey.mockResolvedValue(RESOLVED);
    const { server, seen } = app();

    const res = await withKey(server);

    expect(res.status).toBe(200);
    expect(seen.user).toEqual(USER);
  });

  it("marks the request as key-authenticated, so a route can refuse", async () => {
    // Nothing here uses it; routes/api-keys.ts does, and without this flag a
    // leaked key could write itself successors that revocation would not reach.
    resolveApiKey.mockResolvedValue(RESOLVED);
    const { server, seen } = app();

    await withKey(server);

    expect(seen.apiKeyId).toBe("key-1");
  });

  it.each([
    ["an unknown or revoked key", null],
    ["a key whose owner is gone", null],
  ])("refuses %s", async (_label, resolved) => {
    resolveApiKey.mockResolvedValue(resolved);
    const { server, seen } = app();

    const res = await withKey(server);

    expect(res.status).toBe(401);
    expect(seen.reached).toBe(false);
    expect(userClient).not.toHaveBeenCalled();
  });

  it("refuses a key on a deployment that cannot sign a token for it", async () => {
    const { server, seen } = app();

    const res = await withKey(server, ENV);

    expect(res.status).toBe(401);
    expect(seen.reached).toBe(false);
    // Not even looked up: without a secret there is nothing to do with a hit.
    expect(resolveApiKey).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toEqual({
      error: "api keys are not enabled on this deployment",
    });
  });

  it("records the use after the response rather than before it", async () => {
    resolveApiKey.mockResolvedValue(RESOLVED);
    const { server } = app();

    await withKey(server);

    expect(touchApiKey).toHaveBeenCalledWith(KEYED_ENV, RESOLVED);
  });

  it("does not record a use for a key it refused", async () => {
    resolveApiKey.mockResolvedValue(null);
    const { server } = app();

    await withKey(server);

    expect(touchApiKey).not.toHaveBeenCalled();
  });
});
