import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "../types";
import { requestId, requestIdFor } from "./request-id";

function app() {
  const a = new Hono<AppEnv>();
  a.use("/*", requestId);
  a.get("/ok", (c) => c.json({ ok: true, id: c.get("requestId") }));
  a.get("/broken", (c) => c.json({ error: "failed to load agents" }, 500));
  a.get("/text", (c) => c.text("nope", 502));
  a.get("/throws", () => {
    throw new Error("boom");
  });
  return a;
}

describe("requestIdFor", () => {
  it("quotes Cloudflare's ray when there is one, and mints an id when not", () => {
    expect(requestIdFor("8f1c2a3b4c5d6e7f-IST")).toBe("8f1c2a3b4c5d6e7f-IST");
    expect(requestIdFor(undefined)).toMatch(/^[0-9a-f-]{36}$/);
    // Anything that does not look like a ray is not echoed back.
    expect(requestIdFor("<script>")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("requestId middleware", () => {
  it("names the request on every response", async () => {
    const res = await app().request("/ok", { headers: { "cf-ray": "abcdef12345678-AMS" } });
    expect(res.headers.get("X-Request-Id")).toBe("abcdef12345678-AMS");
    expect(await res.json()).toEqual({ ok: true, id: "abcdef12345678-AMS" });
  });

  it("puts the id into a 5xx JSON body", async () => {
    const res = await app().request("/broken");
    const id = res.headers.get("X-Request-Id");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "failed to load agents", requestId: id });
  });

  it("leaves a body that is not JSON alone and still sets the header", async () => {
    const res = await app().request("/text");
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("nope");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("names a request that threw", async () => {
    const res = await app().request("/throws");
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });
});
