import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../types";
import { rateLimit } from "./ratelimit";
import { resetRateLimiters } from "../lib/ratelimit";

beforeEach(() => resetRateLimiters());

function appWith(env: Partial<Bindings>, before?: (c: never) => void) {
  const app = new Hono<AppEnv>();
  if (before) app.use("/*", async (c, next) => (before(c as never), next()));
  app.use("/*", rateLimit("expensive"));
  app.get("/thing", (c) => c.json({ ok: true }));
  return (headers: Record<string, string> = {}) =>
    app.request("/thing", { headers }, env as Bindings);
}

describe("the rate limit middleware", () => {
  it("answers 429 with Retry-After once the limit is spent", async () => {
    const request = appWith({ RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1" });

    expect((await request({ "CF-Connecting-IP": "1.1.1.1" })).status).toBe(200);

    const refused = await request({ "CF-Connecting-IP": "1.1.1.1" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
    expect(await refused.json()).toEqual({ error: "rate_limited" });
  });

  it("counts two addresses separately", async () => {
    const request = appWith({ RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1" });

    expect((await request({ "CF-Connecting-IP": "1.1.1.1" })).status).toBe(200);
    expect((await request({ "CF-Connecting-IP": "2.2.2.2" })).status).toBe(200);
    expect((await request({ "CF-Connecting-IP": "1.1.1.1" })).status).toBe(429);
  });

  it("counts by user rather than by address once there is a user", async () => {
    // The same person on two networks is one caller, and two people behind one
    // office address are two. Keying by address would get both backwards.
    const request = (() => {
      const app = new Hono<AppEnv>();
      app.use("/*", async (c, next) => {
        const id = c.req.header("X-Test-User");
        if (id) c.set("user", { id } as never);
        await next();
      });
      app.use("/*", rateLimit("expensive"));
      app.get("/thing", (c) => c.json({ ok: true }));
      return (headers: Record<string, string>) =>
        app.request("/thing", { headers }, {
          RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1",
        } as Bindings);
    })();

    expect((await request({ "X-Test-User": "alice", "CF-Connecting-IP": "1.1.1.1" })).status).toBe(
      200,
    );
    // Same address, different person: allowed.
    expect((await request({ "X-Test-User": "bob", "CF-Connecting-IP": "1.1.1.1" })).status).toBe(
      200,
    );
    // Same person, different address: refused.
    expect((await request({ "X-Test-User": "alice", "CF-Connecting-IP": "9.9.9.9" })).status).toBe(
      429,
    );
  });

  it("prefers CF-Connecting-IP over X-Forwarded-For, which a client can set", async () => {
    const request = appWith({ RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1" });

    await request({ "CF-Connecting-IP": "1.1.1.1", "X-Forwarded-For": "8.8.8.8" });
    // A caller who has spent their allowance cannot buy another by claiming a
    // different forwarded address.
    expect(
      (await request({ "CF-Connecting-IP": "1.1.1.1", "X-Forwarded-For": "7.7.7.7" })).status,
    ).toBe(429);
  });

  it("takes the first entry of X-Forwarded-For when that is all there is", async () => {
    const request = appWith({ RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1" });

    expect((await request({ "X-Forwarded-For": "3.3.3.3, 10.0.0.1" })).status).toBe(200);
    expect((await request({ "X-Forwarded-For": "3.3.3.3, 10.0.0.9" })).status).toBe(429);
  });

  it("counts an unattributable request rather than waving it through", async () => {
    // Otherwise "send no address" is the way around the limit.
    const request = appWith({ RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1" });

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
  });
});
