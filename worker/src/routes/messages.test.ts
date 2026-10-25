import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec, type QueryContext } from "../test-support/fake-db";
import { messages } from "./messages";
import { forgetTurnObservers, registerTurnObserver, type TurnEvent } from "../lib/turn-events";

const USER = { id: "user-1", email: "a@example.com" };
const ANCHOR = { id: "msg-1", session_id: "sess-1", created_at: "2026-09-01T10:00:00Z" };

/**
 * @param sessionOwner who owns the conversation the anchor message belongs to.
 * `null` stands for a session the caller cannot see at all.
 */
function appWith(spec: {
  sessionOwner: string | null;
  anchorFound?: boolean;
  /** The role of the message the route looks up. Replies have versions; questions do not. */
  anchorRole?: string;
}) {
  const deleted: QueryContext[] = [];
  const rpcCalls: Array<Record<string, unknown>> = [];
  const dbSpec: FakeDbSpec = {
    tables: {
      messages: {
        select: () => ({
          data:
            (spec.anchorFound ?? true) ? { ...ANCHOR, role: spec.anchorRole ?? "assistant" } : null,
          error: null,
        }),
        delete: (ctx) => {
          deleted.push(ctx);
          return { data: null, error: null };
        },
      },
      chat_sessions: {
        select: () => ({
          data: spec.sessionOwner ? { user_id: spec.sessionOwner } : null,
          error: null,
        }),
      },
    },
    rpc: {
      show_message_version: (args: Record<string, unknown>) => {
        rpcCalls.push(args);
        return { data: null, error: null };
      },
    },
  };
  const { db } = fakeDb(dbSpec);

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", messages);
  return { app, deleted, rpcCalls };
}

async function deleteAfter(app: Hono<AppEnv>) {
  const res = await app.request(`/messages/after/${ANCHOR.id}`, { method: "DELETE" }, {} as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("DELETE /messages/after/:id", () => {
  it("trims the conversation for the owner", async () => {
    const { app, deleted } = appWith({ sessionOwner: USER.id });
    const res = await deleteAfter(app);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(deleted).toHaveLength(1);
    expect(deleted[0].filters).toContainEqual({
      column: "created_at",
      value: ANCHOR.created_at,
      kind: "gt",
    });
  });

  it("refuses a member of a shared conversation instead of quietly doing nothing", async () => {
    // `messages_delete_owner` is keyed to the session's owner, and RLS refuses
    // a delete it has no policy for by matching no rows and reporting no error.
    // So this used to answer `{ ok: true }`, delete nothing, and hand the
    // client a Regenerate that then failed with "no user message to respond
    // to" — the reply it was meant to replace still on screen.
    const { app, deleted } = appWith({ sessionOwner: "someone-else" });
    const res = await deleteAfter(app);
    expect(res.status).toBe(403);
    expect(deleted).toHaveLength(0);
  });

  it("404s when the anchor message is not visible", async () => {
    const { app } = appWith({ sessionOwner: USER.id, anchorFound: false });
    expect((await deleteAfter(app)).status).toBe(404);
  });

  it("404s when the session behind the anchor is not visible", async () => {
    const { app, deleted } = appWith({ sessionOwner: null });
    expect((await deleteAfter(app)).status).toBe(404);
    expect(deleted).toHaveLength(0);
  });
});

describe("POST /messages/:id/show", () => {
  const show = (app: Hono<AppEnv>, id = "msg-1") =>
    app.request(`/messages/${id}/show`, { method: "POST" });

  it("switches the version through the one statement that has no gap in it", async () => {
    const { app, rpcCalls } = appWith({ sessionOwner: USER.id });

    const res = await show(app);

    expect(res.status).toBe(200);
    expect(rpcCalls).toEqual([{ p_message_id: "msg-1" }]);
  });

  it("answers a non-owner honestly rather than doing nothing quietly", async () => {
    // `show_message_version` is SECURITY DEFINER and reports success after
    // matching no rows, which is a silent no-op the interface cannot act on.
    const { app, rpcCalls } = appWith({ sessionOwner: "someone-else" });

    const res = await show(app);

    expect(res.status).toBe(403);
    expect(rpcCalls).toEqual([]);
  });

  it("refuses a question, which has no versions to switch between", async () => {
    const { app, rpcCalls } = appWith({ sessionOwner: USER.id, anchorRole: "user" });

    const res = await show(app);

    expect(res.status).toBe(400);
    expect(rpcCalls).toEqual([]);
  });

  it("is a 404 for a message the caller cannot see", async () => {
    const { app } = appWith({ sessionOwner: USER.id, anchorFound: false });

    expect((await show(app)).status).toBe(404);
  });
});

describe("POST /messages", () => {
  /** The insert's answer, as PostgREST gives it. */
  function posting(
    insert: () => { data: unknown; error: { code: string; message: string } | null },
  ) {
    const { db } = fakeDb({ tables: { messages: { insert } } });
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("user", USER as never);
      c.set("db", db as never);
      await next();
    });
    app.route("/", messages);
    return app.request(
      "/messages",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: "7b0c2f5e-1d3a-4c8e-9f60-2a1b3c4d5e6f",
          role: "user",
          content: "Can I write here?",
        }),
      },
      {} as never,
    );
  }

  // A thread on an agent you cannot use: RLS refuses the row with 42501, which
  // is "not allowed", not "something broke".
  it("answers 403 when the database refuses the row", async () => {
    const res = await posting(() => ({
      data: null,
      error: { code: "42501", message: "new row violates row-level security policy" },
    }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "you cannot write in this thread" });
  });

  it("still answers 500 when something did break", async () => {
    const res = await posting(() => ({ data: null, error: { code: "XX000", message: "boom" } }));
    expect(res.status).toBe(500);
  });
});

describe("PATCH /messages/:id", () => {
  afterEach(() => forgetTurnObservers());

  const SESSION = { workspace_id: "ws-1", agent_id: "agent-1" };

  function editing(spec: {
    role?: string;
    found?: boolean;
    updateError?: boolean;
    session?: Record<string, unknown> | null;
    /** Holds the session read open until called, to see what waits on it. */
    holdSession?: boolean;
  }) {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => (release = r));
    const sessionReads: QueryContext[] = [];
    const { db } = fakeDb({
      tables: {
        messages: {
          update: () =>
            spec.updateError
              ? { data: null, error: { message: "boom" } }
              : {
                  data:
                    (spec.found ?? true)
                      ? {
                          id: "msg-1",
                          session_id: "sess-1",
                          role: spec.role ?? "user",
                          content: "Reworded",
                          created_at: "2026-09-01T10:00:00Z",
                        }
                      : null,
                  error: null,
                },
        },
        chat_sessions: {
          select: async (ctx) => {
            sessionReads.push(ctx);
            if (spec.holdSession) await held;
            return { data: spec.session === undefined ? SESSION : spec.session, error: null };
          },
        },
      },
    });
    const app = new Hono<AppEnv>();
    app.use("/*", async (c, next) => {
      c.set("user", USER as never);
      c.set("db", db as never);
      await next();
    });
    app.route("/", messages);
    const patch = async () => {
      const res = await app.request(
        "/messages/msg-1",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: "Reworded" }),
        },
        {} as never,
      );
      await new Promise((r) => setTimeout(r, 0));
      return res;
    };
    return { patch, sessionReads, release };
  }

  function observed() {
    const seen: TurnEvent[] = [];
    registerTurnObserver((event) => {
      seen.push(event);
    });
    return seen;
  }

  it("tells an observer a question was edited, once", async () => {
    const seen = observed();
    const { patch } = editing({});

    const res = await patch();

    expect(res.status).toBe(200);
    expect(seen).toEqual([
      {
        kind: "question_edited",
        workspaceId: "ws-1",
        userId: "user-1",
        agentId: "agent-1",
        sessionId: "sess-1",
        messageId: "msg-1",
      },
    ]);
  });

  it("says nothing of a reply being edited", async () => {
    const seen = observed();
    const { patch } = editing({ role: "assistant" });

    expect((await patch()).status).toBe(200);
    expect(seen).toEqual([]);
  });

  it("says nothing when the edit failed or found nothing", async () => {
    const seen = observed();

    expect((await editing({ updateError: true }).patch()).status).toBe(500);
    expect((await editing({ found: false }).patch()).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it("still answers when the session behind the message cannot be read", async () => {
    const seen = observed();
    const { patch } = editing({ session: null });

    expect((await patch()).status).toBe(200);
    expect(seen).toEqual([]);
  });

  it("answers without waiting for the session read, and tells the observer after it", async () => {
    const seen = observed();
    const { patch, sessionReads, release } = editing({ holdSession: true });

    const res = await patch();

    expect(res.status).toBe(200);
    expect(sessionReads).toHaveLength(1);
    expect(seen).toEqual([]);

    release();
    await new Promise((r) => setTimeout(r, 0));

    expect(seen).toMatchObject([{ kind: "question_edited", workspaceId: "ws-1" }]);
  });

  it("reads nothing more when nothing is observing", async () => {
    const { patch, sessionReads } = editing({});

    expect((await patch()).status).toBe(200);
    expect(sessionReads).toEqual([]);
  });
});
