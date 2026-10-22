import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { account } from "./account";

/** Settings › Security's sign-ins (0128): the caller's own, and nobody else's. */

function appWith(rpc: Record<string, (args?: Record<string, unknown>) => unknown>, key = false) {
  const db = {
    async rpc(name: string, args?: Record<string, unknown>) {
      const handler = rpc[name];
      if (!handler) throw new Error(`unexpected rpc ${name}`);
      return handler(args);
    },
  };
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: "u1", email: "mina@acme.test" } as never);
    c.set("db", db as never);
    if (key) c.set("apiKeyId", "key-1");
    await next();
  });
  app.route("/", account);
  return app;
}

describe("GET /account/sessions", () => {
  it("names each sign-in by device and browser, and which one is this", async () => {
    const app = appWith({
      my_sessions: () => ({
        data: [
          {
            id: "s1",
            user_agent:
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            created_at: "2026-10-01T00:00:00Z",
            last_seen_at: "2026-10-22T09:00:00Z",
            current: true,
          },
        ],
        error: null,
      }),
    });
    expect(await (await app.request("/account/sessions")).json()).toEqual([
      {
        id: "s1",
        device: "Windows",
        browser: "Chrome",
        current: true,
        createdAt: Date.parse("2026-10-01T00:00:00Z"),
        lastSeenAt: Date.parse("2026-10-22T09:00:00Z"),
      },
    ]);
  });
});

describe("DELETE /account/sessions/:id", () => {
  it("signs another device out, and says when there was no such session", async () => {
    const asked: unknown[] = [];
    const ok = appWith({
      revoke_my_session: (args) => {
        asked.push(args);
        return { data: true, error: null };
      },
    });
    expect((await ok.request("/account/sessions/s2", { method: "DELETE" })).status).toBe(200);
    expect(asked).toEqual([{ p_session_id: "s2" }]);

    const none = appWith({ revoke_my_session: () => ({ data: false, error: null }) });
    expect((await none.request("/account/sessions/s9", { method: "DELETE" })).status).toBe(404);
  });

  it("will not sign out the session that is asking, or answer a key", async () => {
    const self = appWith({
      revoke_my_session: () => ({
        data: null,
        error: { code: "22023", message: "sign out of this device from the account menu" },
      }),
    });
    expect((await self.request("/account/sessions/s1", { method: "DELETE" })).status).toBe(400);
    const keyed = appWith({}, true);
    expect((await keyed.request("/account/sessions/s1", { method: "DELETE" })).status).toBe(403);
  });
});

describe("GET /account/identities", () => {
  it("lists the providers this account signs in with", async () => {
    const app = appWith({
      my_identities: () => ({
        data: [
          {
            provider: "google",
            email: "mina@acme.test",
            created_at: "2026-08-01T00:00:00Z",
            last_sign_in_at: null,
          },
        ],
        error: null,
      }),
    });
    expect(await (await app.request("/account/identities")).json()).toEqual([
      {
        provider: "google",
        email: "mina@acme.test",
        connectedAt: Date.parse("2026-08-01T00:00:00Z"),
        lastSignInAt: null,
      },
    ]);
  });
});
