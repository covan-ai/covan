import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { me } from "./me";

/**
 * Stands in for the request-scoped Supabase client. `PATCH /me` only ever
 * touches `profiles`, so anything else is a mistake worth failing on.
 */
function fakeDb(result: { rows: unknown[] | null; error: { message: string } | null }) {
  const updates: unknown[] = [];
  const filters: Array<[string, unknown]> = [];
  const db = {
    from(table: string) {
      if (table !== "profiles") throw new Error(`fakeDb: unexpected table "${table}"`);
      return {
        update(values: unknown) {
          updates.push(values);
          return {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return {
                select: async () => ({ data: result.rows, error: result.error }),
              };
            },
          };
        },
      };
    },
  };
  return { db, updates, filters };
}

function appWithDb(db: unknown) {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: "user-1", email: "a@example.com" } as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", me);
  return app;
}

const patch = (app: Hono<AppEnv>, body: unknown) =>
  app.request("/me", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PATCH /me", () => {
  it("saves a trimmed name and returns the updated profile", async () => {
    const { db, updates } = fakeDb({
      rows: [{ id: "user-1", name: "Efe", email: "a@example.com", avatar_url: null }],
      error: null,
    });

    const res = await patch(appWithDb(db), { name: "  Efe  " });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ id: "user-1", name: "Efe" });
    expect(updates).toEqual([{ name: "Efe" }]);
  });

  // The handler never decides whose row this is — it filters on the
  // authenticated id and lets `profiles_update_own` enforce it in Postgres.
  it("scopes the update to the caller's own row", async () => {
    const { db, filters } = fakeDb({
      rows: [{ id: "user-1", name: "Efe", email: null, avatar_url: null }],
      error: null,
    });

    await patch(appWithDb(db), { name: "Efe" });

    expect(filters).toEqual([["id", "user-1"]]);
  });

  // Zero rows back means row level security refused the write. Reporting that
  // as success would show the new name until the next reload and then lose it.
  it("does not report success when the update matches no row", async () => {
    const { db } = fakeDb({ rows: [], error: null });

    const res = await patch(appWithDb(db), { name: "Efe" });

    expect(res.status).toBe(500);
  });

  it("rejects an empty or oversized name without touching the database", async () => {
    const { db, updates } = fakeDb({ rows: [], error: null });
    const app = appWithDb(db);

    expect((await patch(app, { name: "   " })).status).toBe(400);
    expect((await patch(app, { name: "x".repeat(81) })).status).toBe(400);
    expect((await patch(app, {})).status).toBe(400);
    expect(updates).toEqual([]);
  });
});
