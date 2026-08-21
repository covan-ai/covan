import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { invitations } from "./invitations";
import {
  activeWorkspaceTables,
  fakeDb,
  type FakeDbSpec,
  type QueryContext,
} from "../test-support/fake-db";

/**
 * Invitations are how someone who is not in a workspace gets into it, which
 * makes this the one route file where a mistake hands out access rather than
 * merely leaking a read.
 *
 * The route itself is thin on purpose: the database decides who may invite
 * (the `invitations_insert_admin` policy) and who may accept (the
 * `accept_invitation` SECURITY DEFINER function). What these tests hold in
 * place is the layer above that — that the route asks on behalf of the caller
 * and nobody else, and that when the database declines, the route says so
 * instead of reporting success.
 */

const USER = { id: "user-1", email: "admin@example.com" };
const WORKSPACE = "ws-1";
const CREATED_AT = "2026-08-01T09:00:00.000Z";

function appWith(spec: FakeDbSpec) {
  const fake = fakeDb({
    ...spec,
    tables: { ...activeWorkspaceTables(USER.id, WORKSPACE), ...spec.tables },
  });

  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", fake.db as never);
    await next();
  });
  app.route("/", invitations);

  return { app, ...fake };
}

const json = (app: Hono<AppEnv>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("GET /invitations", () => {
  it("lists the pending invitations of the caller's own workspace", async () => {
    const { app, callsTo } = appWith({
      tables: {
        invitations: {
          select: () => ({
            data: [
              { id: "inv-1", email: "new@example.com", role: "member", created_at: CREATED_AT },
            ],
            error: null,
          }),
        },
      },
    });

    const res = await json(app, "GET", "/invitations");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      {
        id: "inv-1",
        email: "new@example.com",
        role: "member",
        createdAt: Date.parse(CREATED_AT),
      },
    ]);

    // The filters are the whole point: without the workspace_id filter an admin
    // of one workspace would page through every pending invite RLS lets them see.
    expect(callsTo("invitations")[0].filters).toEqual([
      { column: "workspace_id", value: WORKSPACE, kind: "eq" },
      { column: "status", value: "pending", kind: "eq" },
    ]);
  });

  it("answers 404 when the caller has no workspace at all", async () => {
    const { app } = appWith({
      tables: {
        profiles: { select: () => ({ data: { active_workspace_id: null }, error: null }) },
        workspace_members: { select: () => ({ data: null, error: null }) },
      },
    });

    const res = await json(app, "GET", "/invitations");

    expect(res.status).toBe(404);
  });

  it("does not pass a database failure off as an empty list", async () => {
    const { app } = appWith({
      tables: {
        invitations: { select: () => ({ data: null, error: { message: "boom" } }) },
      },
    });

    expect((await json(app, "GET", "/invitations")).status).toBe(500);
  });
});

describe("POST /invitations", () => {
  const created = {
    id: "inv-1",
    email: "new@example.com",
    role: "member",
    created_at: CREATED_AT,
  };

  it("records the invite against the caller's workspace and name", async () => {
    let inserted: Record<string, unknown> | undefined;
    const { app } = appWith({
      tables: {
        invitations: {
          insert: (ctx: QueryContext) => {
            inserted = ctx.values;
            return { data: [created], error: null };
          },
        },
      },
    });

    const res = await json(app, "POST", "/invitations", {
      email: "new@example.com",
      role: "member",
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({
      id: "inv-1",
      email: "new@example.com",
      role: "member",
      createdAt: Date.parse(CREATED_AT),
    });

    // workspace_id comes from the caller's session, never from the request
    // body, and invited_by is stamped server-side.
    expect(inserted).toEqual({
      workspace_id: WORKSPACE,
      email: "new@example.com",
      role: "member",
      invited_by: USER.id,
    });
  });

  it("lowercases the address so the same person cannot be invited twice", async () => {
    let inserted: Record<string, unknown> | undefined;
    const { app } = appWith({
      tables: {
        invitations: {
          insert: (ctx: QueryContext) => {
            inserted = ctx.values;
            return { data: [created], error: null };
          },
        },
      },
    });

    await json(app, "POST", "/invitations", { email: "NEW@Example.COM", role: "member" });

    expect(inserted?.email).toBe("new@example.com");
  });

  it("rejects an address with padding instead of trimming it", async () => {
    // Documenting the current contract rather than the intended one. The
    // handler calls `.trim()`, but `z.string().email()` has already refused a
    // padded address by then, so that trim never runs — unlike
    // createWorkspaceSchema in workspace.ts, which trims inside the schema.
    // Moving `.trim()` into the schema would turn this 400 into a 201.
    const { app } = appWith({});

    const res = await json(app, "POST", "/invitations", {
      email: "  new@example.com  ",
      role: "member",
    });

    expect(res.status).toBe(400);
  });

  it.each([
    ["a malformed address", { email: "not-an-email", role: "member" }],
    ["a role that does not exist", { email: "new@example.com", role: "owner" }],
    ["a missing role", { email: "new@example.com" }],
    ["nothing at all", {}],
  ])("rejects %s without touching the table", async (_label, body) => {
    // No `invitations` handler is registered, so any query would throw.
    const { app } = appWith({});

    expect((await json(app, "POST", "/invitations", body)).status).toBe(400);
  });

  it("reports a duplicate as a conflict, not a failure", async () => {
    const { app } = appWith({
      tables: {
        invitations: {
          insert: () => ({ data: null, error: { message: "duplicate key", code: "23505" } }),
        },
      },
    });

    const res = await json(app, "POST", "/invitations", {
      email: "new@example.com",
      role: "member",
    });

    expect(res.status).toBe(409);
  });

  it("treats an RLS refusal as forbidden", async () => {
    // A non-admin's insert fails the policy's WITH CHECK and comes back as an
    // error. 403 is the honest answer.
    const { app } = appWith({
      tables: {
        invitations: {
          insert: () => ({ data: null, error: { message: "new row violates row-level security" } }),
        },
      },
    });

    const res = await json(app, "POST", "/invitations", {
      email: "new@example.com",
      role: "member",
    });

    expect(res.status).toBe(403);
  });

  it("treats a silent zero-row insert as forbidden too", async () => {
    // The failure mode that would otherwise look like success: no error, no
    // row. Answering 201 here would show the inviter a member who was never
    // invited.
    const { app } = appWith({
      tables: {
        invitations: { insert: () => ({ data: [], error: null }) },
      },
    });

    const res = await json(app, "POST", "/invitations", {
      email: "new@example.com",
      role: "member",
    });

    expect(res.status).toBe(403);
  });
});

describe("DELETE /invitations/:id", () => {
  it("revokes an invitation the caller is allowed to revoke", async () => {
    const { app, callsTo } = appWith({
      tables: {
        invitations: { delete: () => ({ data: [{ id: "inv-1" }], error: null }) },
      },
    });

    const res = await json(app, "DELETE", "/invitations/inv-1");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(callsTo("invitations")[0].filters).toEqual([
      { column: "id", value: "inv-1", kind: "eq" },
    ]);
  });

  it("answers 404 when RLS matched nothing", async () => {
    // Deleting someone else's invitation matches zero rows. The route must not
    // report `{ ok: true }` for work it did not do.
    const { app } = appWith({
      tables: {
        invitations: { delete: () => ({ data: [], error: null }) },
      },
    });

    const res = await json(app, "DELETE", "/invitations/someone-elses");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: "invitation not found or not permitted",
    });
  });
});

describe("GET /invitations/incoming", () => {
  it("names the workspace whether PostgREST embeds it as an object or an array", async () => {
    for (const embedded of [{ name: "Acme" }, [{ name: "Acme" }]]) {
      const { app } = appWith({
        tables: {
          invitations: {
            select: () => ({
              data: [
                {
                  id: "inv-1",
                  workspace_id: "ws-2",
                  role: "member",
                  created_at: CREATED_AT,
                  workspaces: embedded,
                },
              ],
              error: null,
            }),
          },
        },
      });

      const res = await json(app, "GET", "/invitations/incoming");

      await expect(res.json()).resolves.toEqual([
        {
          id: "inv-1",
          workspaceId: "ws-2",
          workspaceName: "Acme",
          role: "member",
          createdAt: Date.parse(CREATED_AT),
        },
      ]);
    }
  });

  it("survives an invitation whose workspace did not come back", async () => {
    const { app } = appWith({
      tables: {
        invitations: {
          select: () => ({
            data: [
              {
                id: "inv-1",
                workspace_id: "ws-2",
                role: "member",
                created_at: CREATED_AT,
                workspaces: null,
              },
            ],
            error: null,
          }),
        },
      },
    });

    const res = await json(app, "GET", "/invitations/incoming");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([expect.objectContaining({ workspaceName: "" })]);
  });
});

describe("POST /invitations/:id/accept", () => {
  it("hands the id to the database function and returns the workspace joined", async () => {
    let args: Record<string, unknown> | undefined;
    const { app } = appWith({
      rpc: {
        accept_invitation: (received) => {
          args = received;
          return { data: "ws-2", error: null };
        },
      },
    });

    const res = await json(app, "POST", "/invitations/inv-1/accept");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ workspaceId: "ws-2" });
    // The caller is never named here: `accept_invitation` reads auth.uid()
    // itself, so there is no id for a caller to substitute.
    expect(args).toEqual({ p_invite_id: "inv-1" });
  });

  it("refuses when the database function refuses", async () => {
    // Accepting an invitation addressed to somebody else raises inside the
    // function. The message is what the user sees.
    const { app } = appWith({
      rpc: {
        accept_invitation: () => ({
          data: null,
          error: { message: "invitation is not addressed to you" },
        }),
      },
    });

    const res = await json(app, "POST", "/invitations/someone-elses/accept");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "invitation is not addressed to you",
    });
  });
});
