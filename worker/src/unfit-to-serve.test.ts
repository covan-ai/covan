import { describe, expect, it, vi } from "vitest";
import handler from "./index";
import { unfitToServe } from "./lib/env";
import type { Bindings } from "./types";

/**
 * Node refuses to start with a key `.env.docker.example` publishes; the Worker
 * had no start to refuse, so a Cloudflare deploy configured from that file
 * served with keys anybody can read on GitHub.
 */
const DEMO_ROUTINE_KEY = "Y292YW4tbG9jYWwtZGV2LXJvdXRpbmUta2V5LTAwMDE=";
const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe("a Worker configured from the published example", () => {
  it("refuses every request, and says why only in the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = {
      ALLOWED_ORIGIN: "https://covan.example.com",
      ROUTINE_SECRET_KEY: DEMO_ROUTINE_KEY,
    } as Bindings;

    const res = await handler.fetch(new Request("https://api.example.com/health"), env, ctx);

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "misconfigured" });
    expect(String(log.mock.calls[0]?.[0])).toMatch(/ROUTINE_SECRET_KEY/);
    log.mockRestore();
  });

  it("serves a laptop that uses them, which is what they are for", async () => {
    const env = {
      ALLOWED_ORIGIN: "http://localhost:3000",
      ROUTINE_SECRET_KEY: DEMO_ROUTINE_KEY,
    } as Bindings;
    const res = await handler.fetch(new Request("https://api.example.com/health"), env, ctx);
    expect(res.status).toBe(200);
  });

  it("refuses a signing key too short to be one", () => {
    expect(
      unfitToServe({ ALLOWED_ORIGIN: "https://covan.example.com", SUPABASE_JWT_SECRET: "short" }),
    ).toMatch(/at least 32/);
  });
});
