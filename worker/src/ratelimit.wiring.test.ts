import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { app } from "./index";
import type { AppEnv, Bindings } from "./types";
import { rateLimit } from "./middleware/ratelimit";
import { resetRateLimiters } from "./lib/ratelimit";

/**
 * The static test asserts index.ts *says* the right thing. This asserts the
 * request actually goes through it — the two failures it cannot see are a
 * middleware mounted somewhere it never runs, and a path pattern that matches
 * nothing.
 */

const env = {
  ALLOWED_ORIGIN: "http://localhost:3000",
  RATE_LIMIT_STANDARD_PER_MINUTE: "2",
} as Bindings;

beforeEach(() => resetRateLimiters());

describe("the limiter as the app actually mounts it", () => {
  it("stands in front of an unauthenticated route", async () => {
    const call = () => app.request("/health", { headers: { "CF-Connecting-IP": "5.5.5.5" } }, env);

    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);

    const refused = await call();
    expect(refused.status).toBe(429);
    expect(refused.headers.get("Retry-After")).toBe("60");
  });

  it("does not count the CORS preflight", async () => {
    // cors() answers OPTIONS and returns before the limiter. If that order ever
    // flips, a preflight can be refused — and a browser reports a 429 on a
    // preflight as a CORS failure, which is the least legible way this could
    // break.
    const preflight = () =>
      app.request(
        "/health",
        {
          method: "OPTIONS",
          headers: {
            Origin: "http://localhost:3000",
            "Access-Control-Request-Method": "GET",
            "CF-Connecting-IP": "6.6.6.6",
          },
        },
        env,
      );

    for (let i = 0; i < 5; i++) {
      expect((await preflight()).status).not.toBe(429);
    }
  });

  it("matches a path with a parameter in it, which is how /routines/:id/run is mounted", async () => {
    // Hono's `use` takes the same patterns as a route. If it did not, that mount
    // would silently protect nothing, and every test above would still pass.
    const probe = new Hono<AppEnv>();
    probe.use("/routines/:id/run", rateLimit("expensive"));
    probe.post("/routines/:id/run", (c) => c.json({ ok: true }));
    probe.post("/routines/:id", (c) => c.json({ ok: true }));

    const e = { RATE_LIMIT_EXPENSIVE_PER_MINUTE: "1" } as Bindings;
    const headers = { "CF-Connecting-IP": "7.7.7.7" };

    expect((await probe.request("/routines/abc/run", { method: "POST", headers }, e)).status).toBe(
      200,
    );
    expect((await probe.request("/routines/xyz/run", { method: "POST", headers }, e)).status).toBe(
      429,
    );
    // And does not spill onto the sibling route it must not cover.
    expect((await probe.request("/routines/abc", { method: "POST", headers }, e)).status).toBe(200);
  });
});
