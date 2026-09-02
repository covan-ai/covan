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
function appWith(spec: { sessionOwner: string | null; anchorFound?: boolean }) {
  const deleted: QueryContext[] = [];
  const dbSpec: FakeDbSpec = {
    tables: {
      messages: {
        select: () => ({
          data: (spec.anchorFound ?? true) ? ANCHOR : null,
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
  };
  const { db } = fakeDb(dbSpec);

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    await next();
  });
  app.route("/", messages);
  return { app, deleted };
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
