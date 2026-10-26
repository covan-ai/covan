import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import type { OnboardingDTO } from "../lib/dto";
import {
  activeWorkspaceTables,
  fakeDb as strictDb,
  type QueryContext,
} from "../test-support/fake-db";
import { onboarding } from "./onboarding";

const USER = { id: "user-1", email: "a@b.c" };
const WORKSPACE_ID = "ws-1";

/**
 * Stands in for the request-scoped Supabase client for the routes that only
 * ever touch `user_onboarding`: GET, PATCH and /complete. Anything else is a
 * mistake worth failing on. The finish and events routes reach further and
 * use the strict fake from test-support below.
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

function appWithDb(db: unknown, opts: { apiKeyId?: string } = {}) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", USER as never);
    if (opts.apiKeyId) c.set("apiKeyId", opts.apiKeyId as never);
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

function post(app: Hono<AppEnv>, path: string, body?: unknown, env?: Record<string, string>) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}

/** The DTO for a row that has answered nothing, with whatever is different. */
function dto(
  overrides: Partial<Omit<OnboardingDTO, "answers">> & {
    answers?: Partial<OnboardingDTO["answers"]>;
  } = {},
): OnboardingDTO {
  const { answers, ...rest } = overrides;
  return {
    completed: false,
    lastStep: null,
    agentId: null,
    sessionId: null,
    ...rest,
    answers: {
      role: null,
      useCase: null,
      teamSize: null,
      referralSource: null,
      assistantName: null,
      assistantEmoji: null,
      assistantRole: null,
      assistantAvatar: null,
      assistantJobs: null,
      tools: null,
      purpose: null,
      mode: null,
      ...answers,
    },
  };
}

describe("GET /onboarding", () => {
  // The one reader /me cannot serve: an account with no workspace yet (0115).
  it("answers the caller's own answers and whether they finished", async () => {
    const { db } = fakeDb({
      row: {
        completed_at: null,
        role: "engineering",
        use_case: "code",
        team_size: "2-10",
        referral_source: null,
        assistant_name: "Desk",
        assistant_emoji: "🧭",
        assistant_role: "desk",
        tools: ["gmail", "notion"],
        purpose: "operations",
        mode: "team",
        last_step: "team",
        agent_id: null,
        session_id: null,
      },
      error: null,
    });

    const res = await appWithDb(db).request("/onboarding");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(
      dto({
        lastStep: "team",
        answers: {
          role: "engineering",
          useCase: "code",
          teamSize: "2-10",
          assistantName: "Desk",
          assistantEmoji: "🧭",
          assistantRole: "desk",
          tools: ["gmail", "notion"],
          purpose: "operations",
          mode: "team",
        },
      }),
    );
  });

  it("answers an empty survey for somebody who has not started it", async () => {
    const { db } = fakeDb({ row: null, error: null });

    const res = await appWithDb(db).request("/onboarding");

    await expect(res.json()).resolves.toEqual(dto());
  });

  // What the finish made rides along, so the app can find the conversation
  // the assistant opened in after a reload.
  it("carries the agent and session the finish made", async () => {
    const { db } = fakeDb({
      row: {
        completed_at: "2026-01-01T00:00:00.000Z",
        assistant_name: "Desk",
        agent_id: "agent-1",
        session_id: "session-1",
        last_step: "done",
      },
      error: null,
    });

    const body = (await (await appWithDb(db).request("/onboarding")).json()) as OnboardingDTO;

    expect(body).toMatchObject({
      completed: true,
      agentId: "agent-1",
      sessionId: "session-1",
      lastStep: "done",
    });
  });

  it("reports a read that failed", async () => {
    const { db } = fakeDb({ row: null, error: { message: "boom" } });

    const res = await appWithDb(db).request("/onboarding");

    expect(res.status).toBe(500);
  });
});

describe("PATCH /onboarding", () => {
  it("stores a recognised answer and hands back the whole state", async () => {
    const { db, upserts } = fakeDb({
      row: { role: "engineering" },
      error: null,
    });
    const res = await patch(appWithDb(db), { role: "engineering" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(dto({ answers: { role: "engineering" } }));
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ user_id: USER.id, role: "engineering" });
  });

  it("stores the first agent's mark and jobs, repeats dropped (0137)", async () => {
    const { db, upserts } = fakeDb({
      row: { assistant_avatar: "owl", assistant_jobs: ["answer-questions", "draft-replies"] },
      error: null,
    });
    const res = await patch(appWithDb(db), {
      assistantAvatar: "owl",
      assistantJobs: ["answer-questions", "draft-replies", "answer-questions"],
    });

    expect(res.status).toBe(200);
    expect(upserts[0]).toMatchObject({
      assistant_avatar: "owl",
      assistant_jobs: ["answer-questions", "draft-replies"],
    });
    expect(await res.json()).toEqual(
      dto({
        answers: {
          assistantAvatar: "owl",
          assistantJobs: ["answer-questions", "draft-replies"],
        },
      }),
    );
  });

  it("refuses a mark that is not one of the eight", async () => {
    const { db, upserts } = fakeDb({ row: null, error: null });
    expect((await patch(appWithDb(db), { assistantAvatar: "unicorn" })).status).toBe(400);
    expect(upserts).toEqual([]);
  });

  it("takes the user id from the token, not the body", async () => {
    const { db, upserts } = fakeDb({ row: { role: "sales" }, error: null });
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

  describe("the run that introduces itself", () => {
    it("stores every new answer under its own column", async () => {
      const { db, upserts } = fakeDb({ row: { assistant_name: "Desk" }, error: null });
      const res = await patch(appWithDb(db), {
        assistantName: "  Desk  ",
        assistantEmoji: "🧭",
        assistantRole: "desk",
        tools: ["gmail", "notion"],
        purpose: "operations",
        mode: "team",
        lastStep: "tools",
      });

      expect(res.status).toBe(200);
      expect(upserts[0]).toMatchObject({
        user_id: USER.id,
        assistant_name: "Desk",
        assistant_emoji: "🧭",
        assistant_role: "desk",
        tools: ["gmail", "notion"],
        purpose: "operations",
        mode: "team",
        last_step: "tools",
      });
    });

    // The order is the answer: `tools[0]` is what the assistant proposes first.
    it("deduplicates the tools and keeps their order", async () => {
      const { db, upserts } = fakeDb({ row: { tools: [] }, error: null });
      await patch(appWithDb(db), { tools: ["notion", "gmail", "notion", "slack", "gmail"] });

      expect((upserts[0] as Record<string, unknown>).tools).toEqual(["notion", "gmail", "slack"]);
    });

    it("keeps an empty tools list, which is a skip and not a gap", async () => {
      const { db, upserts } = fakeDb({ row: { tools: [] }, error: null });
      const res = await patch(appWithDb(db), { tools: [] });

      expect(res.status).toBe(200);
      expect((upserts[0] as Record<string, unknown>).tools).toEqual([]);
      expect(((await res.json()) as OnboardingDTO).answers.tools).toEqual([]);
    });

    it("refuses what a tool slug cannot be", async () => {
      const { db, upserts } = fakeDb({ row: null, error: null });
      const app = appWithDb(db);

      expect((await patch(app, { tools: ["Gmail"] })).status).toBe(400);
      expect((await patch(app, { tools: ["../etc"] })).status).toBe(400);
      expect((await patch(app, { tools: ["<img>"] })).status).toBe(400);
      expect(
        (await patch(app, { tools: Array.from({ length: 13 }, (_, i) => `t${i}`) })).status,
      ).toBe(400);
      expect(upserts).toEqual([]);
    });

    it("refuses a purpose, mode or step it does not know", async () => {
      const { db, upserts } = fakeDb({ row: null, error: null });
      const app = appWithDb(db);

      expect((await patch(app, { purpose: "world-domination" })).status).toBe(400);
      expect((await patch(app, { mode: "duo" })).status).toBe(400);
      expect((await patch(app, { lastStep: "Step One" })).status).toBe(400);
      expect(upserts).toEqual([]);
    });

    it("refuses a name that is blank or too long, and an emoji with spaces in it", async () => {
      const { db, upserts } = fakeDb({ row: null, error: null });
      const app = appWithDb(db);

      expect((await patch(app, { assistantName: "   " })).status).toBe(400);
      expect((await patch(app, { assistantName: "x".repeat(121) })).status).toBe(400);
      expect((await patch(app, { assistantEmoji: "a sentence" })).status).toBe(400);
      expect((await patch(app, { assistantEmoji: "" })).status).toBe(400);
      expect(upserts).toEqual([]);
    });

    // `intro:apps` is a step the frontend names; the colon has to pass.
    it("accepts a step id with a section prefix", async () => {
      const { db, upserts } = fakeDb({ row: { last_step: "intro:apps" }, error: null });
      const res = await patch(appWithDb(db), { lastStep: "intro:apps" });

      expect(res.status).toBe(200);
      expect(upserts[0]).toMatchObject({ last_step: "intro:apps" });
    });
  });
});

describe("POST /onboarding/events", () => {
  function eventsDb(result: { error: { message: string } | null } = { error: null }) {
    const inserted: Array<Record<string, unknown>[]> = [];
    const fake = strictDb({
      tables: {
        onboarding_events: {
          insert: (ctx: QueryContext) => {
            inserted.push(ctx.values as unknown as Record<string, unknown>[]);
            return { data: null, error: result.error };
          },
        },
      },
    });
    return { db: fake.db, inserted };
  }

  const AT = "2026-10-21T09:00:00.000Z";

  it("records a batch under the caller's own id", async () => {
    const { db, inserted } = eventsDb();
    const res = await post(appWithDb(db), "/onboarding/events", {
      events: [
        { step: "intro:documents", event: "viewed", at: AT },
        { step: "intro:documents", event: "completed", at: AT, elapsedMs: 4200 },
        {
          step: "tools",
          event: "skipped",
          at: AT,
          elapsedMs: 900,
          clientId: "5f1c6c3e-5b3a-4a0e-9b4b-0f0f0f0f0f0f",
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 3 });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toHaveLength(3);
    expect(inserted[0][0]).toMatchObject({
      user_id: USER.id,
      step: "intro:documents",
      event: "viewed",
      at: AT,
      elapsed_ms: null,
    });
    expect(inserted[0][1]).toMatchObject({ elapsed_ms: 4200 });
    expect(inserted[0][2]).toMatchObject({ client_id: "5f1c6c3e-5b3a-4a0e-9b4b-0f0f0f0f0f0f" });
  });

  // The use-cases page counts a pick and a create under `use-case:<id>`; a
  // card id is at most 31 characters so the step fits `STEP_ID`.
  it("records a use case picked and created", async () => {
    const { db, inserted } = eventsDb();
    const res = await post(appWithDb(db), "/onboarding/events", {
      events: [
        { step: "use-case:daily-brief", event: "viewed", at: AT },
        { step: "use-case:daily-brief", event: "completed", at: AT, elapsedMs: 30_000 },
      ],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2 });
    expect(inserted[0][0]).toMatchObject({ step: "use-case:daily-brief", event: "viewed" });
    expect(inserted[0][1]).toMatchObject({ step: "use-case:daily-brief", event: "completed" });
  });

  // A retried batch must not count twice, and the id that makes that so has
  // to exist even when the client did not send one.
  it("mints a client id for an event that came without one", async () => {
    const { db, inserted } = eventsDb();
    await post(appWithDb(db), "/onboarding/events", {
      events: [{ step: "mode", event: "viewed", at: AT }],
    });

    expect(inserted[0][0].client_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("stores the first agent's mark and jobs, repeats dropped (0137)", async () => {
    const { db, upserts } = fakeDb({
      row: { assistant_avatar: "owl", assistant_jobs: ["answer-questions", "draft-replies"] },
      error: null,
    });
    const res = await patch(appWithDb(db), {
      assistantAvatar: "owl",
      assistantJobs: ["answer-questions", "draft-replies", "answer-questions"],
    });

    expect(res.status).toBe(200);
    expect(upserts[0]).toMatchObject({
      assistant_avatar: "owl",
      assistant_jobs: ["answer-questions", "draft-replies"],
    });
    expect(await res.json()).toEqual(
      dto({
        answers: {
          assistantAvatar: "owl",
          assistantJobs: ["answer-questions", "draft-replies"],
        },
      }),
    );
  });

  it("refuses a mark that is not one of the eight", async () => {
    const { db, upserts } = fakeDb({ row: null, error: null });
    expect((await patch(appWithDb(db), { assistantAvatar: "unicorn" })).status).toBe(400);
    expect(upserts).toEqual([]);
  });

  it("takes the user id from the token, not the body", async () => {
    const { db, inserted } = eventsDb();
    await post(appWithDb(db), "/onboarding/events", {
      events: [{ step: "mode", event: "viewed", at: AT, user_id: "somebody-else" }],
    });

    expect(inserted[0][0].user_id).toBe(USER.id);
  });

  it("refuses an empty batch, a batch past the cap, and an event it does not know", async () => {
    const { db, inserted } = eventsDb();
    const app = appWithDb(db);

    expect((await post(app, "/onboarding/events", { events: [] })).status).toBe(400);
    expect(
      (
        await post(app, "/onboarding/events", {
          events: Array.from({ length: 51 }, () => ({ step: "mode", event: "viewed", at: AT })),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(app, "/onboarding/events", {
          events: [{ step: "mode", event: "hovered", at: AT }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(app, "/onboarding/events", {
          events: [{ step: "mode", event: "viewed", at: "yesterday" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(app, "/onboarding/events", {
          events: [{ step: "mode", event: "viewed", at: AT, elapsedMs: -1 }],
        })
      ).status,
    ).toBe(400);
    expect(inserted).toEqual([]);
  });

  it("reports a write the database refused", async () => {
    const { db } = eventsDb({ error: { message: "refused" } });
    const res = await post(appWithDb(db), "/onboarding/events", {
      events: [{ step: "mode", event: "viewed", at: AT }],
    });

    expect(res.status).toBe(500);
  });
});

describe("POST /onboarding/finish", () => {
  type FinishResult = {
    agent_id: string;
    session_id: string;
    created: boolean;
    was_completed: boolean;
  };

  function finishDb(
    outcome: { rows: FinishResult[] } | { error: { message: string; code?: string } },
    opts: { workspace?: boolean } = {},
  ) {
    const rpcs: Array<Record<string, unknown>> = [];
    const hasWorkspace = opts.workspace ?? true;
    const fake = strictDb({
      tables: hasWorkspace
        ? activeWorkspaceTables(USER.id, WORKSPACE_ID)
        : {
            profiles: {
              select: () => ({ data: { active_workspace_id: null }, error: null }),
              update: () => ({ data: null, error: null }),
            },
            workspace_members: { select: () => ({ data: [], error: null }) },
          },
      rpc: {
        finish_onboarding: (args) => {
          rpcs.push(args);
          return "error" in outcome
            ? { data: null, error: outcome.error }
            : { data: outcome.rows, error: null };
        },
      },
    });
    return { db: fake.db, rpcs };
  }

  const MADE: FinishResult = {
    agent_id: "agent-1",
    session_id: "session-1",
    created: true,
    was_completed: false,
  };

  it("makes the assistant in the caller's workspace and says where the conversation is", async () => {
    const { db, rpcs } = finishDb({ rows: [MADE] });
    const res = await post(appWithDb(db), "/onboarding/finish", {
      persona: "You keep the team's answers in one place.",
      model: "gpt-4.1-mini",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      completed: true,
      agentId: "agent-1",
      sessionId: "session-1",
      created: true,
    });
    expect(rpcs).toEqual([
      {
        p_workspace_id: WORKSPACE_ID,
        p_persona: "You keep the team's answers in one place.",
        p_model: "gpt-4.1-mini",
      },
    ]);
  });

  it("works with no body at all, leaving the persona and model to the function", async () => {
    const { db, rpcs } = finishDb({ rows: [MADE] });
    const res = await post(appWithDb(db), "/onboarding/finish");

    expect(res.status).toBe(200);
    expect(rpcs[0]).toEqual({ p_workspace_id: WORKSPACE_ID, p_persona: null, p_model: null });
  });

  // The second tap, or the reload of the last screen: the function hands back
  // what it made the first time, and the route reports it as such.
  it("hands back the same ids on a second call", async () => {
    const { db } = finishDb({ rows: [{ ...MADE, created: false, was_completed: true }] });
    const res = await post(appWithDb(db), "/onboarding/finish");

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      agentId: "agent-1",
      sessionId: "session-1",
      created: false,
    });
  });

  // A first run is the person's own to finish, in a browser: a key that could
  // would stamp the account, make its agent and send its welcome, and revoking
  // the key afterwards takes none of that back.
  it("is not something an api key may do", async () => {
    const { db, rpcs } = finishDb({ rows: [MADE] });
    const res = await post(appWithDb(db, { apiKeyId: "key-1" }), "/onboarding/finish");

    expect(res.status).toBe(403);
    expect(rpcs).toEqual([]);
  });

  it("refuses a run that has not named its assistant", async () => {
    const { db } = finishDb({ error: { message: "name your assistant first", code: "P0002" } });
    const res = await post(appWithDb(db), "/onboarding/finish");

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "incomplete" });
  });

  // An invited account that has not taken its invitation (0115). The frontend
  // keeps it on the invitation; this route has nowhere to put an agent.
  it("has nothing to do for an account with no workspace", async () => {
    const { db, rpcs } = finishDb({ rows: [MADE] }, { workspace: false });
    const res = await post(appWithDb(db), "/onboarding/finish");

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: "no_workspace" });
    expect(rpcs).toEqual([]);
  });

  it("refuses a model this deployment does not serve", async () => {
    const { db, rpcs } = finishDb({ rows: [MADE] });
    // No ANTHROPIC_API_KEY in the env, so no Claude id is on offer.
    const res = await post(appWithDb(db), "/onboarding/finish", { model: "claude-sonnet-5" });

    expect(res.status).toBe(400);
    expect(rpcs).toEqual([]);
  });

  it("refuses a model it has never heard of", async () => {
    const { db, rpcs } = finishDb({ rows: [MADE] });
    const res = await post(appWithDb(db), "/onboarding/finish", { model: "gpt-9" });

    expect(res.status).toBe(400);
    expect(rpcs).toEqual([]);
  });

  it("reports a function that failed for any other reason", async () => {
    const { db } = finishDb({ error: { message: "boom", code: "XX000" } });
    const res = await post(appWithDb(db), "/onboarding/finish");

    expect(res.status).toBe(500);
  });

  it("reports a function that answered with nothing", async () => {
    const { db } = finishDb({ rows: [] });
    const res = await post(appWithDb(db), "/onboarding/finish");

    expect(res.status).toBe(500);
  });

  it("welcomes somebody the first time they finish", async () => {
    const { db } = finishDb({ rows: [MADE] });
    const sent = captureSends();

    const res = await post(appWithDb(db), "/onboarding/finish", undefined, MAIL_ENV);

    expect(res.status).toBe(200);
    expect(sent.calls).toHaveLength(1);
    expect(sent.calls[0].to).toEqual([USER.email]);
  });

  // The same guard /complete keeps: a run that was already stamped is a
  // reload, not an arrival.
  it("does not welcome the same person twice", async () => {
    const { db } = finishDb({ rows: [{ ...MADE, created: false, was_completed: true }] });
    const sent = captureSends();

    await post(appWithDb(db), "/onboarding/finish", undefined, MAIL_ENV);

    expect(sent.calls).toEqual([]);
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
