import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { onboarding } from "./onboarding";

const USER = { id: "user-1", email: "a@b.c" };

/**
 * Stands in for the request-scoped Supabase client. These two routes only ever
 * touch `user_onboarding`, so anything else is a mistake worth failing on.
 */
function fakeDb(result: {
  row: Record<string, unknown> | null;
  error: { message: string } | null;
}) {
  const upserts: unknown[] = [];
  const selects: string[] = [];
  const db = {
    from(table: string) {
      if (table !== "user_onboarding") throw new Error(`fakeDb: unexpected table "${table}"`);
      return {
        upsert(values: unknown) {
          upserts.push(values);
          return {
            select: () => ({
              maybeSingle: async () => ({ data: result.row, error: result.error }),
            }),
          };
        },
        select(columns: string) {
          selects.push(columns);
          return {
            eq: () => ({
              maybeSingle: async () => ({ data: result.row, error: result.error }),
            }),
          };
        },
      };
    },
  };
  return { db, upserts, selects };
}

function appWithDb(db: unknown) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", USER as never);
    await next();
  });
  app.route("/", onboarding);
  return app;
}

const MAIL_ENV = {
  RESEND_API_KEY: "re_test",
  RESEND_FROM: "Covan <hello@covan.test>",
  ALLOWED_ORIGIN: "https://covan.test",
};

/**
 * What reached Resend. Every one of these sends is deferred past the response,
 * so the assertions read the request body rather than a return value — there is
 * nothing for the route to return about a message it did not wait for.
 */
function captureSends() {
  const calls: Array<Record<string, unknown>> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation((async (_input: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch);
  return { calls };
}

afterEach(() => {
  vi.restoreAllMocks();
});

function patch(app: Hono<AppEnv>, body: unknown) {
  return app.request("/onboarding", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /onboarding", () => {
  it("stores a recognised answer", async () => {
    const { db, upserts } = fakeDb({
      row: { role: "engineering", use_case: null, team_size: null, referral_source: null },
      error: null,
    });
    const res = await patch(appWithDb(db), { role: "engineering" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      role: "engineering",
      useCase: null,
      teamSize: null,
      referralSource: null,
    });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ user_id: USER.id, role: "engineering" });
  });

  it("takes the user id from the token, not the body", async () => {
    const { db, upserts } = fakeDb({
      row: { role: "sales", use_case: null, team_size: null, referral_source: null },
      error: null,
    });
    await patch(appWithDb(db), { role: "sales", user_id: "somebody-else" });

    expect(upserts[0]).toMatchObject({ user_id: USER.id });
  });

  it("refuses an answer that is not on the list", async () => {
    const { db, upserts } = fakeDb({ row: null, error: null });
    const res = await patch(appWithDb(db), { role: "astronaut" });

    expect(res.status).toBe(400);
    expect(upserts).toEqual([]);
  });

  it("refuses an empty body", async () => {
    const { db } = fakeDb({ row: null, error: null });
    expect((await patch(appWithDb(db), {})).status).toBe(400);
  });

  it("reports a refused write as a failure, not a save", async () => {
    // An upsert that RLS refuses comes back with no row. Reporting success
    // there would tell the user their answer was kept when it was not.
    const { db } = fakeDb({ row: null, error: null });
    const res = await patch(appWithDb(db), { teamSize: "solo" });

    expect(res.status).toBe(500);
  });
});

describe("POST /onboarding/complete", () => {
  it("stamps completion", async () => {
    const { db, upserts } = fakeDb({ row: { completed_at: null }, error: null });
    const res = await appWithDb(db).request("/onboarding/complete", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ completed: true });
    expect(upserts[0]).toMatchObject({ user_id: USER.id });
    expect((upserts[0] as Record<string, unknown>).completed_at).toEqual(expect.any(String));
  });

  it("leaves an existing stamp alone when called twice", async () => {
    const existing = "2026-01-01T00:00:00.000Z";
    const { db, upserts } = fakeDb({ row: { completed_at: existing }, error: null });
    const res = await appWithDb(db).request("/onboarding/complete", { method: "POST" });

    expect(res.status).toBe(200);
    // The row already carried a stamp, so nothing was written over it.
    expect(upserts).toEqual([]);
  });

  /**
   * The welcome email.
   *
   * This route is the only moment the product knows a person has arrived.
   * Supabase sends the confirmation and nothing tells this Worker when it was
   * clicked, so "just after confirming" is not a hook we have — and finishing
   * the first run is the better moment anyway, because by then there is
   * something to say that is not just "hello".
   */
  it("welcomes somebody the first time they finish", async () => {
    const { db } = fakeDb({ row: { completed_at: null }, error: null });
    const sent = captureSends();

    const res = await appWithDb(db).request("/onboarding/complete", { method: "POST" }, MAIL_ENV);

    expect(res.status).toBe(200);
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0].to).toEqual([USER.email]);
    expect(String(sent.calls[0].subject)).toMatch(/covan/i);
  });

  // The route already refuses to re-stamp a finished onboarding. The email has
  // to follow that same guard, or every reload of the last step is another
  // welcome.
  it("does not welcome the same person twice", async () => {
    const { db } = fakeDb({ row: { completed_at: "2026-01-01T00:00:00.000Z" }, error: null });
    const sent = captureSends();

    await appWithDb(db).request("/onboarding/complete", { method: "POST" }, MAIL_ENV);

    expect(sent.calls).toEqual([]);
  });

  // Mail is optional configuration, not a dependency: a self-hosted Covan with
  // no Resend keys still finishes onboarding.
  it("finishes onboarding when no mail is configured", async () => {
    const { db } = fakeDb({ row: { completed_at: null }, error: null });
    const sent = captureSends();

    const res = await appWithDb(db).request("/onboarding/complete", { method: "POST" });

    expect(res.status).toBe(200);
    expect(sent.calls).toEqual([]);
  });
});
