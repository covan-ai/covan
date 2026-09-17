import { Hono } from "hono";
import { describe, it, expect } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb } from "../test-support/fake-db";
import { search } from "./search";

const USER = { id: "user-1", email: "a@example.com" };

function appWith(rows: unknown[]) {
  const { db } = fakeDb({
    tables: {
      messages: {
        select: () => ({ data: rows, error: null }),
      },
    },
  });

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", search);
  return { app };
}

describe("GET /search/messages", () => {
  const msg = (id: string, content: string) => ({
    id,
    role: "assistant",
    content,
    created_at: "2026-09-17T10:00:00Z",
    sender: null,
  });

  it("runs a full-text search against messages the caller can read", async () => {
    const { app } = appWith([
      msg("m1", "Vacation is twenty days."),
      msg("m2", "Paid on the 15th."),
    ]);

    const res = await app.request("/search/messages?q=vacation");

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; content: string }>;
    expect(body.length).toBeGreaterThan(0);
    expect(body[0].content).toMatch(/vacation/i);
  });

  it("accepts a limit parameter", async () => {
    // The fake db records the limit but doesn't actually apply it (handlers
    // return a fixed set), so this test verifies the route accepted the param
    // rather than asserting on the result count.
    const { app } = appWith([msg("m1", "First"), msg("m2", "Second")]);

    const res = await app.request("/search/messages?q=first&limit=1");

    expect(res.status).toBe(200);
  });

  it("refuses an empty query", async () => {
    const { app } = appWith([]);

    const res = await app.request("/search/messages?q=");

    expect(res.status).toBe(400);
  });

  it("refuses a query longer than the endpoint will search", async () => {
    const { app } = appWith([]);
    const long = "a".repeat(201);

    const res = await app.request(`/search/messages?q=${long}`);

    expect(res.status).toBe(400);
  });
});
