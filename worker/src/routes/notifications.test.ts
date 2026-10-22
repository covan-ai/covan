import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type QueryContext } from "../test-support/fake-db";
import { notifications } from "./notifications";

/** The caller's own switches, the three 0128 added among them. */

const USER = { id: "u1", email: "mina@acme.test" };

function appWith(row: Record<string, unknown> | null) {
  const { db, callsTo } = fakeDb({
    tables: {
      notification_preferences: {
        select: () => ({ data: row, error: null }),
        insert: (ctx: QueryContext) => ({
          data: {
            routine_paused: true,
            quota_exhausted: true,
            needs_me_away: true,
            routine_failed: true,
            weekly_summary: false,
            ...ctx.values,
          },
          error: null,
        }),
      },
    },
  });
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", notifications);
  return { app, callsTo };
}

describe("notification preferences", () => {
  it("answers the defaults when nothing was ever changed: away and failures on, summary off", async () => {
    const { app } = appWith(null);
    expect(await (await app.request("/notification-preferences")).json()).toEqual({
      routinePaused: true,
      quotaExhausted: true,
      needsMeAway: true,
      routineFailed: true,
      weeklySummary: false,
    });
  });

  it("saves the three new switches as the caller's own row", async () => {
    const { app, callsTo } = appWith(null);
    const res = await app.request("/notification-preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ needsMeAway: false, weeklySummary: true }),
    });
    expect(await res.json()).toMatchObject({ needsMeAway: false, weeklySummary: true });
    expect(callsTo("notification_preferences")[0]!.values).toMatchObject({
      user_id: "u1",
      needs_me_away: false,
      weekly_summary: true,
    });
  });
});
