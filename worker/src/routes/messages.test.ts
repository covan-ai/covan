import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec, type QueryContext } from "../test-support/fake-db";
import { messages } from "./messages";

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
