import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { feedback } from "./feedback";

const USER = { id: "user-1", email: "a@b.c" };

/**
 * Stands in for the request-scoped Supabase client. This route touches
 * `feedback` to write and the two workspace tables to work out which room the
 * caller is in, so anything else is a mistake worth failing on.
 */
function fakeDb(options: { activeWorkspaceId?: string | null; insertError?: string } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const workspaceId = "activeWorkspaceId" in options ? options.activeWorkspaceId : "workspace-1";

  const db = {
    from(table: string) {
      if (table === "feedback") {
        return {
          insert(values: Record<string, unknown>) {
            inserted.push(values);
            return {
              select: () => ({
                single: async () =>
                  options.insertError
                    ? { data: null, error: { message: options.insertError } }
                    : {
                        data: { id: "feedback-1", created_at: "2026-09-02T00:00:00Z" },
                        error: null,
                      },
              }),
            };
          },
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: workspaceId ? { active_workspace_id: workspaceId } : null,
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "workspace_members") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: workspaceId ? { workspace_id: workspaceId } : null,
                  error: null,
                }),
              }),
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({
                    data: workspaceId ? { workspace_id: workspaceId } : null,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      throw new Error(`fakeDb: unexpected table "${table}"`);
    },
  };

  return { db, inserted };
}

function appWithDb(db: unknown) {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db as never);
    c.set("user", USER as never);
    await next();
  });
  app.route("/", feedback);
  return app;
}

async function post(db: unknown, body: unknown) {
  return appWithDb(db).request("/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /feedback", () => {
  it("records what somebody wrote", async () => {
    const { db, inserted } = fakeDb();

    const res = await post(db, {
      message: "the sidebar forgets me",
      kind: "problem",
      path: "/app",
    });

    expect(res.status).toBe(201);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      user_id: "user-1",
      workspace_id: "workspace-1",
      kind: "problem",
      message: "the sidebar forgets me",
      path: "/app",
    });
  });

  // The three fields the dialog does not ask for. A person who types one
  // sentence and presses send is the case this route is built around.
  it("takes a bare message", async () => {
    const { db, inserted } = fakeDb();

    const res = await post(db, { message: "just this" });

    expect(res.status).toBe(201);
    expect(inserted[0]).toMatchObject({ kind: "other", message: "just this" });
  });

  it("trims what it stores", async () => {
    const { db, inserted } = fakeDb();

    await post(db, { message: "  padded  " });

    expect(inserted[0].message).toBe("padded");
  });

  it("refuses an empty message", async () => {
    const { db, inserted } = fakeDb();

    const res = await post(db, { message: "   " });

    expect(res.status).toBe(400);
    expect(inserted).toHaveLength(0);
  });

  it("refuses a kind it does not recognise", async () => {
    const { db } = fakeDb();

    const res = await post(db, { message: "hello", kind: "complaint" });

    expect(res.status).toBe(400);
  });

  /**
   * The column is capped at 4000 by a check constraint, and a body that would
   * trip it should be refused here with a reason rather than reaching Postgres
   * and coming back as a 500 the person cannot act on.
   */
  it("refuses a message longer than the column will hold", async () => {
    const { db } = fakeDb();

    const res = await post(db, { message: "x".repeat(4001) });

    expect(res.status).toBe(400);
  });

  /**
   * Somebody can be signed in with no workspace — mid-onboarding, or having
   * just left their last one. That is a person with something to say, not an
   * error, and the row simply carries no room.
   */
  it("takes feedback from somebody who is in no workspace", async () => {
    const { db, inserted } = fakeDb({ activeWorkspaceId: null });

    const res = await post(db, { message: "cannot get in" });

    expect(res.status).toBe(201);
    expect(inserted[0].workspace_id).toBeNull();
  });

  // The path is context for whoever reads this, and it is the one field the
  // client chooses. A full URL would carry ids and a query string nobody meant
  // to send, so only the path survives.
  it("keeps only the path from whatever the client sent", async () => {
    const { db, inserted } = fakeDb();

    await post(db, { message: "here", path: "https://covan.app/agents/abc?token=secret#x" });

    expect(inserted[0].path).toBe("/agents/abc");
  });

  /**
   * The reply a thumb was pressed under. The policy in 0040 refuses an id the
   * caller cannot read, so this is context rather than a claim the route has
   * to check — but it does have to arrive.
   */
  it("carries the answer the feedback is about", async () => {
    const { db, inserted } = fakeDb();

    await post(db, {
      message: "this answer invented a refund window",
      kind: "problem",
      messageId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    });

    expect(inserted[0].message_id).toBe("3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  });

  it("files feedback about nothing in particular with no answer attached", async () => {
    const { db, inserted } = fakeDb();

    await post(db, { message: "the sidebar is cramped" });

    expect(inserted[0].message_id).toBeNull();
  });

  // A message id is a uuid or it is a mistake. Letting anything else through
  // would reach Postgres as a type error and come back as a 500.
  it("refuses an answer id that is not one", async () => {
    const { db } = fakeDb();

    const res = await post(db, { message: "hello", messageId: "not-a-uuid" });

    expect(res.status).toBe(400);
  });

  it("reports a write that did not happen", async () => {
    const { db } = fakeDb({ insertError: "permission denied" });

    const res = await post(db, { message: "hello" });

    expect(res.status).toBe(500);
  });
});
