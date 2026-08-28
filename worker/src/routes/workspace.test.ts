import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../types";
import { workspace } from "./workspace";
import {
  activeWorkspaceTables,
  fakeDb,
  type FakeDbSpec,
  type Handler,
  type QueryContext,
} from "../test-support/fake-db";

/**
 * Workspace administration: renaming the workspace, switching between them, and
 * changing or removing members.
 *
 * Two things run through all of it. First, the route never takes the caller's
 * word for which workspace it is acting on — it resolves that from the session
 * and filters every write by it, so a member of one workspace cannot address a
 * row in another. Second, RLS answers a forbidden write with zero rows rather
 * than an error, so every handler here has to read "no rows" as "not allowed"
 * instead of "saved". Both are easy to undo by accident, and neither shows up
 * in types.
 */

const USER = { id: "user-1", email: "admin@example.com" };
const WORKSPACE = "ws-1";

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
  app.route("/", workspace);

  return { app, ...fake };
}

const json = (app: Hono<AppEnv>, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

/** A caller whose profile points nowhere and who belongs to no workspace. */
const NO_WORKSPACE = {
  profiles: { select: () => ({ data: { active_workspace_id: null }, error: null }) },
  workspace_members: { select: () => ({ data: null, error: null }) },
};

describe("PATCH /workspace", () => {
  const saved = { id: WORKSPACE, name: "Acme", slug: "acme", default_model: "gpt-4o" };

  it("saves a change and answers in the API's own vocabulary", async () => {
    let patch: Record<string, unknown> | undefined;
    let filters: QueryContext["filters"] = [];
    const { app } = appWith({
      tables: {
        workspaces: {
          update: (ctx) => {
            patch = ctx.values;
            filters = ctx.filters;
            return { data: [saved], error: null };
          },
        },
      },
    });

    const res = await json(app, "PATCH", "/workspace", { name: "Acme", defaultModel: "gpt-4o" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      id: WORKSPACE,
      name: "Acme",
      slug: "acme",
      defaultModel: "gpt-4o",
    });

    // camelCase in, snake_case out — and scoped to the caller's own workspace.
    expect(patch).toEqual({ name: "Acme", default_model: "gpt-4o" });
    expect(filters).toEqual([{ column: "id", value: WORKSPACE, kind: "eq" }]);
  });

  it("passes null through to clear the default model", async () => {
    // `undefined` means "leave it alone" and `null` means "clear it". Collapsing
    // the two would make the model impossible to unset.
    let patch: Record<string, unknown> | undefined;
    const { app } = appWith({
      tables: {
        workspaces: {
          update: (ctx) => {
            patch = ctx.values;
            return { data: [{ ...saved, default_model: null }], error: null };
          },
        },
      },
    });

    const res = await json(app, "PATCH", "/workspace", { defaultModel: null });

    expect(res.status).toBe(200);
    expect(patch).toEqual({ default_model: null });
    await expect(res.json()).resolves.toMatchObject({ defaultModel: null });
  });

  it("leaves the model alone when the request does not mention it", async () => {
    let patch: Record<string, unknown> | undefined;
    const { app } = appWith({
      tables: {
        workspaces: {
          update: (ctx) => {
            patch = ctx.values;
            return { data: [saved], error: null };
          },
        },
      },
    });

    await json(app, "PATCH", "/workspace", { name: "Acme" });

    expect(patch).toEqual({ name: "Acme" });
    expect(patch).not.toHaveProperty("default_model");
  });

  it.each([
    ["an empty body", {}],
    ["a model this build does not support", { defaultModel: "gpt-5-turbo" }],
    ["an empty name", { name: "" }],
  ])("refuses %s", async (_label, body) => {
    const { app } = appWith({});

    expect((await json(app, "PATCH", "/workspace", body)).status).toBe(400);
  });

  it("answers 403 when RLS matched no row", async () => {
    // A member who is not an admin. The update succeeds and changes nothing,
    // which must not be reported as a save.
    const { app } = appWith({
      tables: { workspaces: { update: () => ({ data: [], error: null }) } },
    });

    const res = await json(app, "PATCH", "/workspace", { name: "Acme" });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "only workspace admins can update the workspace",
    });
  });

  it("answers 404 when the caller has no workspace", async () => {
    const { app } = appWith({ tables: NO_WORKSPACE });

    expect((await json(app, "PATCH", "/workspace", { name: "Acme" })).status).toBe(404);
  });
});

describe("GET /workspaces", () => {
  it("returns each workspace with the caller's role in it", async () => {
    const { app } = appWith({
      tables: {
        workspace_members: {
          select: () => ({
            data: [
              { workspace_id: "ws-1", role: "admin" },
              { workspace_id: "ws-2", role: "member" },
            ],
            error: null,
          }),
        },
        workspaces: {
          select: () => ({
            data: [
              { id: "ws-1", name: "Acme", slug: "acme" },
              { id: "ws-2", name: "Beta", slug: "beta" },
            ],
            error: null,
          }),
        },
      },
    });

    const res = await json(app, "GET", "/workspaces");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      { id: "ws-1", name: "Acme", slug: "acme", role: "admin" },
      { id: "ws-2", name: "Beta", slug: "beta", role: "member" },
    ]);
  });

  it("asks only for the workspaces the caller is a member of", async () => {
    const { app, callsTo } = appWith({
      tables: {
        workspace_members: {
          select: () => ({ data: [{ workspace_id: "ws-1", role: "admin" }], error: null }),
        },
        workspaces: {
          select: () => ({ data: [{ id: "ws-1", name: "Acme", slug: "acme" }], error: null }),
        },
      },
    });

    await json(app, "GET", "/workspaces");

    expect(callsTo("workspace_members")[0].filters).toEqual([
      { column: "user_id", value: USER.id, kind: "eq" },
    ]);
    expect(callsTo("workspaces")[0].filters).toEqual([
      { column: "id", value: ["ws-1"], kind: "in" },
    ]);
  });

  it("returns an empty list without querying workspaces when there are no memberships", async () => {
    // No `workspaces` handler: reaching that table would throw.
    const { app } = appWith({
      tables: { workspace_members: { select: () => ({ data: [], error: null }) } },
    });

    const res = await json(app, "GET", "/workspaces");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([]);
  });

  it("does not hide a failed membership read behind an empty list", async () => {
    const { app } = appWith({
      tables: {
        workspace_members: { select: () => ({ data: null, error: { message: "boom" } }) },
      },
    });

    expect((await json(app, "GET", "/workspaces")).status).toBe(500);
  });
});

describe("POST /workspaces", () => {
  it("creates through the database function and returns the new id", async () => {
    let args: Record<string, unknown> | undefined;
    const { app } = appWith({
      rpc: {
        create_workspace: (received) => {
          args = received;
          return { data: "ws-new", error: null };
        },
      },
    });

    const res = await json(app, "POST", "/workspaces", { name: "  Acme  " });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ id: "ws-new" });
    // The schema trims, so the workspace is not created with padding in its name.
    expect(args).toEqual({ p_name: "Acme" });
  });

  it.each([
    ["a blank name", { name: "   " }],
    ["a missing name", {}],
    ["a name over the limit", { name: "x".repeat(101) }],
  ])("refuses %s", async (_label, body) => {
    const { app } = appWith({});

    expect((await json(app, "POST", "/workspaces", body)).status).toBe(400);
  });

  it("surfaces the reason the database function refused", async () => {
    const { app } = appWith({
      rpc: {
        create_workspace: () => ({ data: null, error: { message: "slug already taken" } }),
      },
    });

    const res = await json(app, "POST", "/workspaces", { name: "Acme" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "slug already taken" });
  });
});

describe("POST /workspace/active", () => {
  it("switches to a workspace the caller belongs to", async () => {
    let patch: Record<string, unknown> | undefined;
    const { app } = appWith({
      tables: {
        workspace_members: {
          select: () => ({ data: { workspace_id: "ws-2" }, error: null }),
        },
        profiles: {
          select: () => ({ data: { active_workspace_id: WORKSPACE }, error: null }),
          update: (ctx) => {
            patch = ctx.values;
            return { data: null, error: null };
          },
        },
      },
    });

    const res = await json(app, "POST", "/workspace/active", { workspaceId: "ws-2" });

    expect(res.status).toBe(200);
    expect(patch).toEqual({ active_workspace_id: "ws-2" });
  });

  it("refuses a workspace the caller does not belong to, and writes nothing", async () => {
    // The check that stops workspace switching from becoming a way into any
    // tenant whose id you happen to know.
    let profileWritten = false;
    const { app } = appWith({
      tables: {
        workspace_members: { select: () => ({ data: null, error: null }) },
        profiles: {
          select: () => ({ data: { active_workspace_id: WORKSPACE }, error: null }),
          update: () => {
            profileWritten = true;
            return { data: null, error: null };
          },
        },
      },
    });

    const res = await json(app, "POST", "/workspace/active", { workspaceId: "someone-elses" });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "not a member of that workspace" });
    expect(profileWritten).toBe(false);
  });

  it("refuses a request with no workspace id", async () => {
    const { app } = appWith({});

    expect((await json(app, "POST", "/workspace/active", {})).status).toBe(400);
  });

  it("does not switch when the membership check itself failed", async () => {
    const { app } = appWith({
      tables: {
        workspace_members: { select: () => ({ data: null, error: { message: "boom" } }) },
      },
    });

    expect((await json(app, "POST", "/workspace/active", { workspaceId: "ws-2" })).status).toBe(
      500,
    );
  });
});

describe("PATCH /workspace/members/:userId", () => {
  it("changes a role within the caller's own workspace", async () => {
    let ctx: QueryContext | undefined;
    const { app } = appWith({
      tables: {
        workspace_members: {
          select: () => ({ data: { workspace_id: WORKSPACE }, error: null }),
          update: (received) => {
            ctx = received;
            return { data: [{ user_id: "user-2", role: "admin" }], error: null };
          },
        },
      },
    });

    const res = await json(app, "PATCH", "/workspace/members/user-2", { role: "admin" });

    expect(res.status).toBe(200);
    expect(ctx?.values).toEqual({ role: "admin" });
    // Both filters matter: without workspace_id, an admin of one workspace could
    // change that user's role in a different one.
    expect(ctx?.filters).toEqual([
      { column: "workspace_id", value: WORKSPACE, kind: "eq" },
      { column: "user_id", value: "user-2", kind: "eq" },
    ]);
  });

  it("answers 403 when RLS matched no row", async () => {
    const { app } = appWith({
      tables: {
        workspace_members: {
          select: () => ({ data: { workspace_id: WORKSPACE }, error: null }),
          update: () => ({ data: [], error: null }),
        },
      },
    });

    const res = await json(app, "PATCH", "/workspace/members/user-2", { role: "admin" });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: "only workspace admins can manage members",
    });
  });

  it("answers in its own words when the last-admin trigger fires, not the driver's", async () => {
    // Demoting the only admin raises in Postgres. The trigger's own sentence is
    // fine to read, but reflecting driver messages verbatim is what this route
    // no longer does for any error — see "member routes do not echo the
    // database" below — so this one gets the same static answer as the rest.
    const { app } = appWith({
      tables: {
        workspace_members: {
          select: () => ({ data: { workspace_id: WORKSPACE }, error: null }),
          update: () => ({
            data: null,
            error: { code: "P0001", message: "cannot remove the last admin of a workspace" },
          }),
        },
      },
    });

    const res = await json(app, "PATCH", "/workspace/members/user-1", { role: "member" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "failed to update member" });
  });

  it.each([
    ["a role that does not exist", { role: "owner" }],
    ["no role at all", {}],
  ])("refuses %s", async (_label, body) => {
    const { app } = appWith({});

    expect((await json(app, "PATCH", "/workspace/members/user-2", body)).status).toBe(400);
  });
});

describe("DELETE /workspace/members/:userId", () => {
  it("removes a member from the caller's own workspace", async () => {
    let ctx: QueryContext | undefined;
    const { app } = appWith({
      tables: {
        workspace_members: {
          select: () => ({ data: { workspace_id: WORKSPACE }, error: null }),
          delete: (received) => {
            ctx = received;
            return { data: [{ user_id: "user-2" }], error: null };
          },
        },
      },
    });

    const res = await json(app, "DELETE", "/workspace/members/user-2");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    expect(ctx?.filters).toEqual([
      { column: "workspace_id", value: WORKSPACE, kind: "eq" },
      { column: "user_id", value: "user-2", kind: "eq" },
    ]);
  });

  it("answers 403 rather than pretending to have removed someone", async () => {
    const { app } = appWith({
      tables: {
        workspace_members: {
          select: () => ({ data: { workspace_id: WORKSPACE }, error: null }),
          delete: () => ({ data: [], error: null }),
        },
      },
    });

    expect((await json(app, "DELETE", "/workspace/members/user-2")).status).toBe(403);
  });

  it("answers 404 when the caller has no workspace to remove anyone from", async () => {
    const { app } = appWith({ tables: NO_WORKSPACE });

    expect((await json(app, "DELETE", "/workspace/members/user-2")).status).toBe(404);
  });
});

describe("member routes do not echo the database", () => {
  // 22P02 is Postgres's "invalid input syntax" — reachable here because the
  // path segment goes straight into an `.eq("user_id", ...)` with no format
  // check in front of it. The driver's own sentence for it ("invalid input
  // syntax for type uuid: \"notauuid\"") is harmless on its own, but it is the
  // same code path that would otherwise echo a constraint name for any
  // constraint added later — see the file-level test above.
  it("returns our own sentence for a malformed member id on update", async () => {
    const { app } = appWith({
      tables: {
        workspace_members: {
          select: () => ({ data: { workspace_id: WORKSPACE }, error: null }),
          update: () => ({
            data: null,
            error: { code: "22P02", message: 'invalid input syntax for type uuid: "notauuid"' },
          }),
        },
      },
    });

    const res = await json(app, "PATCH", "/workspace/members/notauuid", { role: "member" });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid member id" });
  });

  it("returns our own sentence for a malformed member id on delete", async () => {
    const { app } = appWith({
      tables: {
        workspace_members: {
          select: () => ({ data: { workspace_id: WORKSPACE }, error: null }),
          delete: () => ({
            data: null,
            error: { code: "22P02", message: 'invalid input syntax for type uuid: "notauuid"' },
          }),
        },
      },
    });

    const res = await json(app, "DELETE", "/workspace/members/notauuid");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "invalid member id" });
  });

  it("still says something useful for an error it does not recognise", async () => {
    const { app } = appWith({
      tables: {
        workspace_members: {
          select: () => ({ data: { workspace_id: WORKSPACE }, error: null }),
          delete: () => ({ data: null, error: { code: "XX000", message: "internal detail" } }),
        },
      },
    });

    const res = await json(app, "DELETE", "/workspace/members/user-2");

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "failed to remove member" });
  });
});

describe("DELETE /workspace/members/me", () => {
  /**
   * `workspace_members` is read twice on this path — once by
   * getActiveWorkspaceId, filtered by user AND workspace, and once by the
   * handler for every membership the caller has. Telling them apart by their
   * filters is the point: a fake that answered both the same way would hide a
   * handler that counted the wrong thing.
   */
  function memberOf(workspaceIds: string[], onDelete: () => ReturnType<Handler>) {
    return {
      workspace_members: {
        select: (ctx: QueryContext) => {
          const scoped = ctx.filters.some((f) => f.column === "workspace_id");
          if (scoped) return { data: { workspace_id: WORKSPACE }, error: null };
          return { data: workspaceIds.map((workspace_id) => ({ workspace_id })), error: null };
        },
        delete: onDelete,
      },
    };
  }

  it("leaves the workspace the caller is currently in", async () => {
    const { app, callsTo } = appWith({
      tables: memberOf([WORKSPACE, "ws-2"], () => ({
        data: [{ user_id: USER.id }],
        error: null,
      })),
    });

    const res = await json(app, "DELETE", "/workspace/members/me");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });

    // "me" must never reach the database as a user id — that is what the route
    // ordering in workspace.ts is protecting, and it is invisible from types.
    const removal = callsTo("workspace_members").find((c) => c.op === "delete");
    expect(removal?.filters).toEqual([
      { column: "workspace_id", value: WORKSPACE, kind: "eq" },
      { column: "user_id", value: USER.id, kind: "eq" },
    ]);
  });

  it("refuses to leave the caller with nowhere to be", async () => {
    let deleted = false;
    const { app } = appWith({
      tables: memberOf([WORKSPACE], () => {
        deleted = true;
        return { data: [{ user_id: USER.id }], error: null };
      }),
    });

    const res = await json(app, "DELETE", "/workspace/members/me");

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "this is your only workspace — you would have nowhere to go",
    });
    expect(deleted, "the row was removed before the check could stop it").toBe(false);
  });

  it("explains the last-admin refusal instead of forwarding the trigger's wording", async () => {
    // plpgsql `raise exception` arrives as the generic P0001, so the phrase is
    // all there is to match on — and a message about a trigger is not something
    // to put in front of somebody pressing "Leave".
    const { app } = appWith({
      tables: memberOf([WORKSPACE, "ws-2"], () => ({
        data: null,
        error: { message: "cannot remove the last admin of a workspace", code: "P0001" },
      })),
    });

    const res = await json(app, "DELETE", "/workspace/members/me");

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: "make someone else an admin first — a workspace cannot be left without one",
    });
  });

  it("answers 404 when the membership is already gone", async () => {
    const { app } = appWith({
      tables: memberOf([WORKSPACE, "ws-2"], () => ({ data: [], error: null })),
    });

    expect((await json(app, "DELETE", "/workspace/members/me")).status).toBe(404);
  });

  it("answers 404 when the caller has no workspace at all", async () => {
    const { app } = appWith({ tables: NO_WORKSPACE });

    expect((await json(app, "DELETE", "/workspace/members/me")).status).toBe(404);
  });
});

/**
 * The one number an admin can learn about somebody else's credentials.
 *
 * `api_keys` is own-keys-only in 0033, deliberately and with the header to say
 * why. This route is the exception carved for the removal dialog, and it is
 * carved in the database rather than here — so what these tests are about is
 * that the route does not add a second opinion on top of a definer function
 * that already refused, and does not leak anything but the count.
 */
describe("GET /workspace/members/:userId/key-count", () => {
  const rpcReturning = (result: { data: unknown; error: unknown }) => ({
    workspace_api_key_count: () => result as never,
  });

  it("answers with the count and nothing that identifies a key", async () => {
    const { app } = appWith({ rpc: rpcReturning({ data: 3, error: null }) });

    const res = await json(app, "GET", "/workspace/members/user-2/key-count");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ count: 3 });
  });

  it("asks about the caller's own workspace, never one named in the URL", async () => {
    let args: Record<string, unknown> = {};
    const { app } = appWith({
      rpc: {
        workspace_api_key_count: (received) => {
          args = received;
          return { data: 0, error: null } as never;
        },
      },
    });

    await json(app, "GET", "/workspace/members/user-2/key-count");

    expect(args.p_workspace_id).toBe(WORKSPACE);
    expect(args.p_user_id).toBe("user-2");
  });

  it("passes the function's own refusal through as a 403", async () => {
    // 0033 raises rather than answering zero, precisely so this is not
    // indistinguishable from somebody who has no keys.
    const { app } = appWith({
      rpc: rpcReturning({ data: null, error: { code: "42501", message: "not an admin" } }),
    });

    expect((await json(app, "GET", "/workspace/members/user-2/key-count")).status).toBe(403);
  });

  it.each(["PGRST202", "42883"])(
    "answers a null count while the migration is unapplied (%s)",
    async (code) => {
      // CI does not apply migrations. A count the dialog cannot get is a
      // sentence it leaves out, not an error it puts in front of somebody
      // trying to remove a member.
      const { app } = appWith({
        rpc: rpcReturning({ data: null, error: { code, message: "no such function" } }),
      });

      const res = await json(app, "GET", "/workspace/members/user-2/key-count");

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ count: null });
    },
  );

  it("still fails loudly on anything else", async () => {
    const { app } = appWith({
      rpc: rpcReturning({ data: null, error: { code: "57014", message: "canceling statement" } }),
    });

    expect((await json(app, "GET", "/workspace/members/user-2/key-count")).status).toBe(500);
  });
});
