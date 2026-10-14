import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../types";
import { fakeDb, type FakeDbSpec, type QueryContext } from "../test-support/fake-db";
import { account, planWorkspaces } from "./account";

// A real uuid, because the photo cleanup only deletes a key under the caller's own id.
const USER = { id: "0b6f3c1e-2a4d-4e8f-9a1b-3c5d7e9f1a2b", email: "a@example.com" };

const deleteUser = vi.fn();

const MAIL_ENV = { RESEND_API_KEY: "re_test", RESEND_FROM: "Covan <hello@covan.test>" };
const serviceFrom = vi.fn();
/** `delete_workspace_if_sole_member` (0091), the one rpc the service client makes. */
const serviceRpc = vi.fn();
const storeDelete = vi.fn();
vi.mock("../lib/supabase", () => ({
  serviceClient: () => ({ from: serviceFrom, rpc: serviceRpc, auth: { admin: { deleteUser } } }),
}));
vi.mock("../lib/docstore", () => ({ getDocStore: () => ({ delete: storeDelete }) }));

/** Which provider profiles were handed back, and whether the provider refused. */
const deletedProfiles: string[] = [];
let profileDeleteFails = false;
vi.mock("../lib/browser/profiles", () => ({
  deleteProfile: (_env: unknown, id: string) => {
    deletedProfiles.push(id);
    return Promise.resolve(
      profileDeleteFails
        ? { kind: "error" as const, status: 500, message: "boom" }
        : { kind: "ok" as const, value: null },
    );
  },
}));

/**
 * The service-role client's reads: two `select().in()` for the storage keys,
 * one for the Composio accounts to revoke, and the browser profile. Workspace
 * deletes go through `serviceRpc` (0091) instead.
 */
function serviceTables(spec: {
  bundles?: { id: string }[];
  documents?: { r2_key: string | null }[];
  connections?: { connected_account_id: string | null }[];
  readError?: boolean;
  /** The row `browser_profiles` answers with, or null for somebody who never took over a browser. */
  browserProfile?: { provider_profile_id: string } | null;
}) {
  return (table: string) => {
    const result =
      table === "knowledge_bundles"
        ? { data: spec.bundles ?? [], error: spec.readError ? { message: "boom" } : null }
        : table === "documents"
          ? { data: spec.documents ?? [], error: spec.readError ? { message: "boom" } : null }
          : table === "tool_connections"
            ? { data: spec.connections ?? [], error: null }
            : table === "browser_profiles"
              ? {
                  data: spec.browserProfile === undefined ? null : spec.browserProfile,
                  error: null,
                }
              : { data: null, error: null };

    const link = {
      select: () => link,
      in: () => link,
      eq: () => link,
      // The documents read is paged (`lib/batch.ts`); one short page ends it.
      order: () => link,
      range: () => Promise.resolve(result),
      // The browser-profile read is the one `maybeSingle` call the erasure
      // path makes — it wants one row or none, not a list.
      maybeSingle: () => Promise.resolve(result),
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
  /** The caller's own `profiles.avatar_url`; null for somebody with no photo. */
  avatarUrl?: string | null;
}) {
  const dbSpec: FakeDbSpec = {
    rpc: {
      // What `account_closure_plan()` (0091) answers: counted per workspace
      // the caller is in, the way the SQL aggregate does it.
      account_closure_plan: () => {
        if (spec.membershipsError) return { data: null, error: { message: "boom" } };
        return {
          data: spec.members
            .filter((m) => m.user_id === USER.id)
            .map((mine) => {
              const others = spec.members.filter(
                (m) => m.workspace_id === mine.workspace_id && m.user_id !== USER.id,
              );
              return {
                workspace_id: mine.workspace_id,
                role: mine.role,
                other_members: others.length,
                other_admins: others.filter((m) => m.role === "admin").length,
              };
            }),
          error: null,
        };
      },
    },
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
      profiles: {
        select: () => ({ data: { avatar_url: spec.avatarUrl ?? null }, error: null }),
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
  deletedProfiles.length = 0;
  profileDeleteFails = false;
  vi.clearAllMocks();
  deleteUser.mockResolvedValue({ data: null, error: null });
  storeDelete.mockResolvedValue(undefined);
  serviceFrom.mockImplementation(serviceTables({}));
  serviceRpc.mockResolvedValue({ data: true, error: null });
});

describe("planWorkspaces", () => {
  const row = (workspace_id: string, role: string, other_members: number, other_admins = 0) => ({
    workspace_id,
    role,
    other_members,
    other_admins,
  });

  it("deletes a workspace nobody else is in", () => {
    expect(planWorkspaces([row("ws-1", "admin", 0)])).toEqual({ blocked: [], deletable: ["ws-1"] });
  });

  it("blocks a workspace where the caller is the only admin and others remain", () => {
    expect(planWorkspaces([row("ws-1", "admin", 1, 0)])).toEqual({
      blocked: ["ws-1"],
      deletable: [],
    });
  });

  it("lets the account go when another admin is left to hold it", () => {
    // Neither blocked nor deleted: the workspace keeps running without them,
    // which is what `0016`'s "attribution survives its author" means in practice.
    expect(planWorkspaces([row("ws-1", "admin", 1, 1)])).toEqual({ blocked: [], deletable: [] });
  });

  it("does not block a member who was never an admin", () => {
    // A workspace with no admin at all is somebody else's problem and not a
    // reason to refuse this person their erasure.
    expect(planWorkspaces([row("ws-1", "member", 1, 0)])).toEqual({ blocked: [], deletable: [] });
  });

  it("deletes a sole membership even when the role is not admin", () => {
    // The trigger would allow this row to go and leave an empty room behind.
    expect(planWorkspaces([row("ws-1", "member", 0)])).toEqual({
      blocked: [],
      deletable: ["ws-1"],
    });
  });

  it("reads a count PostgREST sent as a string", () => {
    // `count()` is a bigint, and a bigint can arrive as a string.
    const plan = planWorkspaces([
      { workspace_id: "big", role: "member", other_members: "1000" as never, other_admins: 0 },
    ]);
    expect(plan).toEqual({ blocked: [], deletable: [] });
  });

  it("sorts a mixed set into both piles at once", () => {
    const plan = planWorkspaces([
      row("solo", "admin", 0),
      row("team", "admin", 1, 0),
      row("guest", "member", 1, 1),
    ]);
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
    serviceRpc.mockImplementation(async (_name: string, args: { p_workspace_id: string }) => {
      order.push(`workspaces:${args.p_workspace_id}`);
      return { data: true, error: null };
    });
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

  it("asks for the delete only on condition nobody else is in the workspace", async () => {
    const app = appWith({
      members: [{ workspace_id: "solo", user_id: USER.id, role: "admin" }],
    });
    await close(app);

    // The plan is a moment old by the time the delete runs. The function
    // re-checks membership in the same statement (0091), so a workspace
    // somebody joined in between is not taken with this account.
    expect(serviceRpc).toHaveBeenCalledWith("delete_workspace_if_sole_member", {
      p_workspace_id: "solo",
      p_user_id: USER.id,
    });
    expect(serviceFrom).not.toHaveBeenCalledWith("workspaces");
  });

  it("stops when somebody joined a workspace between the plan and the delete", async () => {
    serviceRpc.mockResolvedValue({ data: false, error: null });
    const app = appWith({
      members: [{ workspace_id: "solo", user_id: USER.id, role: "admin" }],
    });
    const { status } = await close(app);

    expect(status).toBe(409);
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it("leaves the account alone when a workspace cannot be deleted", async () => {
    serviceRpc.mockResolvedValue({ data: null, error: { message: "nope" } });
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

  /**
   * The one receipt a closed account gets.
   *
   * Everything else about this action disappears with it: there is no row left
   * to check, no screen to come back to, and no way to sign in and confirm.
   * Under the KVKK and the GDPR the erasure is the obligation and the record of
   * it is what makes the obligation demonstrable — for the person as much as for
   * the operator.
   */
  it("sends a receipt once the account is really gone", async () => {
    const sent: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async (_i: unknown, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);

    const app = appWith({ members: [] });
    const res = await app.request("/account", { method: "DELETE" }, MAIL_ENV as never);

    expect(res.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toEqual([USER.email]);
  });

  // A receipt for a deletion that did not happen is worse than none: it tells
  // somebody their data is gone while it is still there.
  it("sends no receipt when the deletion failed", async () => {
    const sent: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((async () => {
      sent.push(1);
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch);
    deleteUser.mockResolvedValue({ data: null, error: { message: "still referenced" } });

    const app = appWith({ members: [{ workspace_id: "solo", user_id: USER.id, role: "admin" }] });
    const res = await app.request("/account", { method: "DELETE" }, MAIL_ENV as never);

    expect(res.status).toBe(500);
    expect(sent).toEqual([]);
  });

  it("closes an account that belongs to no workspace at all", async () => {
    const app = appWith({ members: [] });
    const { status } = await close(app);

    expect(status).toBe(200);
    // Two service-role reads even with nothing to delete, and they are the
    // right two: a person can have taken over a browser without owning a
    // workspace, and that cookie jar still has to be handed back; and a source
    // they connected stays theirs in a workspace they have since left, and its
    // grant still has to be let go.
    expect(serviceFrom.mock.calls.map((c) => c[0]).sort()).toEqual([
      "browser_profiles",
      "connections",
    ]);
    expect(deleteUser).toHaveBeenCalledWith(USER.id);
  });

  it("deletes the browser profile of a closing account", async () => {
    serviceFrom.mockImplementation(
      serviceTables({ browserProfile: { provider_profile_id: "prov-1" } }),
    );
    const app = appWith({ members: [] });
    const { status } = await close(app);

    expect(status).toBe(200);
    // Read before the cascade can take the row with it: browser_profiles
    // cascades from auth.users, and a cascade runs no code, so the jar of live
    // session cookies would otherwise be left at the provider with nothing in
    // this database able to name it.
    expect(deletedProfiles).toEqual(["prov-1"]);
  });

  it("still closes the account when the provider will not delete the profile", async () => {
    profileDeleteFails = true;
    serviceFrom.mockImplementation(
      serviceTables({ browserProfile: { provider_profile_id: "prov-1" } }),
    );
    const app = appWith({ members: [] });
    const { status } = await close(app);

    // The same judgement revokeConnectedAccounts makes one line up: refusing
    // to close an account over a third party's 500 is the worse outcome.
    expect(status).toBe(200);
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

  // The one stored object that belongs to a person rather than a workspace.
  // Its key lives on the profile row, which goes with the user, so it has to
  // be read first and deleted with the rest once the account is really gone.
  it("removes an uploaded profile photo, after the user is gone", async () => {
    const avatar = `avatars/${USER.id}/0123456789abcdef0123456789abcdef.png`;
    const order: string[] = [];
    deleteUser.mockImplementation(async () => {
      order.push("deleteUser");
      return { data: null, error: null };
    });
    storeDelete.mockImplementation(async (key: string) => {
      order.push(key);
    });
    const app = appWith({
      members: [{ workspace_id: "solo", user_id: USER.id, role: "admin" }],
      avatarUrl: `/${avatar}`,
    });
    const { status } = await close(app);

    expect(status).toBe(200);
    expect(order).toEqual(["deleteUser", avatar]);
  });

  it("deletes no photo for somebody without one, with a provider's, or with somebody else's", async () => {
    for (const avatarUrl of [
      null,
      "https://lh3.example.com/a/photo.jpg",
      // A co-member's photo path, written into this row by hand: theirs, not
      // this account's, so closing this account must not delete it.
      "/avatars/11111111-2222-4333-8444-555555555555/0123456789abcdef0123456789abcdef.png",
    ]) {
      const app = appWith({
        members: [{ workspace_id: "solo", user_id: USER.id, role: "admin" }],
        avatarUrl,
      });
      expect((await close(app)).status).toBe(200);
    }
    expect(storeDelete).not.toHaveBeenCalled();
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
