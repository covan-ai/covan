import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../types";
import { countMiss, hasSpentMisses, rateLimit, refuseSpent, resetMisses } from "./ratelimit";
import { getRateLimiter, resetRateLimiters, userRateKey } from "../lib/ratelimit";

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

  it("ignores X-Forwarded-For on Cloudflare, where the edge says who is calling", async () => {
    const request = appWith({ RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1" });

    expect((await request({ "X-Forwarded-For": "3.3.3.3" })).status).toBe(200);
    // A different claim is not a different caller.
    expect((await request({ "X-Forwarded-For": "4.4.4.4" })).status).toBe(429);
  });

  it("counts an unattributable request rather than waving it through", async () => {
    // Otherwise "send no address" is the way around the limit.
    const request = appWith({ RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1" });

    expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
  });
});

describe("the caller's address on Node", () => {
  // `node.ts` sets PEER_ADDR on every request; its presence is what says
  // "there is no Cloudflare edge in front of this".
  const node = (extra: Partial<Bindings> = {}) =>
    appWith({ RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1", PEER_ADDR: "198.51.100.1", ...extra });

  it("does not believe a client's CF-Connecting-IP", async () => {
    // A fresh header on every request was a fresh
    // allowance, 130 of 130 allowed.
    const request = node();

    expect((await request({ "CF-Connecting-IP": "1.0.0.1" })).status).toBe(200);
    expect((await request({ "CF-Connecting-IP": "1.0.0.2" })).status).toBe(429);
  });

  it("does not believe X-Forwarded-For without TRUST_PROXY", async () => {
    const request = node();

    expect((await request({ "X-Forwarded-For": "1.0.0.1" })).status).toBe(200);
    expect((await request({ "X-Forwarded-For": "1.0.0.2" })).status).toBe(429);
  });

  it("takes the address the trusted proxy appended, not the client's claim", async () => {
    const request = node({ TRUST_PROXY: "1" });

    // client claimed 6.6.6.6; the proxy appended the real 203.0.113.5
    expect((await request({ "X-Forwarded-For": "6.6.6.6, 203.0.113.5" })).status).toBe(200);
    expect((await request({ "X-Forwarded-For": "7.7.7.7, 203.0.113.5" })).status).toBe(429);
    // A different real caller behind the same proxy has their own allowance.
    expect((await request({ "X-Forwarded-For": "6.6.6.6, 203.0.113.6" })).status).toBe(200);
  });

  it("counts hops from the right when there is more than one proxy", async () => {
    const request = node({ TRUST_PROXY: "2" });

    expect((await request({ "X-Forwarded-For": "6.6.6.6, 203.0.113.5, 10.0.0.2" })).status).toBe(
      200,
    );
    expect((await request({ "X-Forwarded-For": "9.9.9.9, 203.0.113.5, 10.0.0.3" })).status).toBe(
      429,
    );
  });

  it("treats a TRUST_PROXY that is not a whole number as none", async () => {
    const request = node({ TRUST_PROXY: "yes" });

    expect((await request({ "X-Forwarded-For": "1.0.0.1" })).status).toBe(200);
    expect((await request({ "X-Forwarded-For": "1.0.0.2" })).status).toBe(429);
  });
});

describe("one person, one bucket", () => {
  it("is the same bucket the middleware counts a signed-in caller in", async () => {
    const env = { RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1" } as Bindings;
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => (c.set("user", { id: "alice" } as never), next()));
    app.use("/*", rateLimit("expensive"));
    app.get("/thing", (c) => c.json({ ok: true }));

    expect((await app.request("/thing", {}, env)).status).toBe(200);
    // What the Slack handler asks, for the same person.
    const verdict = await getRateLimiter(env, "expensive").check(userRateKey("expensive", "alice"));
    expect(verdict.allowed).toBe(false);
  });
});

describe("failed proofs at the doors in front of the limit", () => {
  beforeEach(() => resetMisses());

  function door(env: Partial<Bindings>) {
    const app = new Hono<AppEnv>();
    app.post("/door", async (c) => {
      if (hasSpentMisses(c)) return refuseSpent(c);
      if (c.req.header("X-Proof") !== "ok") {
        await countMiss(c);
        return c.json({ error: "unauthorized" }, 401);
      }
      return c.json({ ok: true });
    });
    return (headers: Record<string, string>) =>
      app.request("/door", { method: "POST", headers }, env as Bindings);
  }

  it("refuses an address once its failures are spent, before the next proof is read", async () => {
    const request = door({ RATE_LIMIT_STANDARD_PER_MINUTE: "1" });
    const from = { "CF-Connecting-IP": "203.0.113.1" };

    expect((await request(from)).status).toBe(401);
    expect((await request(from)).status).toBe(401);
    const refused = await request({ ...from, "X-Proof": "ok" });
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
  });

  it("charges nothing for proofs that verify", async () => {
    const request = door({ RATE_LIMIT_STANDARD_PER_MINUTE: "1" });
    const from = { "CF-Connecting-IP": "203.0.113.2", "X-Proof": "ok" };

    for (let i = 0; i < 5; i++) expect((await request(from)).status).toBe(200);
  });
});
