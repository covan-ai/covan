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

  it("writes only the fields the body carries", async () => {
    const { db, updates } = fakeDb({
      rows: [{ id: "user-1", name: "Efe", email: null, avatar_url: null, bio: "Hi." }],
      error: null,
    });

    const res = await patch(appWithDb(db), { bio: "  Hi.  " });

    expect(res.status).toBe(200);
    expect(updates).toEqual([{ bio: "Hi." }]);
    await expect(res.json()).resolves.toEqual({
      id: "user-1",
      name: "Efe",
      email: "a@example.com",
      avatarUrl: null,
      bio: "Hi.",
      locale: null,
      timezone: null,
    });
  });

  // An emptied textarea sends "", and the column's "nothing said" is null.
  it("clears a bio or a locale sent as an empty string", async () => {
    const { db, updates } = fakeDb({ rows: [{ id: "user-1" }], error: null });

    await patch(appWithDb(db), { bio: "   ", locale: "" });

    expect(updates).toEqual([{ bio: null, locale: null }]);
  });

  it("counts a bio in characters, not UTF-16 units", async () => {
    const { db, updates } = fakeDb({ rows: [{ id: "user-1" }], error: null });
    const app = appWithDb(db);

    // 280 emoji are 560 UTF-16 units and 280 characters to Postgres.
    expect((await patch(app, { bio: "😀".repeat(280) })).status).toBe(200);
    expect((await patch(app, { bio: "x".repeat(281) })).status).toBe(400);
    expect(updates).toHaveLength(1);
  });

  it("stores a time zone the way the runtime spells it", async () => {
    const { db, updates } = fakeDb({ rows: [{ id: "user-1" }], error: null });

    await patch(appWithDb(db), { timezone: "europe/istanbul" });

    expect(updates).toEqual([{ timezone: "Europe/Istanbul" }]);
  });

  it("clears a time zone sent as null", async () => {
    const { db, updates } = fakeDb({ rows: [{ id: "user-1" }], error: null });

    await patch(appWithDb(db), { timezone: null });

    expect(updates).toEqual([{ timezone: null }]);
  });

  it("refuses a time zone that does not exist without touching the database", async () => {
    const { db, updates } = fakeDb({ rows: [{ id: "user-1" }], error: null });
    const app = appWithDb(db);

    expect((await patch(app, { timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await patch(app, { timezone: "+03:00" })).status).toBe(400);
    expect(updates).toEqual([]);
  });

  it("accepts a language tag and refuses what is not one", async () => {
    const { db, updates } = fakeDb({ rows: [{ id: "user-1" }], error: null });
    const app = appWithDb(db);

    expect((await patch(app, { locale: "tr-TR" })).status).toBe(200);
    expect((await patch(app, { locale: "Turkish" })).status).toBe(400);
    expect(updates).toEqual([{ locale: "tr-TR" }]);
  });

  // `email` belongs to GoTrue and the 0082 trigger, `avatar_url` to the avatar
  // routes. Refused by name, so a client sending them learns it is wrong
  // instead of seeing a 200 that changed nothing.
  it("refuses fields it does not own", async () => {
    const { db, updates } = fakeDb({ rows: [{ id: "user-1" }], error: null });
    const app = appWithDb(db);

    expect((await patch(app, { email: "b@example.com" })).status).toBe(400);
    expect((await patch(app, { avatar_url: "https://example.com/a.png" })).status).toBe(400);
    expect((await patch(app, { name: "Efe", email: "b@example.com" })).status).toBe(400);
    expect(updates).toEqual([]);
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
  assistant_name?: string | null;
  assistant_emoji?: string | null;
  tools?: string[] | null;
  purpose?: string | null;
  mode?: string | null;
  last_step?: string | null;
  agent_id?: string | null;
  session_id?: string | null;
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
 *
 * `gapReportEnabled` defaults to `false` — the column's own default — and only
 * the "GET /me workspace" tests below pass anything else; every onboarding
 * test keeps its original, unparameterised call.
 */
function fakeReadDb(onboardingRow: OnboardingRow | null, gapReportEnabled = false) {
  const db = {
    from(table: string) {
      switch (table) {
        case "profiles":
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: {
                    id: USER_ID,
                    name: "Alice",
                    avatar_url: null,
                    email: "a@b.c",
                    bio: "Runs support.",
                    locale: "tr-TR",
                    timezone: "Europe/Istanbul",
                  },
                  error: null,
                }),
                // getActiveWorkspaceId's first read.
                maybeSingle: async () => ({
                  data: { active_workspace_id: WORKSPACE_ID },
                  error: null,
                }),
              }),
              // What the route asks for: no `locale`, so none comes back.
              in: async () => ({
                data: [
                  {
                    id: USER_ID,
                    name: "Alice",
                    email: "a@b.c",
                    avatar_url: null,
                    bio: "Runs support.",
                    timezone: "Europe/Istanbul",
                  },
                ],
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
                    gap_report_enabled: gapReportEnabled,
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
      lastStep: null,
      agentId: null,
      sessionId: null,
      answers: {
        role: null,
        useCase: null,
        teamSize: null,
        referralSource: null,
        assistantName: null,
        assistantEmoji: null,
        assistantRole: null,
        tools: null,
        purpose: null,
        mode: null,
      },
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

    expect(onboarding.answers).toMatchObject({
      role: "design",
      useCase: null,
      teamSize: null,
      referralSource: null,
    });
  });

  // What the new run (0119) leaves behind rides along too: the screen that was
  // open, and the agent and conversation the finish made.
  it("hands back where the new run stopped and what it made", async () => {
    const res = await appWithDb(
      fakeReadDb({
        completed_at: "2026-01-01T00:00:00Z",
        ...NO_ANSWERS,
        assistant_name: "Desk",
        assistant_emoji: "🧭",
        tools: ["gmail"],
        purpose: "sales",
        mode: "solo",
        last_step: "done",
        agent_id: "agent-1",
        session_id: "session-1",
      }),
    ).request("/me");
    const onboarding = await readOnboarding(res);

    expect(onboarding).toMatchObject({
      completed: true,
      lastStep: "done",
      agentId: "agent-1",
      sessionId: "session-1",
      answers: {
        assistantName: "Desk",
        assistantEmoji: "🧭",
        tools: ["gmail"],
        purpose: "sales",
        mode: "solo",
      },
    });
  });
});

describe("GET /me workspace", () => {
  it("carries the coverage report's switch", async () => {
    const res = await appWithDb(fakeReadDb(null, true)).request("/me");
    const body = (await res.json()) as MeDTO;

    expect(body.workspace.gapReportEnabled).toBe(true);
  });

  // The column's own default (0076) — a workspace that has never touched the
  // switch must not be reported as having turned the report on.
  it("defaults to false", async () => {
    const res = await appWithDb(fakeReadDb(null, false)).request("/me");
    const body = (await res.json()) as MeDTO;

    expect(body.workspace.gapReportEnabled).toBe(false);
  });
});

describe("GET /me profile", () => {
  it("carries the caller's bio, locale and timezone", async () => {
    const res = await appWithDb(fakeReadDb(null)).request("/me");
    const body = (await res.json()) as MeDTO;

    expect(body.user).toEqual({
      id: USER_ID,
      name: "Alice",
      email: "a@example.com",
      avatarUrl: null,
      bio: "Runs support.",
      locale: "tr-TR",
      timezone: "Europe/Istanbul",
    });
  });

  // A co-member's sentence and clock are for the team; their locale is a
  // display preference of their own and is not on anybody else's copy.
  it("carries a member's bio and timezone but not their locale", async () => {
    const res = await appWithDb(fakeReadDb(null)).request("/me");
    const body = (await res.json()) as MeDTO;

    expect(body.members[0]).toMatchObject({ bio: "Runs support.", timezone: "Europe/Istanbul" });
    expect(body.members[0]).not.toHaveProperty("locale");
  });
});
