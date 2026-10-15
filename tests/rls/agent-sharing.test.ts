/**
 * An agent shared on purpose (0104).
 *
 * Until 0104 every member of a workspace saw every agent in it, and every
 * writer could change or delete any of them. Now whoever makes an agent
 * decides who else reaches it — nobody (Only me), named people, or the whole
 * workspace — and at what level: `use`, `edit` or `manage`. The maker and every
 * workspace admin always manage; a viewer never gets past `use`.
 *
 * The cast, all in `host`'s workspace unless said otherwise:
 *
 *   host      the workspace admin, who did not make any of these agents
 *   maker     a plain member who made them, and so manages them
 *   plain     a plain member nobody shared anything with
 *   useM      a member shared at `use`      ┐
 *   editM     a member shared at `edit`     │ on `personal`
 *   manageM   a member shared at `manage`   │
 *   viewerE   a viewer shared at `edit`     ┘ capped to `use`
 *   outsider  somebody in no part of this workspace
 *
 * and the agents, all made by `maker`:
 *
 *   personal   Only me + the four shares above
 *   wsUse      the workspace may use it;  editM raised to `edit` by name
 *   wsEdit     the workspace may edit it; useM "shared" at `use`, which must
 *              not lower them below what the workspace already gives
 *   wsManage   the workspace may manage it
 *
 * Every answer is read back through the policies a browser goes through, and
 * every write that should not have happened is checked as the service role,
 * so a refusal that hides a row cannot pass for one that kept it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  sql,
  type TestUser,
} from "./harness";
import type { AgentAccess } from "./fixtures";

type Access = AgentAccess | null;

let host: TestUser;
let maker: TestUser;
let plain: TestUser;
let useM: TestUser;
let editM: TestUser;
let manageM: TestUser;
let viewerE: TestUser;
let outsider: TestUser;

let personal: string;
let wsUse: string;
let wsEdit: string;
let wsManage: string;

/** The share list `personal` is held at. Tests that change it put it back. */
const personalShares = (): Array<{ user_id: string; access: AgentAccess }> => [
  { user_id: useM.id, access: "use" },
  { user_id: editM.id, access: "edit" },
  { user_id: manageM.id, access: "manage" },
  { user_id: viewerE.id, access: "edit" },
];

async function join(user: TestUser, role: "admin" | "member" | "viewer") {
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: host.workspaceId, user_id: user.id, role });
  if (error) throw new Error(`could not add ${user.email} as ${role}: ${error.message}`);
}

async function leave(user: TestUser) {
  const { error } = await serviceClient()
    .from("workspace_members")
    .delete()
    .eq("workspace_id", host.workspaceId)
    .eq("user_id", user.id);
  if (error) throw new Error(`could not remove ${user.email}: ${error.message}`);
}

async function setRole(user: TestUser, role: "member" | "viewer") {
  const { error } = await serviceClient()
    .from("workspace_members")
    .update({ role })
    .eq("workspace_id", host.workspaceId)
    .eq("user_id", user.id);
  if (error) throw new Error(`could not make ${user.email} a ${role}: ${error.message}`);
}

/** An agent in host's workspace, made through `by`'s own client. */
async function makeAgent(by: TestUser, name: string, workspaceAccess?: Access): Promise<string> {
  const values: Record<string, unknown> = {
    workspace_id: host.workspaceId,
    name,
    created_by: by.id,
  };
  if (workspaceAccess !== undefined) values.workspace_access = workspaceAccess;
  const { data, error } = await by.db.from("agents").insert(values).select("id").single();
  if (error || !data) throw new Error(`${by.email} could not make ${name}: ${error?.message}`);
  return data.id as string;
}

function setSharing(
  by: TestUser,
  agentId: string,
  workspaceAccess: Access,
  shares: Array<{ user_id: string; access: string }>,
) {
  return by.db.rpc("set_agent_sharing", {
    p_agent_id: agentId,
    p_workspace_access: workspaceAccess,
    p_shares: shares,
  });
}

async function mustShare(
  by: TestUser,
  agentId: string,
  workspaceAccess: Access,
  shares: Array<{ user_id: string; access: string }>,
) {
  const { error } = await setSharing(by, agentId, workspaceAccess, shares);
  if (error) throw new Error(`${by.email} could not share ${agentId}: ${error.message}`);
}

/**
 * The caller's level through the computed field, or `undefined` when the row
 * itself is not visible — which is a different answer from a visible row
 * saying null, and the matrix below tells them apart.
 */
async function myAccess(user: TestUser, agentId: string): Promise<string | null | undefined> {
  const { data, error } = await user.db
    .from("agents")
    .select("id, my_access")
    .eq("id", agentId)
    .maybeSingle();
  if (error) throw new Error(`my_access as ${user.email}: ${error.message}`);
  return data ? ((data.my_access as string | null) ?? null) : undefined;
}

/** `agent_access_for`, which only the service role may ask. */
async function accessFor(agentId: string, user: TestUser): Promise<string | null> {
  const { data, error } = await serviceClient().rpc("agent_access_for", {
    p_agent_id: agentId,
    p_user_id: user.id,
  });
  if (error) throw new Error(`agent_access_for: ${error.message}`);
  return (data as string | null) ?? null;
}

/** Read past RLS, so "hidden" and "gone" are told apart. */
async function rawAgent(agentId: string) {
  const { data } = await serviceClient()
    .from("agents")
    .select("id, persona, workspace_access, deleted_at")
    .eq("id", agentId)
    .maybeSingle();
  return data as {
    id: string;
    persona: string | null;
    workspace_access: string | null;
    deleted_at: string | null;
  } | null;
}

async function rawShares(agentId: string) {
  const { data } = await serviceClient()
    .from("agent_shares")
    .select("user_id, access, granted_by, workspace_id")
    .eq("agent_id", agentId);
  return (data ?? []) as Array<{
    user_id: string;
    access: string;
    granted_by: string | null;
    workspace_id: string;
  }>;
}

async function visible(user: TestUser, table: string, id: string): Promise<boolean> {
  const { data } = await user.db.from(table).select("id").eq("id", id);
  return (data ?? []).length > 0;
}

async function exists(table: string, id: string): Promise<boolean> {
  const { data } = await serviceClient().from(table).select("id").eq("id", id);
  return (data ?? []).length > 0;
}

/** Put `personal` back the way the matrix expects it, whatever a test did. */
async function resetPersonal() {
  await serviceClient()
    .from("agents")
    .update({ deleted_at: null, deleted_by: null, deleted_via: null })
    .eq("id", personal);
  await mustShare(maker, personal, null, personalShares());
}

beforeAll(async () => {
  host = await createTestUser("share-host");
  maker = await createTestUser("share-maker");
  plain = await createTestUser("share-plain");
  useM = await createTestUser("share-use");
  editM = await createTestUser("share-edit");
  manageM = await createTestUser("share-manage");
  viewerE = await createTestUser("share-viewer");
  outsider = await createTestUser("share-outsider");

  for (const user of [maker, plain, useM, editM, manageM]) await join(user, "member");
  await join(viewerE, "viewer");

  personal = await makeAgent(maker, "Only me, then a few people", null);
  wsUse = await makeAgent(maker, "Whole workspace may use", "use");
  wsEdit = await makeAgent(maker, "Whole workspace may edit", "edit");
  wsManage = await makeAgent(maker, "Whole workspace may manage", "manage");

  await mustShare(maker, personal, null, personalShares());
  await mustShare(maker, wsUse, "use", [{ user_id: editM.id, access: "edit" }]);
  await mustShare(maker, wsEdit, "edit", [{ user_id: useM.id, access: "use" }]);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

// ===========================================================================
// the matrix
// ===========================================================================

type Who = "host" | "maker" | "plain" | "useM" | "editM" | "manageM" | "viewerE" | "outsider";
const cast = (): Record<Who, TestUser> => ({
  host,
  maker,
  plain,
  useM,
  editM,
  manageM,
  viewerE,
  outsider,
});
const agents = () => ({ personal, wsUse, wsEdit, wsManage });

/**
 * What each person may do with each agent. `undefined` is "cannot see it":
 * the computed field cannot answer for a row the select policy withholds, and
 * `agent_access_for` answers null.
 */
const EXPECTED: Record<
  "personal" | "wsUse" | "wsEdit" | "wsManage",
  Record<Who, Access | undefined>
> = {
  personal: {
    host: "manage",
    maker: "manage",
    plain: undefined,
    useM: "use",
    editM: "edit",
    manageM: "manage",
    viewerE: "use", // shared at edit, capped
    outsider: undefined,
  },
  wsUse: {
    host: "manage",
    maker: "manage",
    plain: "use",
    useM: "use",
    editM: "edit", // a share raises one person above the workspace
    manageM: "use",
    viewerE: "use",
    outsider: undefined,
  },
  wsEdit: {
    host: "manage",
    maker: "manage",
    plain: "edit",
    useM: "edit", // a share below the workspace's level does not lower it
    editM: "edit",
    manageM: "edit",
    viewerE: "use", // the workspace's edit is capped too
    outsider: undefined,
  },
  wsManage: {
    host: "manage",
    maker: "manage",
    plain: "manage",
    useM: "manage",
    editM: "manage",
    manageM: "manage",
    viewerE: "use",
    outsider: undefined,
  },
};

describe("what each person may do with each agent", () => {
  it("is what the computed field my_access says, row by row", async () => {
    const wrong: string[] = [];
    for (const [agentName, agentId] of Object.entries(agents())) {
      for (const [who, user] of Object.entries(cast())) {
        const expected = EXPECTED[agentName as keyof typeof EXPECTED][who as Who];
        const actual = await myAccess(user, agentId);
        if (actual !== expected) wrong.push(`${agentName}/${who}: ${actual} (want ${expected})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("is what agent_access_for tells the service role, and agent_access tells the caller", async () => {
    const wrong: string[] = [];
    for (const [agentName, agentId] of Object.entries(agents())) {
      for (const [who, user] of Object.entries(cast())) {
        const expected = EXPECTED[agentName as keyof typeof EXPECTED][who as Who] ?? null;
        const forService = await accessFor(agentId, user);
        if (forService !== expected) {
          wrong.push(`agent_access_for ${agentName}/${who}: ${forService} (want ${expected})`);
        }
        const { data, error } = await user.db.rpc("agent_access", { p_agent_id: agentId });
        const own = error ? `error ${error.code}` : ((data as string | null) ?? null);
        if (own !== expected)
          wrong.push(`agent_access ${agentName}/${who}: ${own} (want ${expected})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("lists exactly the agents each person may use", async () => {
    // A bare list, not a lookup by id: a policy can be right for one and wrong
    // for the other.
    const ours = new Set(Object.values(agents()));
    for (const [who, user] of Object.entries(cast())) {
      const { data } = await user.db.from("agents").select("id");
      const seen = (data ?? []).map((r) => r.id as string).filter((id) => ours.has(id));
      const want = Object.entries(agents())
        .filter(([name]) => EXPECTED[name as keyof typeof EXPECTED][who as Who] !== undefined)
        .map(([, id]) => id);
      expect(seen.sort(), who).toEqual(want.sort());
    }
  });
});

describe("changing an agent's settings", () => {
  async function tryEdit(user: TestUser, agentId: string, persona: string) {
    const { data } = await user.db
      .from("agents")
      .update({ persona })
      .eq("id", agentId)
      .select("id");
    return (data ?? []).length === 1 && (await rawAgent(agentId))?.persona === persona;
  }

  it("is open to edit and manage, and to nobody below", async () => {
    const results: Record<string, boolean> = {};
    for (const [who, user] of Object.entries(cast())) {
      results[who] = await tryEdit(user, personal, `persona set by ${who}`);
    }
    expect(results).toEqual({
      host: true,
      maker: true,
      plain: false,
      useM: false,
      editM: true,
      manageM: true,
      viewerE: false,
      outsider: false,
    });
  });

  it("follows the workspace's level for a member nobody named", async () => {
    expect(await tryEdit(plain, wsEdit, "a plain member, on a workspace-edit agent")).toBe(true);
    expect(await tryEdit(plain, wsUse, "a plain member, on a workspace-use agent")).toBe(false);
    expect(await tryEdit(viewerE, wsEdit, "a viewer, on a workspace-edit agent")).toBe(false);
  });

  it("never includes who it is shared with, whatever the level", async () => {
    // A column grant, not a policy: `workspace_access` is insertable and
    // nothing else. Even the maker changes it through set_agent_sharing.
    for (const user of [maker, host]) {
      const { error } = await user.db
        .from("agents")
        .update({ workspace_access: "manage" })
        .eq("id", personal);
      expect(error?.code, user.email).toBe("42501");
    }
    expect((await rawAgent(personal))?.workspace_access).toBeNull();
  });

  it("refuses an access level that is not one, at insert", async () => {
    const { error } = await maker.db.from("agents").insert({
      workspace_id: host.workspaceId,
      name: "Owner of everything",
      created_by: maker.id,
      workspace_access: "owner",
    });
    expect(error?.code).toBe("23514");
  });
});

describe("deleting and restoring", () => {
  afterAll(resetPersonal);

  it("refuses soft deletion below manage, and hides the agent's existence below use", async () => {
    const codes: Record<string, string | null> = {};
    for (const who of ["plain", "useM", "editM", "viewerE", "outsider"] as const) {
      const { error } = await cast()[who].db.rpc("soft_delete_agent", { p_agent_id: personal });
      codes[who] = error?.code ?? null;
    }
    expect(codes).toEqual({
      plain: "P0002",
      useM: "42501",
      editM: "42501",
      viewerE: "42501",
      outsider: "P0002",
    });
    expect((await rawAgent(personal))?.deleted_at).toBeNull();
  });

  it("lets every manager delete and restore it: maker, admin, and a manage share", async () => {
    for (const user of [maker, host, manageM]) {
      const del = await user.db.rpc("soft_delete_agent", { p_agent_id: personal });
      expect(del.error, `${user.email} deleting`).toBeNull();
      expect((await rawAgent(personal))?.deleted_at, user.email).not.toBeNull();

      const back = await user.db.rpc("restore_agent", { p_agent_id: personal });
      expect(back.error, `${user.email} restoring`).toBeNull();
      expect((await rawAgent(personal))?.deleted_at, user.email).toBeNull();
    }
  });

  it("does not let a plain member delete a workspace agent they may edit", async () => {
    // The one thing 0104 takes from a plain member on an agent that was
    // workspace-wide before it: editing stays, deleting goes.
    const { error } = await plain.db.rpc("soft_delete_agent", { p_agent_id: wsEdit });
    expect(error?.code).toBe("42501");
    expect((await rawAgent(wsEdit))?.deleted_at).toBeNull();
  });

  it("does let them delete one the workspace may manage", async () => {
    const del = await plain.db.rpc("soft_delete_agent", { p_agent_id: wsManage });
    expect(del.error).toBeNull();
    const back = await plain.db.rpc("restore_agent", { p_agent_id: wsManage });
    expect(back.error).toBeNull();
    expect((await rawAgent(wsManage))?.deleted_at).toBeNull();
  });

  describe("once it is in the trash", () => {
    beforeAll(async () => {
      const { error } = await maker.db.rpc("soft_delete_agent", { p_agent_id: personal });
      if (error) throw new Error(`maker could not delete: ${error.message}`);
    });

    afterAll(resetPersonal);

    it("is restorable by manage only, and unknowable below use", async () => {
      const codes: Record<string, string | null> = {};
      for (const who of ["plain", "useM", "editM", "viewerE", "outsider"] as const) {
        const { error } = await cast()[who].db.rpc("restore_agent", { p_agent_id: personal });
        codes[who] = error?.code ?? null;
      }
      expect(codes).toEqual({
        plain: "P0002",
        useM: "42501",
        editM: "42501",
        viewerE: "42501",
        outsider: "P0002",
      });
      expect((await rawAgent(personal))?.deleted_at).not.toBeNull();
    });

    it("is listed in the trash only to somebody who could restore it", async () => {
      const listed: Record<string, boolean | string> = {};
      for (const who of [
        "host",
        "maker",
        "manageM",
        "editM",
        "useM",
        "plain",
        "viewerE",
      ] as const) {
        const { data, error } = await cast()[who].db.rpc("workspace_trash", {
          p_workspace_id: host.workspaceId,
        });
        listed[who] = error
          ? `error ${error.code}`
          : ((data ?? []) as Array<{ id: string }>).some((r) => r.id === personal);
      }
      expect(listed).toEqual({
        host: true,
        maker: true,
        manageM: true,
        editM: false,
        useM: false,
        plain: false,
        viewerE: "error 42501", // a viewer has no trash at all (0040)
      });
    });

    it("cannot be reshared, even by its maker", async () => {
      const { error } = await setSharing(maker, personal, "use", []);
      expect(error?.code).toBe("P0002");
    });
  });

  it("hard deletes for manage only", async () => {
    const doomed = await makeAgent(maker, "Hard delete target");
    await mustShare(maker, doomed, null, [
      { user_id: useM.id, access: "use" },
      { user_id: editM.id, access: "edit" },
      { user_id: manageM.id, access: "manage" },
    ]);

    for (const user of [useM, editM, plain]) {
      const { data } = await user.db.from("agents").delete().eq("id", doomed).select("id");
      expect(data ?? [], user.email).toEqual([]);
    }
    expect(await rawAgent(doomed)).not.toBeNull();

    const { data } = await manageM.db.from("agents").delete().eq("id", doomed).select("id");
    expect(data ?? []).toHaveLength(1);
    expect(await rawAgent(doomed)).toBeNull();
    // And the shares went with it.
    expect(await rawShares(doomed)).toEqual([]);
  });
});

// ===========================================================================
// a new agent
// ===========================================================================

describe("an agent a member has just made", () => {
  let fresh: string;

  beforeAll(async () => {
    fresh = await makeAgent(plain, "Plain's own");
  });

  it("starts as Only me, and its maker reads it back from the insert", async () => {
    // makeAgent is insert ... returning: it threw if the row did not come back.
    expect(fresh).toBeTruthy();
    const row = await rawAgent(fresh);
    expect(row?.workspace_access).toBeNull();
    expect(await rawShares(fresh)).toEqual([]);
    expect(await myAccess(plain, fresh)).toBe("manage");
  });

  it("is invisible to every other member, and visible to an admin", async () => {
    for (const user of [maker, useM, editM, manageM, viewerE]) {
      expect(await visible(user, "agents", fresh), user.email).toBe(false);
    }
    expect(await myAccess(host, fresh)).toBe("manage");
  });

  it("cannot be talked to by somebody it is not shared with", async () => {
    // chat_sessions' insert policy looks the agent up through the agents
    // policy, so an agent you cannot see is an agent you cannot start on.
    const { error } = await useM.db.from("chat_sessions").insert({
      agent_id: fresh,
      user_id: useM.id,
      workspace_id: host.workspaceId,
      visibility: "private",
      title: "Not mine to ask",
    });
    expect(error).not.toBeNull();
  });

  it("appears once it is shared, at exactly the level shared", async () => {
    await mustShare(plain, fresh, null, [{ user_id: useM.id, access: "use" }]);
    expect(await myAccess(useM, fresh)).toBe("use");
    expect(await visible(editM, "agents", fresh)).toBe(false);

    await mustShare(plain, fresh, "use", [{ user_id: useM.id, access: "edit" }]);
    expect(await myAccess(useM, fresh)).toBe("edit");
    expect(await myAccess(editM, fresh)).toBe("use");
    expect((await rawAgent(fresh))?.workspace_access).toBe("use");
  });
});

// ===========================================================================
// set_agent_sharing
// ===========================================================================

describe("set_agent_sharing", () => {
  let subject: string;

  beforeAll(async () => {
    subject = await makeAgent(maker, "Sharing subject");
  });

  it("refuses everybody below manage with 42501", async () => {
    await mustShare(maker, subject, null, [
      { user_id: useM.id, access: "use" },
      { user_id: editM.id, access: "edit" },
      { user_id: viewerE.id, access: "manage" }, // capped to use
    ]);
    for (const user of [useM, editM, viewerE]) {
      const { error } = await setSharing(user, subject, "manage", []);
      expect(error?.code, user.email).toBe("42501");
    }
    expect((await rawAgent(subject))?.workspace_access).toBeNull();
    expect(await rawShares(subject)).toHaveLength(3);
  });

  it("answers P0002 for an agent the caller cannot see, or that does not exist", async () => {
    for (const user of [plain, outsider]) {
      const { error } = await setSharing(user, subject, "manage", []);
      expect(error?.code, user.email).toBe("P0002");
    }
    const { error } = await setSharing(maker, crypto.randomUUID(), null, []);
    expect(error?.code).toBe("P0002");
    expect((await rawAgent(subject))?.workspace_access).toBeNull();
  });

  it("refuses somebody who is not a member of the workspace", async () => {
    const { error } = await setSharing(maker, subject, null, [
      { user_id: outsider.id, access: "use" },
    ]);
    expect(error?.code).toBe("22023");
  });

  it("refuses naming the agent's owner, who always has full access", async () => {
    const { error } = await setSharing(host, subject, null, [{ user_id: maker.id, access: "use" }]);
    expect(error?.code).toBe("22023");
  });

  it("refuses the same person twice", async () => {
    const { error } = await setSharing(maker, subject, null, [
      { user_id: useM.id, access: "use" },
      { user_id: useM.id, access: "edit" },
    ]);
    expect(error?.code).toBe("22023");
  });

  it("refuses a level that is not one, for a person or the workspace", async () => {
    const badShare = await setSharing(maker, subject, null, [
      { user_id: useM.id, access: "admin" },
    ]);
    expect(badShare.error?.code).toBe("22023");

    const missingPerson = await setSharing(maker, subject, null, [{ access: "use" } as never]);
    expect(missingPerson.error?.code).toBe("22023");

    const badWorkspace = await setSharing(maker, subject, "owner" as never, []);
    expect(badWorkspace.error?.code).toBe("22023");

    const notAList = await maker.db.rpc("set_agent_sharing", {
      p_agent_id: subject,
      p_workspace_access: null,
      p_shares: { user_id: useM.id, access: "use" },
    });
    expect(notAList.error?.code).toBe("22023");
  });

  it("changes nothing when it refuses", async () => {
    // Every refusal above came after a valid list was in place; it is still
    // the list, untouched.
    const shares = await rawShares(subject);
    expect(shares.map((s) => `${s.user_id}:${s.access}`).sort()).toEqual(
      [`${useM.id}:use`, `${editM.id}:edit`, `${viewerE.id}:manage`].sort(),
    );
  });

  it("replaces the whole list: whoever is missing from it loses their share", async () => {
    await mustShare(maker, subject, "use", [{ user_id: editM.id, access: "manage" }]);

    const shares = await rawShares(subject);
    expect(shares).toHaveLength(1);
    expect(shares[0]).toMatchObject({
      user_id: editM.id,
      access: "manage",
      workspace_id: host.workspaceId,
      granted_by: maker.id,
    });
    expect((await rawAgent(subject))?.workspace_access).toBe("use");

    // useM was dropped from the list, and is left with the workspace's level.
    expect(await myAccess(useM, subject)).toBe("use");
    expect(await myAccess(editM, subject)).toBe("manage");
  });

  it("can be used by an admin who did not make the agent, and by a manage share", async () => {
    const byAdmin = await setSharing(host, subject, null, [
      { user_id: editM.id, access: "manage" },
    ]);
    expect(byAdmin.error).toBeNull();
    expect((await rawAgent(subject))?.workspace_access).toBeNull();

    const byManager = await setSharing(editM, subject, null, [
      { user_id: editM.id, access: "manage" },
      { user_id: plain.id, access: "use" },
    ]);
    expect(byManager.error).toBeNull();
    const plainShare = (await rawShares(subject)).find((s) => s.user_id === plain.id);
    expect(plainShare?.granted_by).toBe(editM.id);
  });

  it("takes everything away with an empty list and no workspace level", async () => {
    await mustShare(maker, subject, null, []);
    expect(await rawShares(subject)).toEqual([]);
    for (const user of [editM, plain, useM]) {
      expect(await visible(user, "agents", subject), user.email).toBe(false);
    }
    expect(await myAccess(maker, subject)).toBe("manage");
    expect(await myAccess(host, subject)).toBe("manage");
  });
});

describe("agent_shares itself", () => {
  it("is readable by whoever can use the agent, and nobody else", async () => {
    const { data: asUser } = await useM.db
      .from("agent_shares")
      .select("user_id, access")
      .eq("agent_id", personal);
    expect(asUser ?? []).toHaveLength(personalShares().length);

    for (const user of [plain, outsider]) {
      const { data } = await user.db
        .from("agent_shares")
        .select("user_id")
        .eq("agent_id", personal);
      expect(data ?? [], user.email).toEqual([]);
    }
  });

  it("cannot be written directly by a client, not even the maker's", async () => {
    const insert = await maker.db.from("agent_shares").insert({
      agent_id: personal,
      workspace_id: host.workspaceId,
      user_id: plain.id,
      access: "manage",
    });
    expect(insert.error?.code).toBe("42501");

    const raise = await useM.db
      .from("agent_shares")
      .update({ access: "manage" })
      .eq("agent_id", personal)
      .eq("user_id", useM.id);
    expect(raise.error?.code).toBe("42501");

    const remove = await maker.db.from("agent_shares").delete().eq("agent_id", personal);
    expect(remove.error?.code).toBe("42501");

    const shares = await rawShares(personal);
    expect(shares).toHaveLength(personalShares().length);
    expect(shares.find((s) => s.user_id === plain.id)).toBeUndefined();
    expect(shares.find((s) => s.user_id === useM.id)?.access).toBe("use");
  });

  it("cannot name another workspace's agent, even for the service role", async () => {
    // The composite key onto agents(id, workspace_id).
    const elsewhere = await outsider.db
      .from("agents")
      .insert({ workspace_id: outsider.workspaceId, name: "Theirs", created_by: outsider.id })
      .select("id")
      .single();
    const { error } = await serviceClient().from("agent_shares").insert({
      agent_id: elsewhere.data!.id,
      workspace_id: host.workspaceId,
      user_id: plain.id,
      access: "use",
    });
    expect(error?.code).toBe("23503");
  });
});

// ===========================================================================
// membership and role
// ===========================================================================

describe("a share follows the membership it was made for", () => {
  it("goes when the person leaves the workspace, and does not come back with them", async () => {
    const leaver = await createTestUser("share-leaver");
    await join(leaver, "member");
    const agent = await makeAgent(maker, "Shared with somebody leaving");
    await mustShare(maker, agent, null, [{ user_id: leaver.id, access: "edit" }]);
    expect(await myAccess(leaver, agent)).toBe("edit");

    await leave(leaver);
    expect(await rawShares(agent)).toEqual([]);

    await join(leaver, "member");
    expect(await visible(leaver, "agents", agent)).toBe(false);
    expect(await accessFor(agent, leaver)).toBeNull();
  });

  it("is kept for a viewer, and turns on when they are promoted", async () => {
    expect(await myAccess(viewerE, personal)).toBe("use");
    await setRole(viewerE, "member");
    try {
      expect(await myAccess(viewerE, personal)).toBe("edit");
    } finally {
      await setRole(viewerE, "viewer");
    }
    expect(await myAccess(viewerE, personal)).toBe("use");
  });

  it("outlives its maker: once they leave, an admin still manages the agent", async () => {
    const departing = await createTestUser("share-departing");
    await join(departing, "member");
    const agent = await makeAgent(departing, "Left behind");

    await leave(departing);
    expect(await accessFor(agent, departing)).toBeNull();
    expect(await myAccess(host, agent)).toBe("manage");

    const { error } = await setSharing(host, agent, null, [
      { user_id: plain.id, access: "manage" },
    ]);
    expect(error).toBeNull();
    expect(await myAccess(plain, agent)).toBe("manage");
  });
});

// ===========================================================================
// what hangs off an agent
// ===========================================================================

describe("losing an agent hides what you did with it, and sharing it back returns it", () => {
  let chatter: TestUser;
  let talk: string;
  let privateSession: string;
  let sharedSession: string;
  let messageId: string;
  let ideaId: string;
  let routineId: string;

  const shareWithChatter = () =>
    mustShare(maker, talk, null, [{ user_id: chatter.id, access: "use" }]);

  beforeAll(async () => {
    chatter = await createTestUser("share-chatter");
    await join(chatter, "member");
    talk = await makeAgent(maker, "Talked to, then taken away");
    await shareWithChatter();

    const session = async (visibility: "private" | "shared") => {
      const { data, error } = await chatter.db
        .from("chat_sessions")
        .insert({
          agent_id: talk,
          user_id: chatter.id,
          workspace_id: host.workspaceId,
          visibility,
          title: `A ${visibility} conversation`,
        })
        .select("id")
        .single();
      if (error) throw new Error(`chatter could not open a session: ${error.message}`);
      return data.id as string;
    };
    privateSession = await session("private");
    sharedSession = await session("shared");

    const { data: message, error: messageError } = await chatter.db
      .from("messages")
      .insert({ session_id: privateSession, sender_id: chatter.id, role: "user", content: "hi" })
      .select("id")
      .single();
    if (messageError) throw new Error(`chatter could not speak: ${messageError.message}`);
    messageId = message.id as string;

    const { data: idea, error: ideaError } = await chatter.db
      .from("ideas")
      .insert({
        session_id: privateSession,
        workspace_id: host.workspaceId,
        title: "chatter's card",
        created_by: chatter.id,
      })
      .select("id")
      .single();
    if (ideaError) throw new Error(`chatter could not add a card: ${ideaError.message}`);
    ideaId = idea.id as string;

    const { data: channel, error: channelError } = await serviceClient()
      .from("delivery_channels")
      .insert({
        workspace_id: host.workspaceId,
        user_id: chatter.id,
        kind: "email",
        label: "c••••r@covan.test",
        secret_ciphertext: "not-a-real-ciphertext",
      })
      .select("id")
      .single();
    if (channelError) throw new Error(`could not seed a channel: ${channelError.message}`);

    const { data: routine, error: routineError } = await chatter.db
      .from("routines")
      .insert({
        workspace_id: host.workspaceId,
        agent_id: talk,
        user_id: chatter.id,
        name: "chatter's routine",
        visibility: "private",
        source_kind: "web",
        source_config: { url: "https://example.com/feed" },
        instruction: "summarise",
        delivery_channel_id: channel.id,
        schedule_cron: "0 9 * * *",
      })
      .select("id")
      .single();
    if (routineError) throw new Error(`chatter could not make a routine: ${routineError.message}`);
    routineId = routine.id as string;

    const { error: favoriteError } = await chatter.db
      .from("favorites")
      .insert({ user_id: chatter.id, agent_id: talk });
    if (favoriteError) throw new Error(`chatter could not favourite: ${favoriteError.message}`);
  });

  async function whatChatterSees() {
    const { data: favorites } = await chatter.db
      .from("favorites")
      .select("agent_id")
      .eq("agent_id", talk);
    return {
      agent: await visible(chatter, "agents", talk),
      privateSession: await visible(chatter, "chat_sessions", privateSession),
      sharedSession: await visible(chatter, "chat_sessions", sharedSession),
      message: await visible(chatter, "messages", messageId),
      idea: await visible(chatter, "ideas", ideaId),
      routine: await visible(chatter, "routines", routineId),
      favorite: (favorites ?? []).length > 0,
    };
  }

  const ALL = {
    agent: true,
    privateSession: true,
    sharedSession: true,
    message: true,
    idea: true,
    routine: true,
    favorite: true,
  };

  it("shows all of it while the agent is shared", async () => {
    expect(await whatChatterSees()).toEqual(ALL);
  });

  it("keeps a shared conversation from anybody who cannot use its agent", async () => {
    // `visibility = 'shared'` shares a conversation with the people who can
    // reach the agent, not with the whole workspace.
    expect(await visible(plain, "chat_sessions", sharedSession)).toBe(false);
    expect(await visible(host, "chat_sessions", sharedSession)).toBe(true);
  });

  it("hides every bit of it — your own included — once the share is taken away", async () => {
    await mustShare(maker, talk, null, []);

    expect(await whatChatterSees()).toEqual({
      agent: false,
      privateSession: false,
      sharedSession: false,
      message: false,
      idea: false,
      routine: false,
      favorite: false,
    });

    // Hidden, not deleted.
    for (const [table, id] of [
      ["chat_sessions", privateSession],
      ["messages", messageId],
      ["ideas", ideaId],
      ["routines", routineId],
    ] as const) {
      expect(await exists(table, id), `${table} was deleted`).toBe(true);
    }
  });

  it("refuses new words in a conversation with an agent you lost", async () => {
    const { error } = await chatter.db.from("messages").insert({
      session_id: privateSession,
      sender_id: chatter.id,
      role: "user",
      content: "hello?",
    });
    expect(error).not.toBeNull();
  });

  it("brings all of it back when the agent is shared again", async () => {
    await shareWithChatter();
    expect(await whatChatterSees()).toEqual(ALL);
  });
});

describe("favourites", () => {
  it("refuses one for an agent the caller cannot see", async () => {
    const { error } = await plain.db
      .from("favorites")
      .insert({ user_id: plain.id, agent_id: personal });
    expect(error?.code).toBe("42501");
  });

  it("allows one at use", async () => {
    const { error } = await useM.db
      .from("favorites")
      .insert({ user_id: useM.id, agent_id: personal });
    expect(error).toBeNull();
  });
});

const SHARING_CAPABILITY = "notion.sharing_test_read_comment";

describe("what an agent knows and may do is an edit", () => {
  let bundleId: string;
  let connectionId: string;
  let toolConnectionId: string;

  beforeAll(async () => {
    const { data: bundle, error: bundleError } = await host.db
      .from("knowledge_bundles")
      // Shared (0106): this suite is about the agent, and a private bundle
      // could not be attached by anybody but its maker.
      .insert({
        workspace_id: host.workspaceId,
        name: "Handbook",
        created_by: host.id,
        scope: "workspace",
      })
      .select("id")
      .single();
    if (bundleError) throw new Error(`could not seed a bundle: ${bundleError.message}`);
    bundleId = bundle.id as string;

    const service = serviceClient();
    const { data: connection, error: connectionError } = await service
      .from("connections")
      .insert({
        workspace_id: host.workspaceId,
        bundle_id: bundleId,
        user_id: host.id,
        provider: "notion",
        account_label: "Covan HQ",
        secret_ciphertext: "v1.sharing-test.not-a-real-token",
      })
      .select("id")
      .single();
    if (connectionError) throw new Error(`could not seed a connection: ${connectionError.message}`);
    connectionId = connection.id as string;

    const { data: tool, error: toolError } = await service
      .from("tool_connections")
      .insert({
        workspace_id: host.workspaceId,
        label: `Team Gmail ${crypto.randomUUID()}`,
        transport: "composio",
        base_url: "https://backend.composio.dev",
        auth_kind: "composio",
        secret_ciphertext: null,
        toolkit_slug: "gmail",
        connected_account_id: `ca_${crypto.randomUUID()}`,
        composio_user_id: `cu_${crypto.randomUUID()}`,
        status: "active",
        created_by: host.id,
        // Shared with the workspace (0098), so a refusal below is the agent's
        // doing and not the connection's.
        scope: "workspace",
      })
      .select("id")
      .single();
    if (toolError) throw new Error(`could not seed a tool connection: ${toolError.message}`);
    toolConnectionId = tool.id as string;

    // The catalogue ships empty and a grant's capability is a foreign key into
    // it, so the one row the grant below needs is seeded here, under a name no
    // other file uses (capability-grants.test.ts seeds and removes its own).
    const { error: catalogueError } = await service.from("connection_capabilities").insert({
      provider: "notion",
      capability: SHARING_CAPABILITY,
      label: "Read comments (sharing test)",
      description: "Read the comments on a page.",
      is_destructive: false,
    });
    if (catalogueError) throw new Error(`could not seed the catalogue: ${catalogueError.message}`);
  });

  afterAll(async () => {
    const service = serviceClient();
    await service.from("connection_grants").delete().eq("capability", SHARING_CAPABILITY);
    await service.from("connection_capabilities").delete().eq("capability", SHARING_CAPABILITY);
  });

  async function attached(): Promise<boolean> {
    const { data } = await serviceClient()
      .from("agent_bundles")
      .select("agent_id")
      .eq("agent_id", personal)
      .eq("bundle_id", bundleId);
    return (data ?? []).length > 0;
  }

  it("refuses attaching knowledge at use, and to a viewer shared at edit", async () => {
    for (const user of [useM, viewerE, plain]) {
      const { error } = await user.db
        .from("agent_bundles")
        .insert({ agent_id: personal, bundle_id: bundleId });
      expect(error?.code, user.email).toBe("42501");
    }
    expect(await attached()).toBe(false);
  });

  it("allows it at edit, and detaching is an edit too", async () => {
    const { error } = await editM.db
      .from("agent_bundles")
      .insert({ agent_id: personal, bundle_id: bundleId });
    expect(error).toBeNull();
    expect(await attached()).toBe(true);

    await useM.db.from("agent_bundles").delete().eq("agent_id", personal).eq("bundle_id", bundleId);
    expect(await attached(), "a use share detached knowledge").toBe(true);

    await editM.db
      .from("agent_bundles")
      .delete()
      .eq("agent_id", personal)
      .eq("bundle_id", bundleId);
    expect(await attached()).toBe(false);
  });

  it("refuses a capability grant at use, and allows one at edit", async () => {
    const grant = {
      agent_id: personal,
      connection_id: connectionId,
      workspace_id: host.workspaceId,
      provider: "notion",
      capability: SHARING_CAPABILITY,
      mode: "ask",
    };
    const refused = await useM.db.from("connection_grants").insert(grant);
    expect(refused.error?.code).toBe("42501");

    const allowed = await editM.db.from("connection_grants").insert(grant);
    expect(allowed.error).toBeNull();
  });

  it("refuses a tool grant at use, and allows one at edit", async () => {
    const grant = {
      agent_id: personal,
      tool_connection_id: toolConnectionId,
      workspace_id: host.workspaceId,
      slug: "GMAIL_FETCH_EMAILS",
      mode: "ask",
    };
    const refused = await useM.db.from("tool_connection_grants").insert(grant);
    expect(refused.error?.code).toBe("42501");

    const allowed = await editM.db.from("tool_connection_grants").insert(grant);
    expect(allowed.error).toBeNull();
  });

  // Runs after the two inserts above, which leave a grant of each kind on the
  // personal agent.
  it("hides an agent's standing permissions from somebody it is not shared with", async () => {
    for (const table of ["connection_grants", "tool_connection_grants"]) {
      const hidden = await plain.db.from(table).select("agent_id").eq("agent_id", personal);
      expect(hidden.error, table).toBeNull();
      expect(hidden.data, table).toEqual([]);

      const seen = await useM.db.from(table).select("agent_id").eq("agent_id", personal);
      expect((seen.data ?? []).length, table).toBeGreaterThan(0);
    }
  });

  // A pending call carries what the agent was about to send, and approving it
  // is what sends it.
  it("keeps a pending call on the agent's side: read and answered by its users only", async () => {
    const { data: call, error } = await serviceClient()
      .from("capability_calls")
      .insert({
        workspace_id: host.workspaceId,
        agent_id: personal,
        connection_id: connectionId,
        provider: "notion",
        capability: "notion.create_comment",
        mode: "ask",
        status: "pending",
        request: { body: "something only its users should read" },
      })
      .select("id")
      .single();
    if (error) throw new Error(`could not seed a pending call: ${error.message}`);

    const hidden = await plain.db.from("capability_calls").select("id").eq("id", call.id);
    expect(hidden.data).toEqual([]);

    const answered = await plain.db
      .from("capability_calls")
      .update({ status: "approved" })
      .eq("id", call.id)
      .select("id");
    expect(answered.data ?? []).toEqual([]);

    const seen = await useM.db.from("capability_calls").select("id").eq("id", call.id);
    expect(seen.data).toHaveLength(1);

    const approved = await useM.db
      .from("capability_calls")
      .update({ status: "approved" })
      .eq("id", call.id)
      .select("status");
    expect(approved.error).toBeNull();
    expect(approved.data).toEqual([{ status: "approved" }]);
  });
});

// ===========================================================================
// the functions themselves
// ===========================================================================

describe("agent_access_for", () => {
  it("cannot be asked by a signed-in client, about anybody", async () => {
    const { error } = await maker.db.rpc("agent_access_for", {
      p_agent_id: personal,
      p_user_id: maker.id,
    });
    expect(error?.code).toBe("42501");
  });

  it("is granted to the service role alone", async () => {
    const [row] = (await sql()`
      select has_function_privilege('anon', 'public.agent_access_for(uuid, uuid)', 'execute') as anon,
             has_function_privilege('authenticated', 'public.agent_access_for(uuid, uuid)', 'execute') as authenticated,
             has_function_privilege('service_role', 'public.agent_access_for(uuid, uuid)', 'execute') as service_role
    `) as Array<{ anon: boolean; authenticated: boolean; service_role: boolean }>;
    expect(row).toEqual({ anon: false, authenticated: false, service_role: true });
  });

  it("answers null for nobody and for no agent", async () => {
    expect(await accessFor(crypto.randomUUID(), maker)).toBeNull();
    const { data } = await serviceClient().rpc("agent_access_for", {
      p_agent_id: personal,
      p_user_id: crypto.randomUUID(),
    });
    expect(data ?? null).toBeNull();
  });
});

describe("an API key", () => {
  /**
   * Runs `fn` as `user` the way PostgREST runs a request made with an API key
   * minted in `workspace` (0087's `covan_ws`), or with a browser session when
   * `workspace` is null. Always rolled back. See key-workspace-scope.test.ts.
   */
  const ROLLBACK = Symbol("rollback");
  async function asCaller<T>(
    user: TestUser,
    workspace: string | null,
    fn: (tx: ReturnType<typeof sql>) => Promise<T>,
  ): Promise<T> {
    const claims: Record<string, string> = { sub: user.id, role: "authenticated" };
    if (workspace) claims.covan_ws = workspace;
    let result: T | undefined;
    try {
      await sql().begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
        await tx`set local role authenticated`;
        result = await fn(tx as never);
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    return result as T;
  }

  async function reach(user: TestUser, workspace: string | null, agentId: string) {
    return asCaller(user, workspace, async (tx) => {
      const [row] = await tx`
        select public.agent_access(${agentId}::uuid) as access,
               public.can_use_agent(${agentId}::uuid) as can_use,
               (select count(*)::int from public.agents where id = ${agentId}::uuid) as visible`;
      return row as unknown as { access: string | null; can_use: boolean; visible: number };
    });
  }

  it("made in the agent's workspace reaches it at the person's level", async () => {
    expect(await reach(maker, host.workspaceId, personal)).toEqual({
      access: "manage",
      can_use: true,
      visible: 1,
    });
    expect(await reach(plain, host.workspaceId, wsEdit)).toEqual({
      access: "edit",
      can_use: true,
      visible: 1,
    });
  });

  it("made in another workspace reaches none of it, even the maker's own agent", async () => {
    // maker's own signup workspace, which they are the admin of.
    expect(await reach(maker, maker.workspaceId, personal)).toEqual({
      access: null,
      can_use: false,
      visible: 0,
    });
    // And the workspace-wide branch of the select policy does not get round it.
    expect(await reach(plain, plain.workspaceId, wsEdit)).toEqual({
      access: null,
      can_use: false,
      visible: 0,
    });
  });

  it("changes nothing for a browser session", async () => {
    expect(await reach(useM, null, personal)).toEqual({ access: "use", can_use: true, visible: 1 });
  });
});
