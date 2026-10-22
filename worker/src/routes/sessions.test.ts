import { Hono } from "hono";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec, type QueryContext } from "../test-support/fake-db";

const pollConversationBrowser = vi.fn();
vi.mock("../lib/browser/live", () => ({
  pollConversationBrowser: (...args: unknown[]) => pollConversationBrowser(...args),
}));
const tasksThatCarriedALogin = vi.fn();
// A failed read thrown by the stand-in rather than by the `vi.fn`, which vitest
// reports as a failure even when the route catches it.
let carryReadFails = false;
const savedLogin = vi.fn();
vi.mock("../lib/browser/credentials", () => ({
  tasksThatCarriedALogin: async (...args: unknown[]) => {
    if (carryReadFails) throw new Error("browser_tasks: read failed (57014)");
    return tasksThatCarriedALogin(...args);
  },
  savedLogin: async (...args: unknown[]) => savedLogin(...args),
}));

import { sessions } from "./sessions";

const SESSION_ROW = {
  id: "session-1",
  agent_id: "agent-1",
  user_id: "user-1",
  title: null,
  visibility: "private",
  kind: "chat",
  updated_at: "2026-09-05T00:00:00.000Z",
};

/**
 * The route under test with a database that answers a PATCH by echoing the row
 * back with the update applied — which is what PostgREST does, and what lets a
 * test read the response instead of only the recorded query.
 */
function appWith(spec?: FakeDbSpec) {
  const fake = fakeDb(
    spec ?? {
      tables: {
        chat_sessions: {
          update: (ctx: QueryContext) => ({
            data: { ...SESSION_ROW, ...ctx.values, messages: [{ count: 3 }] },
            error: null,
          }),
        },
      },
    },
  );
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", { id: "user-1" } as never);
    c.set("db", fake.db as never);
    await next();
  });
  app.route("/", sessions);
  return { app, fake };
}

const patch = (app: Hono<AppEnv>, body: unknown) =>
  app.request("/sessions/session-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("PATCH /sessions/:id", () => {
  it("renames a session", async () => {
    const { app, fake } = appWith();

    const res = await patch(app, { title: "Q3 pricing review" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ title: "Q3 pricing review" });
    expect(fake.callsTo("chat_sessions")[0].values).toEqual({ title: "Q3 pricing review" });
  });

  it("trims the name it was given", async () => {
    const { app, fake } = appWith();

    await patch(app, { title: "   Q3 pricing review \n" });

    expect(fake.callsTo("chat_sessions")[0].values).toEqual({ title: "Q3 pricing review" });
  });

  // Sharing a session is still the other thing this route does, and renaming
  // must not have quietly become a required field on the way in.
  it("still changes visibility on its own", async () => {
    const { app, fake } = appWith();

    const res = await patch(app, { visibility: "shared" });

    expect(res.status).toBe(200);
    expect(fake.callsTo("chat_sessions")[0].values).toEqual({ visibility: "shared" });
  });

  // A PATCH naming only one of the two must not blank the other. Sending both
  // columns every time would clear the title of any session someone shared.
  it("leaves the title alone when only visibility is sent", async () => {
    const { app, fake } = appWith();

    await patch(app, { visibility: "shared" });

    expect(fake.callsTo("chat_sessions")[0].values).not.toHaveProperty("title");
  });

  it("refuses a blank name rather than writing one", async () => {
    const { app, fake } = appWith();

    const res = await patch(app, { title: "   " });

    expect(res.status).toBe(400);
    expect(fake.callsTo("chat_sessions")).toHaveLength(0);
  });

  it("refuses a request that asks for nothing", async () => {
    const { app, fake } = appWith();

    const res = await patch(app, {});

    expect(res.status).toBe(400);
    expect(fake.callsTo("chat_sessions")).toHaveLength(0);
  });

  it("refuses a name longer than the column is meant to hold", async () => {
    const { app } = appWith();

    const res = await patch(app, { title: "x".repeat(500) });

    expect(res.status).toBe(400);
  });

  // RLS restricts the update to the owner, so a non-owner's PATCH matches no
  // row and comes back empty rather than as an error. That is a 404, not a 200
  // reporting a change that never happened.
  it("reports not found when the database matched no row", async () => {
    const { app } = appWith({
      tables: { chat_sessions: { update: () => ({ data: null, error: null }) } },
    });

    const res = await patch(app, { title: "Q3 pricing review" });

    expect(res.status).toBe(404);
  });
});

// The dial a conversation turns for itself (0099). Null is a value here — it
// hands the setting back to the agent — so it has to reach the column rather
// than be dropped as "not sent".
describe("PATCH /sessions/:id — the dial", () => {
  it("writes each setting to its own column and returns it", async () => {
    const { app, fake } = appWith();

    const res = await patch(app, {
      model: "gpt-5",
      reasoningEffort: "high",
      webSearch: true,
      mode: "brainstorm",
    });

    expect(res.status).toBe(200);
    expect(fake.callsTo("chat_sessions")[0].values).toEqual({
      model: "gpt-5",
      reasoning_effort: "high",
      web_search: true,
      mode: "brainstorm",
    });
    await expect(res.json()).resolves.toMatchObject({
      model: "gpt-5",
      reasoningEffort: "high",
      webSearch: true,
      mode: "brainstorm",
    });
  });

  it("clears a setting back to the agent's with null", async () => {
    const { app, fake } = appWith();

    const res = await patch(app, { model: null, reasoningEffort: null });

    expect(res.status).toBe(200);
    expect(fake.callsTo("chat_sessions")[0].values).toEqual({
      model: null,
      reasoning_effort: null,
    });
  });

  it("names only the setting that was sent", async () => {
    const { app, fake } = appWith();

    await patch(app, { reasoningEffort: "minimal" });

    expect(fake.callsTo("chat_sessions")[0].values).toEqual({ reasoning_effort: "minimal" });
  });

  it("refuses a model this deployment cannot answer on", async () => {
    const { app, fake } = appWith();

    // No Anthropic key in this env, so a Claude id is as unserved as a made-up one.
    for (const model of ["not-a-model", "claude-opus-5"]) {
      const res = await patch(app, { model });
      expect(res.status).toBe(400);
    }
    expect(fake.callsTo("chat_sessions")).toHaveLength(0);
  });

  it("accepts a Claude model where the deployment has the key", async () => {
    const { app, fake } = appWith();

    const res = await app.request(
      "/sessions/session-1",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5" }),
      },
      { ANTHROPIC_API_KEY: "sk-test" },
    );

    expect(res.status).toBe(200);
    expect(fake.callsTo("chat_sessions")[0].values).toEqual({ model: "claude-opus-5" });
  });

  it("refuses an effort or a mode outside the four and the two", async () => {
    const { app, fake } = appWith();

    expect((await patch(app, { reasoningEffort: "extreme" })).status).toBe(400);
    expect((await patch(app, { mode: "loud" })).status).toBe(400);
    expect((await patch(app, { webSearch: "yes" })).status).toBe(400);
    expect(fake.callsTo("chat_sessions")).toHaveLength(0);
  });
});

describe("POST /sessions — the dial", () => {
  function appCreating() {
    return appWith({
      tables: {
        agents: { select: () => ({ data: { workspace_id: "ws-1" }, error: null }) },
        chat_sessions: {
          insert: (ctx: QueryContext) => ({
            data: { ...SESSION_ROW, ...ctx.values },
            error: null,
          }),
        },
      },
    });
  }
  const post = (app: Hono<AppEnv>, body: unknown) =>
    app.request("/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("starts a session with the dial already turned", async () => {
    const { app, fake } = appCreating();

    const res = await post(app, { agentId: "agent-1", model: "gpt-4.1", webSearch: false });

    expect(res.status).toBe(201);
    const values = fake.callsTo("chat_sessions")[0].values;
    expect(values).toMatchObject({ model: "gpt-4.1", web_search: false });
    expect(values).not.toHaveProperty("reasoning_effort");
    expect(values).not.toHaveProperty("mode");
    await expect(res.json()).resolves.toMatchObject({
      model: "gpt-4.1",
      webSearch: false,
      reasoningEffort: null,
      mode: null,
    });
  });

  it("writes none of the dial's columns when none was sent", async () => {
    const { app, fake } = appCreating();

    await post(app, { agentId: "agent-1" });

    const values = fake.callsTo("chat_sessions")[0].values ?? {};
    for (const column of ["model", "reasoning_effort", "web_search", "mode"]) {
      expect(values).not.toHaveProperty(column);
    }
  });

  it("refuses a model this deployment cannot answer on", async () => {
    const { app, fake } = appCreating();

    const res = await post(app, { agentId: "agent-1", model: "not-a-model" });

    expect(res.status).toBe(400);
    expect(fake.callsTo("chat_sessions")).toHaveLength(0);
  });
});

describe("GET /sessions/:id/messages", () => {
  const row = (id: string, at: string) => ({
    id,
    role: "user",
    content: id,
    created_at: at,
    sender: null,
  });

  /**
   * The database answering newest-first, which is how the route asks.
   *
   * Two reads now: the transcript, and the one that finds which answers have
   * been regenerated. They are told apart by the columns asked for, which is
   * the only thing that distinguishes them at this level.
   */
  const withTranscript = (rows: ReturnType<typeof row>[], alternates: unknown[] = []) =>
    appWith({
      tables: {
        messages: {
          select: (ctx: QueryContext) =>
            ctx.columns?.includes("original_message_id")
              ? { data: alternates, error: null }
              : { data: rows, error: null },
        },
      },
    });

  it("reads the newest page and hands it back oldest first", async () => {
    // The bug this replaces: a bare ascending read with no limit, capped by
    // PostgREST at a thousand rows and cutting from the far end — so a long
    // conversation returned its first thousand messages and silently dropped
    // every one after them. The transcript stopped months ago and went on
    // accepting new messages that never appeared.
    const { app, fake } = withTranscript([
      row("newest", "2026-09-17T12:00:00.000Z"),
      row("older", "2026-09-17T11:00:00.000Z"),
    ]);

    const res = await app.request("/sessions/session-1/messages");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string }[];
    expect(body.map((m) => m.id)).toEqual(["older", "newest"]);

    const query = fake.callsTo("messages")[0];
    expect(query.order).toEqual([
      { column: "created_at", ascending: false },
      // `created_at` is not unique. Without a tiebreaker two messages written
      // in the same millisecond come back in whatever order the planner likes,
      // and a page boundary between them shows one twice and the other never.
      { column: "id", ascending: false },
    ]);
    expect(query.limit).toBe(100);
  });

  it("honours a limit the caller asked for", async () => {
    const { app, fake } = withTranscript([]);

    await app.request("/sessions/session-1/messages?limit=5");

    expect(fake.callsTo("messages")[0].limit).toBe(5);
  });

  it("asks the database for what each tool call returned", async () => {
    // `result_excerpt` is stored by the worker specifically so it can be read
    // on a transcript load (0060), and the embed listed every other column of
    // `message_steps` except that one — so the field existed, was trimmed for
    // this purpose, and never left the database.
    const { app, fake } = withTranscript([]);

    await app.request("/sessions/session-1/messages");

    expect(fake.callsTo("messages")[0].columns).toContain("result_excerpt");
  });

  it("refuses a limit past what the endpoint will serve", async () => {
    const { app } = withTranscript([]);

    const res = await app.request("/sessions/session-1/messages?limit=5000");

    expect(res.status).toBe(400);
  });
});

describe("answers that have been regenerated", () => {
  const reply = (id: string, at: string, root?: string) => ({
    id,
    role: "assistant",
    content: id,
    created_at: at,
    sender: null,
    ...(root ? { original_message_id: root } : {}),
  });

  const app = (rows: unknown[], alternates: unknown[]) =>
    appWith({
      tables: {
        messages: {
          select: (ctx: QueryContext) =>
            ctx.columns?.includes("original_message_id")
              ? { data: alternates, error: null }
              : { data: rows, error: null },
        },
      },
    });

  it("leaves the superseded versions out of the transcript", async () => {
    // A reader scrolling back should see the conversation they had, not every
    // draft of it.
    const { app: server, fake } = app([reply("v2", "2026-09-17T11:00:00.000Z", "v1")], []);

    await server.request("/sessions/session-1/messages");

    const transcript = fake.callsTo("messages")[0];
    expect(transcript.filters).toContainEqual({
      column: "superseded_at",
      value: null,
      kind: "is",
    });
  });

  it("names every version of an answer, oldest first", async () => {
    const { app: server } = app(
      [reply("v3", "2026-09-17T12:00:00.000Z", "v1")],
      [
        { id: "v2", original_message_id: "v1", created_at: "2026-09-17T11:00:00.000Z" },
        { id: "v3", original_message_id: "v1", created_at: "2026-09-17T12:00:00.000Z" },
      ],
    );

    const res = await server.request("/sessions/session-1/messages");

    const body = (await res.json()) as Array<{ id: string; versions?: string[] }>;
    // The root comes from the pointer rather than from a second read, and it is
    // always the earliest, so it goes first.
    expect(body[0].versions).toEqual(["v1", "v2", "v3"]);
  });

  it("says nothing about versions on a reply nobody has regenerated", async () => {
    // Almost every reply. An empty array and an absent field mean the same
    // thing to the screen, and the absent one does not travel.
    const { app: server } = app([reply("only", "2026-09-17T11:00:00.000Z")], []);

    const res = await server.request("/sessions/session-1/messages");

    const body = (await res.json()) as Array<{ versions?: string[] }>;
    expect(body[0]).not.toHaveProperty("versions");
  });
});

describe("GET /sessions/:id/browser-tasks", () => {
  const TASK = {
    id: "bt-1",
    task: "read the pricing table",
    status: "running",
    output: null,
    error: null,
    retry_of: null,
    created_at: "2026-10-10T11:59:00.000Z",
    finished_at: null,
    api_version: "v4",
    stop_reason: null,
    browser_session_id: "bs-1",
    signin_host: "linkedin.com",
  };
  const LIVE = {
    session: { id: "bs-1", liveState: "agent", humanSince: null, browserReady: true },
    events: [{ ts: "2026-10-10T11:59:58Z", type: "agent.step", text: "opened the page" }],
    delivered: false,
  };

  beforeEach(() => {
    pollConversationBrowser.mockReset();
    pollConversationBrowser.mockResolvedValue(LIVE);
  });

  function appSeeing(visible: boolean) {
    return appWith({
      tables: {
        chat_sessions: {
          select: () => ({ data: visible ? { id: "session-1" } : null, error: null }),
        },
        browser_tasks: { select: () => ({ data: [TASK], error: null }) },
      },
    });
  }

  /**
   * The sign-in card says "the saved login didn't work" only of a run that
   * carried one (R32). `credential_id` is granted to no client role, so the
   * caller's own read cannot see it; the route asks `credentials.ts` — with
   * the service role, scoped to this caller — and only when a task is at a
   * login wall, so the ordinary three-second poll costs nothing more.
   */
  describe("carriedSavedLogin", () => {
    const WALL = { ...TASK, status: "failed", stop_reason: "login_required" };

    function appWithTasks(rows: Array<Record<string, unknown>>) {
      return appWith({
        tables: {
          chat_sessions: { select: () => ({ data: { id: "session-1" }, error: null }) },
          browser_tasks: { select: () => ({ data: rows, error: null }) },
        },
      });
    }

    beforeEach(() => {
      tasksThatCarriedALogin.mockReset();
      carryReadFails = false;
    });

    it("is true of a walled task that carried a saved login, asked for the caller only", async () => {
      tasksThatCarriedALogin.mockResolvedValue(new Set(["bt-1"]));
      const { app, fake } = appWithTasks([WALL, { ...TASK, id: "bt-0" }]);

      const body = (await (await app.request("/sessions/session-1/browser-tasks")).json()) as {
        tasks: Array<{ id: string; carriedSavedLogin: boolean }>;
      };

      expect(body.tasks.map((t) => [t.id, t.carriedSavedLogin])).toEqual([
        ["bt-1", true],
        ["bt-0", false],
      ]);
      expect(tasksThatCarriedALogin).toHaveBeenCalledWith(undefined, {
        userId: "user-1",
        taskIds: ["bt-1"],
      });
      // Never asked of the caller's own client, which could not answer.
      expect(String(fake.callsTo("browser_tasks")[0].columns)).not.toContain("credential_id");
    });

    it("asks nothing when no task is at a login wall", async () => {
      const { app } = appWithTasks([TASK]);
      await app.request("/sessions/session-1/browser-tasks");
      expect(tasksThatCarriedALogin).not.toHaveBeenCalled();
    });

    it("answers false, not a failed poll, when the question cannot be answered", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      carryReadFails = true;
      const { app } = appWithTasks([WALL]);

      const res = await app.request("/sessions/session-1/browser-tasks");
      const body = (await res.json()) as { tasks: Array<{ carriedSavedLogin: boolean }> };

      expect(res.status).toBe(200);
      expect(body.tasks[0].carriedSavedLogin).toBe(false);
    });
  });

  /**
   * Found in the 2026-10-11 e2e: a run sent without `site` met the wall with a
   * login saved for the site, and the card offered to save another. The card
   * now offers to try again with the saved one — for the wall it shows, and
   * only when that run carried none.
   */
  describe("savedLogin", () => {
    const WALL = {
      ...TASK,
      status: "failed",
      stop_reason: "login_required",
      signin_host: "quotes.toscrape.com",
    };
    const LOGIN = { id: "cred-q", label: "quotes — e2e", scope: "owner", siteHost: "toscrape.com" };

    function appWithTasks(rows: Array<Record<string, unknown>>) {
      return appWith({
        tables: {
          chat_sessions: {
            select: () => ({ data: { id: "session-1", agent_id: "agent-1" }, error: null }),
          },
          browser_tasks: { select: () => ({ data: rows, error: null }) },
        },
      });
    }

    beforeEach(() => {
      tasksThatCarriedALogin.mockReset();
      tasksThatCarriedALogin.mockResolvedValue(new Set());
      carryReadFails = false;
      savedLogin.mockReset();
      savedLogin.mockResolvedValue(LOGIN);
    });

    type Body = { tasks: Array<{ id: string; savedLogin: unknown }> };

    it("offers the login saved for the wall's site, asked for this agent and this caller", async () => {
      const { app } = appWithTasks([WALL, { ...TASK, id: "bt-0" }]);

      const body = (await (await app.request("/sessions/session-1/browser-tasks")).json()) as Body;

      expect(body.tasks[0].savedLogin).toEqual({
        id: "cred-q",
        label: "quotes — e2e",
        siteHost: "toscrape.com",
      });
      expect(body.tasks[1].savedLogin).toBeNull();
      expect(savedLogin).toHaveBeenCalledWith(undefined, {
        agentId: "agent-1",
        userId: "user-1",
        host: "quotes.toscrape.com",
      });
    });

    it("offers nothing when the run already carried a saved login", async () => {
      tasksThatCarriedALogin.mockResolvedValue(new Set(["bt-1"]));
      const { app } = appWithTasks([WALL]);

      const body = (await (await app.request("/sessions/session-1/browser-tasks")).json()) as Body;

      expect(body.tasks[0].savedLogin).toBeNull();
      expect(savedLogin).not.toHaveBeenCalled();
    });

    it("offers nothing for the retry's own wall, which has had its one try", async () => {
      const { app } = appWithTasks([{ ...WALL, retry_of: "bt-0" }]);

      const body = (await (await app.request("/sessions/session-1/browser-tasks")).json()) as Body;

      expect(body.tasks[0].savedLogin).toBeNull();
      expect(savedLogin).not.toHaveBeenCalled();
    });

    it("asks nothing when the newest task is not at a wall", async () => {
      const { app } = appWithTasks([TASK, { ...WALL, id: "bt-0" }]);
      await app.request("/sessions/session-1/browser-tasks");
      expect(savedLogin).not.toHaveBeenCalled();
    });
  });

  it("answers 404 for a conversation the caller cannot see, before touching the provider", async () => {
    const { app } = appSeeing(false);
    const res = await app.request("/sessions/session-1/browser-tasks");
    expect(res.status).toBe(404);
    expect(pollConversationBrowser).not.toHaveBeenCalled();
  });

  it("polls the caller's own browser in this conversation, then reads the tasks after it", async () => {
    const { app, fake } = appSeeing(true);
    const res = await app.request("/sessions/session-1/browser-tasks");
    expect(res.status).toBe(200);
    expect(pollConversationBrowser).toHaveBeenCalledWith(undefined, {
      chatSessionId: "session-1",
      userId: "user-1",
    });
    // Read after the poll, so a run it just settled is shown settled.
    expect(fake.calls.map((c) => c.table)).toEqual(["chat_sessions", "browser_tasks"]);
    const body = await res.json();
    expect(body).toEqual({
      tasks: [
        {
          id: "bt-1",
          task: "read the pricing table",
          status: "running",
          output: null,
          error: null,
          retryOf: null,
          createdAt: Date.parse("2026-10-10T11:59:00.000Z"),
          finishedAt: null,
          apiVersion: "v4",
          stopReason: null,
          browserSessionId: "bs-1",
          signInHost: "linkedin.com",
          thenStep: null,
          deliveredAt: null,
          continuedAt: null,
          carriedSavedLogin: false,
          savedLogin: null,
        },
      ],
      session: LIVE.session,
      events: LIVE.events,
      delivered: false,
    });
  });

  /**
   * A poll that settles a run has made the row terminal before it delivers,
   * so a request cancelled mid-delivery (the tab closed) would lose that
   * answer for good. The poll is handed to the execution context's
   * `waitUntil` — `deferred`'s job — and is still awaited for the response.
   */
  it("keeps the poll alive past the request, so an abandoned tab cannot lose an answer", async () => {
    let finish!: (value: typeof LIVE) => void;
    pollConversationBrowser.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const waitUntil = vi.fn();
    const { app } = appSeeing(true);

    const pending = app.request("/sessions/session-1/browser-tasks", {}, undefined, {
      waitUntil,
      passThroughOnException: () => {},
    } as never);

    await vi.waitFor(() => expect(waitUntil).toHaveBeenCalledTimes(1));
    let kept = false;
    void (waitUntil.mock.calls[0][0] as Promise<unknown>).then(() => {
      kept = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    // What is kept alive is the poll itself: it has not settled, so neither
    // has this.
    expect(kept).toBe(false);

    finish(LIVE);
    expect((await pending).status).toBe(200);
    await vi.waitFor(() => expect(kept).toBe(true));
  });

  it("names its columns, granted ones only", async () => {
    const { app, fake } = appSeeing(true);
    await app.request("/sessions/session-1/browser-tasks");
    const columns = String(fake.callsTo("browser_tasks")[0].columns);
    expect(columns).not.toContain("*");
    expect(columns).toContain("api_version");
    expect(columns).toContain("stop_reason");
    expect(columns).toContain("browser_session_id");
    expect(columns).not.toMatch(/provider_/);
  });
});

describe("POST /sessions/:id/browser-tasks/continue", () => {
  const ID = "4b1f7c0e-2d7a-4c55-9b7e-0d6a1f3e9c21";

  it("claims the step through the caller's own client and hands it back", async () => {
    const claimed: Array<Record<string, unknown>> = [];
    const { app } = appWith({
      rpc: {
        claim_browser_continuation: (args) => {
          claimed.push(args);
          return { data: ["write the leads to Qrucial"], error: null };
        },
      },
    });

    const res = await app.request(`/sessions/${ID}/browser-tasks/continue`, { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ steps: ["write the leads to Qrucial"] });
    expect(claimed).toEqual([{ p_session_id: ID }]);
  });

  it("answers no steps when there is nothing to carry on with", async () => {
    const { app } = appWith({
      rpc: { claim_browser_continuation: () => ({ data: [], error: null }) },
    });
    const res = await app.request(`/sessions/${ID}/browser-tasks/continue`, { method: "POST" });
    expect(await res.json()).toEqual({ steps: [] });
  });

  it("asks nothing for an id that is not a conversation's", async () => {
    const { app } = appWith({ rpc: {} });
    const res = await app.request("/sessions/not-an-id/browser-tasks/continue", {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("says it failed when the claim does", async () => {
    const { app } = appWith({
      rpc: {
        claim_browser_continuation: () => ({ data: null, error: { code: "XX000" } as never }),
      },
    });
    const res = await app.request(`/sessions/${ID}/browser-tasks/continue`, { method: "POST" });
    expect(res.status).toBe(500);
  });
});

describe("GET /sessions — the dot beside each thread (0122)", () => {
  function listing(states: { data: unknown; error: unknown }) {
    const asked: Array<Record<string, unknown>> = [];
    const { app } = appWith({
      tables: {
        profiles: {
          select: () => ({ data: { active_workspace_id: "ws-1" }, error: null }),
        },
        workspace_members: {
          select: () => ({ data: { workspace_id: "ws-1" }, error: null }),
        },
        chat_sessions: {
          select: () => ({
            data: [
              { ...SESSION_ROW, messages: [{ count: 2 }] },
              { ...SESSION_ROW, id: "session-2", messages: [{ count: 5 }] },
            ],
            error: null,
          }),
        },
      },
      rpc: {
        session_states: (args) => {
          asked.push(args);
          return states as never;
        },
      },
    });
    return { app, asked };
  }

  it("says which thread waits on you, which is running, and how much is unread", async () => {
    const { app, asked } = listing({
      data: [
        { session_id: "session-1", state: "needs_you", unread: 1 },
        { session_id: "session-2", state: "running", unread: 0 },
      ],
      error: null,
    });
    const res = await app.request("/sessions");
    const body = (await res.json()) as Array<{ id: string; state?: string; unread?: number }>;
    expect(body.map((s) => [s.id, s.state, s.unread])).toEqual([
      ["session-1", "needs_you", 1],
      ["session-2", "running", 0],
    ]);
    expect(asked).toEqual([{ p_workspace_id: "ws-1", p_session_ids: ["session-1", "session-2"] }]);
  });

  it("still lists the threads when the dots cannot be read", async () => {
    const { app } = listing({ data: null, error: { message: "timeout" } });
    const body = (await (await app.request("/sessions")).json()) as Array<{ state?: string }>;
    expect(body).toHaveLength(2);
    expect(body[0]!.state).toBeUndefined();
  });
});
