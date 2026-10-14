/**
 * A connected service is its owner's unless they share it (0098).
 *
 * `tool_connections` was readable by every member, and what an agent can reach
 * is what the caller's client can read — so one person's Gmail was a tool for
 * every member's turns, a viewer's included. Personal by default now, shared
 * on purpose, the way saved browser logins already are (0079).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

let admin: TestUser;
let member: TestUser;
let viewer: TestUser;
let seeded: Seeded;
let gmail: string;

async function connect(user: TestUser, label: string, scope?: "owner" | "workspace") {
  const { data, error } = await serviceClient()
    .from("tool_connections")
    .insert({
      workspace_id: admin.workspaceId,
      label,
      transport: "composio",
      base_url: "https://backend.composio.dev",
      auth_kind: "composio",
      secret_ciphertext: null,
      toolkit_slug: "gmail",
      connected_account_id: `ca_${crypto.randomUUID()}`,
      composio_user_id: `cu_${crypto.randomUUID()}`,
      status: "active",
      created_by: user.id,
      ...(scope ? { scope } : {}),
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not connect ${label}: ${error.message}`);
  return data.id as string;
}

beforeAll(async () => {
  admin = await createTestUser("scope-admin");
  member = await createTestUser("scope-member");
  viewer = await createTestUser("scope-viewer");
  for (const [user, role] of [
    [member, "member"],
    [viewer, "viewer"],
  ] as const) {
    const { error } = await serviceClient()
      .from("workspace_members")
      .insert({ workspace_id: admin.workspaceId, user_id: user.id, role });
    if (error) throw new Error(`could not add ${role}: ${error.message}`);
  }
  seeded = await seedWorkspace(admin);
  gmail = await connect(member, "gmail");
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

const visibleTo = async (user: TestUser, id: string) =>
  ((await user.db.from("tool_connections").select("id").eq("id", id)).data ?? []).length === 1;

describe("a connected service", () => {
  it("is personal by default: its owner sees it and nobody else does", async () => {
    expect(await visibleTo(member, gmail)).toBe(true);
    expect(await visibleTo(admin, gmail)).toBe(false);
    expect(await visibleTo(viewer, gmail)).toBe(false);
  });

  it("cannot be shared, renamed or removed by anybody but its owner", async () => {
    const shared = await admin.db
      .from("tool_connections")
      .update({ scope: "workspace" })
      .eq("id", gmail)
      .select("id");
    expect(shared.data ?? []).toEqual([]);

    const removed = await admin.db.from("tool_connections").delete().eq("id", gmail).select("id");
    expect(removed.data ?? []).toEqual([]);
    expect(await visibleTo(member, gmail)).toBe(true);
  });

  it("cannot be given a standing approval by somebody who cannot see it", async () => {
    const { error } = await admin.db.from("tool_connection_grants").insert({
      agent_id: seeded.agentId,
      tool_connection_id: gmail,
      workspace_id: admin.workspaceId,
      slug: "GMAIL_SEND_EMAIL",
      mode: "always",
    });
    expect(error).not.toBeNull();
  });

  it("is seen by the whole workspace once its owner shares it", async () => {
    const { error } = await member.db
      .from("tool_connections")
      .update({ scope: "workspace" })
      .eq("id", gmail);
    expect(error).toBeNull();

    for (const user of [admin, member, viewer]) expect(await visibleTo(user, gmail)).toBe(true);
  });

  it("can then be unshared by its owner, and not by an admin, who may only remove it", async () => {
    // An admin's update would leave a row the admin may not read, and Postgres
    // checks an update's new row against the read policy too: refused.
    const byAdmin = await admin.db
      .from("tool_connections")
      .update({ scope: "owner" })
      .eq("id", gmail);
    expect(byAdmin.error?.code).toBe("42501");

    const byOwner = await member.db
      .from("tool_connections")
      .update({ scope: "owner" })
      .eq("id", gmail);
    expect(byOwner.error).toBeNull();
    expect(await visibleTo(admin, gmail)).toBe(false);
    expect(await visibleTo(member, gmail)).toBe(true);
  });

  it("can be removed by an admin while it is shared", async () => {
    const team = await connect(member, "team gmail", "workspace");
    const { data } = await admin.db.from("tool_connections").delete().eq("id", team).select("id");
    expect(data).toHaveLength(1);
  });

  it("cannot be shared by a viewer, who cannot write in the workspace", async () => {
    const own = await connect(viewer, "viewer gmail");
    const { data } = await viewer.db
      .from("tool_connections")
      .update({ scope: "workspace" })
      .eq("id", own)
      .select("id");
    expect(data ?? []).toEqual([]);
  });

  it("may share a name with somebody else's personal one, not with a shared one", async () => {
    // Two people's own Gmail are both "gmail".
    await expect(connect(admin, "gmail")).resolves.toEqual(expect.any(String));

    await connect(admin, "team inbox", "workspace");
    await expect(connect(member, "Team Inbox", "workspace")).rejects.toThrow(/duplicate key/);
  });
});
