import { Hono } from "hono";
import { describe, it, expect } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec, type QueryContext } from "../test-support/fake-db";
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

describe("GET /sessions/:id/messages", () => {
  const row = (id: string, at: string) => ({
    id,
    role: "user",
    content: id,
    created_at: at,
    sender: null,
  });

  /** The database answering newest-first, which is how the route asks. */
  const withTranscript = (rows: ReturnType<typeof row>[]) =>
    appWith({ tables: { messages: { select: () => ({ data: rows, error: null }) } } });

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

  it("refuses a limit past what the endpoint will serve", async () => {
    const { app } = withTranscript([]);

    const res = await app.request("/sessions/session-1/messages?limit=5000");

    expect(res.status).toBe(400);
  });
});
