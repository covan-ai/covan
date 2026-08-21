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

const { authMiddleware } = await import("./auth");

/** Records what the middleware put on the context, if it let the request past. */
function app() {
  const seen: { user?: unknown; db?: unknown; reached: boolean } = { reached: false };

  const server = new Hono<AppEnv>();
  server.use("/*", authMiddleware);
  server.get("/probe", (c) => {
    seen.reached = true;
    seen.user = c.get("user");
    seen.db = c.get("db");
    return c.json({ ok: true });
  });

  return { server, seen };
}

/** Stands in for the Worker bindings; only its identity is asserted on. */
const ENV = { SUPABASE_URL: "https://example.supabase.co" };

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
