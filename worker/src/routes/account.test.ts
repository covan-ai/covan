import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec, type QueryContext } from "../test-support/fake-db";
import { account, planWorkspaces } from "./account";

const USER = { id: "user-1", email: "a@example.com" };

const deleteUser = vi.fn();
const serviceFrom = vi.fn();
const storeDelete = vi.fn();
vi.mock("../lib/supabase", () => ({
  serviceClient: () => ({ from: serviceFrom, auth: { admin: { deleteUser } } }),
}));
vi.mock("../lib/docstore", () => ({ getDocStore: () => ({ delete: storeDelete }) }));

/**
 * The service-role client, which this route uses for three different shapes:
 * two `select().in()` reads for the storage keys and one `delete().eq()` per
 * workspace. One builder answers all three, and records which ids were deleted.
 */
function serviceTables(spec: {
  bundles?: { id: string }[];
  documents?: { r2_key: string | null }[];
  deleteError?: { message: string };
  onDelete?: (table: string, id: string) => void;
  readError?: boolean;
}) {
  return (table: string) => {
    const result =
      table === "knowledge_bundles"
        ? { data: spec.bundles ?? [], error: spec.readError ? { message: "boom" } : null }
        : table === "documents"
          ? { data: spec.documents ?? [], error: spec.readError ? { message: "boom" } : null }
          : { data: null, error: spec.deleteError ?? null };

    const link = {
      select: () => link,
      in: () => link,
      delete: () => link,
      eq: (_column: string, value: string) => {
        spec.onDelete?.(table, value);
        return link;
      },
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
    };
    return link;
  };
}

type Member = { workspace_id: string; user_id: string; role: string };

/**
 * @param members every membership row the caller's own client can see — their
 * own rows and their fellow members', exactly as
 * `workspace_members_select_fellow_members` grants.
 * @param apiKeyId set it to pretend the caller arrived with a key rather than a
 * session.
 */
function appWith(spec: {
  members: Member[];
  names?: Record<string, string>;
  apiKeyId?: string;
  membershipsError?: boolean;
}) {
  const dbSpec: FakeDbSpec = {
    tables: {
      workspace_members: {
        select: (ctx: QueryContext) => {
          if (spec.membershipsError) return { data: null, error: { message: "boom" } };
          // The two reads are told apart the way the route makes them: the
          // first is scoped by `eq("user_id")`, the second by `in("workspace_id")`.
          const own = ctx.filters.some((f) => f.column === "user_id" && f.kind === "eq");
          if (own) {
            return {
              data: spec.members
                .filter((m) => m.user_id === USER.id)
                .map((m) => ({ workspace_id: m.workspace_id, role: m.role })),
              error: null,
            };
          }
          const ids = (ctx.filters.find((f) => f.column === "workspace_id")?.value ??
            []) as string[];
          return { data: spec.members.filter((m) => ids.includes(m.workspace_id)), error: null };
        },
      },
      workspaces: {
        select: (ctx: QueryContext) => {
          const ids = (ctx.filters.find((f) => f.column === "id")?.value ?? []) as string[];
          return {
            data: ids.map((id) => ({ id, name: spec.names?.[id] ?? id })),
            error: null,
          };
        },
      },
    },
  };

  const { db } = fakeDb(dbSpec);
  const app = new Hono<AppEnv>();
  app.use("/*", async (c, next) => {
    c.set("user", USER as never);
    c.set("db", db as never);
    if (spec.apiKeyId) c.set("apiKeyId", spec.apiKeyId);
    await next();
  });
  app.route("/", account);
  return app;
}

async function close(app: Hono<AppEnv>) {
  const res = await app.request("/account", { method: "DELETE" }, {} as never);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  deleteUser.mockResolvedValue({ data: null, error: null });
  storeDelete.mockResolvedValue(undefined);
  serviceFrom.mockImplementation(serviceTables({}));
});

describe("planWorkspaces", () => {
  it("deletes a workspace nobody else is in", () => {
    const plan = planWorkspaces(
      "user-1",
      [{ workspace_id: "ws-1", role: "admin" }],
      [{ workspace_id: "ws-1", user_id: "user-1", role: "admin" }],
    );
    expect(plan).toEqual({ blocked: [], deletable: ["ws-1"] });
  });

  it("blocks a workspace where the caller is the only admin and others remain", () => {
    const plan = planWorkspaces(
      "user-1",
      [{ workspace_id: "ws-1", role: "admin" }],
      [
        { workspace_id: "ws-1", user_id: "user-1", role: "admin" },
        { workspace_id: "ws-1", user_id: "user-2", role: "member" },
      ],
    );
    expect(plan).toEqual({ blocked: ["ws-1"], deletable: [] });
  });

  it("lets the account go when another admin is left to hold it", () => {
    const plan = planWorkspaces(
      "user-1",
      [{ workspace_id: "ws-1", role: "admin" }],
      [
        { workspace_id: "ws-1", user_id: "user-1", role: "admin" },
        { workspace_id: "ws-1", user_id: "user-2", role: "admin" },
      ],
    );
    // Neither blocked nor deleted: the workspace keeps running without them,
    // which is what `0016`'s "attribution survives its author" means in practice.
    expect(plan).toEqual({ blocked: [], deletable: [] });
  });

  it("does not block a member who was never an admin", () => {
    const plan = planWorkspaces(
      "user-1",
      [{ workspace_id: "ws-1", role: "member" }],
      [
        { workspace_id: "ws-1", user_id: "user-1", role: "member" },
        { workspace_id: "ws-1", user_id: "user-2", role: "member" },
      ],
    );
    // A workspace with no admin at all is somebody else's problem and not a
    // reason to refuse this person their erasure.
    expect(plan).toEqual({ blocked: [], deletable: [] });
  });

  it("deletes a sole membership even when the role is not admin", () => {
    const plan = planWorkspaces(
      "user-1",
      [{ workspace_id: "ws-1", role: "member" }],
      [{ workspace_id: "ws-1", user_id: "user-1", role: "member" }],
    );
    // The trigger would allow this row to go and leave an empty room behind.
    expect(plan).toEqual({ blocked: [], deletable: ["ws-1"] });
  });

  it("sorts a mixed set into both piles at once", () => {
    const plan = planWorkspaces(
      "user-1",
      [
        { workspace_id: "solo", role: "admin" },
        { workspace_id: "team", role: "admin" },
        { workspace_id: "guest", role: "member" },
      ],
      [
        { workspace_id: "solo", user_id: "user-1", role: "admin" },
        { workspace_id: "team", user_id: "user-1", role: "admin" },
        { workspace_id: "team", user_id: "user-2", role: "member" },
        { workspace_id: "guest", user_id: "user-1", role: "member" },
        { workspace_id: "guest", user_id: "user-3", role: "admin" },
      ],
    );
    expect(plan).toEqual({ blocked: ["team"], deletable: ["solo"] });
  });
});

describe("DELETE /account", () => {
  it("refuses a caller who arrived with an API key", async () => {
    const app = appWith({
      members: [{ workspace_id: "ws-1", user_id: USER.id, role: "admin" }],
      apiKeyId: "key-1",
    });
    const { status, body } = await close(app);

    expect(status).toBe(403);
    expect(body.error).toMatch(/api keys cannot close an account/);
    // The refusal has to come before anything irreversible, not alongside it.
    expect(deleteUser).not.toHaveBeenCalled();
    expect(serviceFrom).not.toHaveBeenCalled();
  });

  it("names the workspaces standing in the way instead of counting them", async () => {
    const app = appWith({
      members: [
        { workspace_id: "ws-1", user_id: USER.id, role: "admin" },
        { workspace_id: "ws-1", user_id: "user-2", role: "member" },
      ],
      names: { "ws-1": "Acme" },
    });
    const { status, body } = await close(app);

    expect(status).toBe(409);
    expect(body.error).toContain("Acme");
    expect(body.workspaces).toEqual(["Acme"]);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("deletes the workspace before the user", async () => {
    const order: string[] = [];
    serviceFrom.mockImplementation(
      serviceTables({ onDelete: (table, id) => order.push(`${table}:${id}`) }),
    );
    deleteUser.mockImplementation(async () => {
      order.push("user");
      return { data: null, error: null };
    });

    const app = appWith({
      members: [{ workspace_id: "solo", user_id: USER.id, role: "admin" }],
    });
    const { status, body } = await close(app);

    expect(status).toBe(200);
    expect(body).toEqual({ ok: true });
    // One ordering left, and it is the one this file can actually see: the
    // workspace goes before the user, because the last-admin trigger refuses
    // the membership row while its workspace still stands.
    //
    // This list used to open with `ideas:solo` and `chat_sessions:solo`,
    // because neither reference cascaded and the workspace delete failed on a
    // foreign key until they were cleared. **CI found that, not this file** —
    // these mocks answer whatever they are told to and cannot see a
    // constraint. 0035 made both cascade; the guarantee now lives in
    // `tests/rls/deletion.test.ts`, against a real database, which is the only
    // place it could ever have lived.
    expect(order).toEqual(["workspaces:solo", "user"]);
  });

  it("leaves the account alone when a workspace cannot be deleted", async () => {
    serviceFrom.mockImplementation(serviceTables({ deleteError: { message: "nope" } }));
    const app = appWith({
      members: [{ workspace_id: "solo", user_id: USER.id, role: "admin" }],
    });
    const { status } = await close(app);

    expect(status).toBe(500);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("reports a failed deleteUser rather than claiming the account is gone", async () => {
    deleteUser.mockResolvedValue({ data: null, error: { message: "still referenced" } });
    const app = appWith({
      members: [{ workspace_id: "solo", user_id: USER.id, role: "admin" }],
    });
    const { status, body } = await close(app);

    expect(status).toBe(500);
    expect(body.error).toMatch(/failed to close your account/);
  });

  it("closes an account that belongs to no workspace at all", async () => {
    const app = appWith({ members: [] });
    const { status } = await close(app);

    expect(status).toBe(200);
    expect(serviceFrom).not.toHaveBeenCalled();
    expect(deleteUser).toHaveBeenCalledWith(USER.id);
  });

  it("removes the stored files of the workspaces it deletes", async () => {
    serviceFrom.mockImplementation(
      serviceTables({
        bundles: [{ id: "bundle-1" }],
        documents: [{ r2_key: "doc/one" }, { r2_key: null }, { r2_key: "doc/two" }],
      }),
    );
    const app = appWith({ members: [{ workspace_id: "solo", user_id: USER.id, role: "admin" }] });
    const { status } = await close(app);

    expect(status).toBe(200);
    // A row with no key is a document that was never uploaded, not a bug.
    expect(storeDelete.mock.calls.map((c) => c[0])).toEqual(["doc/one", "doc/two"]);
  });

  it("still closes the account when the storage listing fails", async () => {
    serviceFrom.mockImplementation(serviceTables({ readError: true }));
    const app = appWith({ members: [{ workspace_id: "solo", user_id: USER.id, role: "admin" }] });
    const { status } = await close(app);

    // Refusing somebody their erasure over a storage bookkeeping problem would
    // be the worse failure. The cost is bytes nobody can reach, and it is logged.
    expect(status).toBe(200);
    expect(deleteUser).toHaveBeenCalledWith(USER.id);
  });

  it("still closes the account when a stored file cannot be removed", async () => {
    serviceFrom.mockImplementation(
      serviceTables({ bundles: [{ id: "bundle-1" }], documents: [{ r2_key: "doc/one" }] }),
    );
    storeDelete.mockRejectedValue(new Error("r2 is having a day"));
    const app = appWith({ members: [{ workspace_id: "solo", user_id: USER.id, role: "admin" }] });
    const { status } = await close(app);

    // The user is already gone by this point — there is nobody left to report
    // it to, and answering 500 would tell them nothing happened when it did.
    expect(status).toBe(200);
  });

  it("does not delete anything when the membership survey fails", async () => {
    const app = appWith({ members: [], membershipsError: true });
    const { status } = await close(app);

    expect(status).toBe(500);
    expect(deleteUser).not.toHaveBeenCalled();
  });
});
