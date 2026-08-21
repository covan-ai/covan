import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import type { MeDTO } from "../lib/dto";
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

const USER_ID = "user-1";

function appWithDb(db: unknown) {
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: USER_ID, email: "a@example.com" } as never);
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

type OnboardingRow = {
  completed_at: string | null;
  role: string | null;
  use_case: string | null;
  team_size: string | null;
  referral_source: string | null;
};

const WORKSPACE_ID = "ws-1";

/**
 * A fake for GET /me, which reads four tables. Kept separate from the PATCH
 * fake above rather than generalising it: a fake that accepts everything stops
 * being able to catch a route touching what it should not.
 *
 * The chains are the ones the route actually issues, including the two inside
 * getActiveWorkspaceId — which is why `profiles` answers both `single()` and
 * `maybeSingle()`, and why the `workspace_members` builder is awaitable *and*
 * chainable. Seeding `active_workspace_id` with a workspace the user is a
 * member of makes that helper return on its first check, so the fallback path
 * never runs here.
 */
function fakeReadDb(onboardingRow: OnboardingRow | null) {
  const db = {
    from(table: string) {
      switch (table) {
        case "profiles":
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: USER_ID, name: "Alice", avatar_url: null, email: "a@b.c" },
                  error: null,
                }),
                // getActiveWorkspaceId's first read.
                maybeSingle: async () => ({
                  data: { active_workspace_id: WORKSPACE_ID },
                  error: null,
                }),
              }),
              in: async () => ({
                data: [{ id: USER_ID, name: "Alice", email: "a@b.c", avatar_url: null }],
                error: null,
              }),
            }),
          };
        case "workspaces":
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: WORKSPACE_ID,
                    name: "Alice's Workspace",
                    slug: "alice-1",
                    default_model: null,
                  },
                  error: null,
                }),
              }),
            }),
          };
        case "workspace_members": {
          // Awaited directly for the member list, and chained through a second
          // eq() for the membership check. One builder serves both.
          const members = { data: [{ user_id: USER_ID, role: "admin" }], error: null };
          const builder = {
            eq: () => builder,
            maybeSingle: async () => ({ data: { workspace_id: WORKSPACE_ID }, error: null }),
            then: (resolve: (value: typeof members) => unknown) => resolve(members),
          };
          return { select: () => builder };
        }
        case "user_onboarding":
          return {
            select: () => ({
              eq: () => ({ maybeSingle: async () => ({ data: onboardingRow, error: null }) }),
            }),
          };
        default:
          throw new Error(`fakeReadDb: unexpected table "${table}"`);
      }
    },
  };
  return db;
}

const NO_ANSWERS = { role: null, use_case: null, team_size: null, referral_source: null };

/** `res.json()` is `unknown`; every assertion below is about the same field. */
const readOnboarding = async (res: Response): Promise<MeDTO["onboarding"]> =>
  ((await res.json()) as MeDTO).onboarding;

describe("GET /me onboarding state", () => {
  it("reports an unfinished first run when there is no row", async () => {
    const res = await appWithDb(fakeReadDb(null)).request("/me");
    const onboarding = await readOnboarding(res);

    expect(onboarding).toEqual({
      completed: false,
      answers: { role: null, useCase: null, teamSize: null, referralSource: null },
    });
  });

  it("reports an unfinished first run when the row has no stamp", async () => {
    const res = await appWithDb(fakeReadDb({ completed_at: null, ...NO_ANSWERS })).request("/me");
    const onboarding = await readOnboarding(res);

    expect(onboarding.completed).toBe(false);
  });

  it("reports a finished first run once stamped", async () => {
    const res = await appWithDb(
      fakeReadDb({ completed_at: "2026-01-01T00:00:00Z", ...NO_ANSWERS }),
    ).request("/me");
    const onboarding = await readOnboarding(res);

    expect(onboarding.completed).toBe(true);
  });

  it("hands back what was already answered, so a half-finished run can resume", async () => {
    const res = await appWithDb(
      fakeReadDb({
        completed_at: null,
        role: "design",
        use_case: null,
        team_size: null,
        referral_source: null,
      }),
    ).request("/me");
    const onboarding = await readOnboarding(res);

    expect(onboarding.answers).toEqual({
      role: "design",
      useCase: null,
      teamSize: null,
      referralSource: null,
    });
  });
});
