/**
 * A workspace's settings, its notice, its members' presence, and an account's
 * own sign-ins (0127, 0128).
 *
 * The admin changes the icon, the clock and the summary; nobody writes the
 * deletion columns except the two functions that own them, and those check
 * the name and the role. A member stamps their own presence and nothing else
 * on their membership — in particular not their role. The sign-ins in `auth`
 * are answered for the caller alone.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";

let ada: TestUser;
let bora: TestUser;
let workspaceName: string;

beforeAll(async () => {
  ada = await createTestUser("settings-ada");
  bora = await createTestUser("settings-bora");
  const service = serviceClient();
  const { error } = await service
    .from("workspace_members")
    .insert({ workspace_id: ada.workspaceId, user_id: bora.id, role: "member" });
  if (error) throw new Error(`could not add bora: ${error.message}`);
  const { data } = await service
    .from("workspaces")
    .select("name")
    .eq("id", ada.workspaceId)
    .single();
  workspaceName = data!.name as string;
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("workspace settings", () => {
  it("are the admin's to change, and a member's change matches nothing", async () => {
    const admin = await ada.db
      .from("workspaces")
      .update({ timezone: "Europe/Istanbul", weekly_usage_email: true })
      .eq("id", ada.workspaceId)
      .select("timezone, weekly_usage_email");
    expect(admin.data).toEqual([{ timezone: "Europe/Istanbul", weekly_usage_email: true }]);

    const member = await bora.db
      .from("workspaces")
      .update({ timezone: "UTC" })
      .eq("id", ada.workspaceId)
      .select("id");
    expect(member.data ?? []).toEqual([]);
  });

  it("never let a client set the deletion date, or point the icon elsewhere", async () => {
    const date = await ada.db
      .from("workspaces")
      .update({ deletes_at: new Date().toISOString() })
      .eq("id", ada.workspaceId);
    expect(date.error).not.toBeNull();

    const icon = await ada.db
      .from("workspaces")
      .update({ icon_url: "https://elsewhere.test/icon.png" })
      .eq("id", ada.workspaceId);
    expect(icon.error?.code).toBe("23514");
  });
});

describe("deleting a workspace", () => {
  it("needs an admin and the name typed exactly, and can be called off", async () => {
    const member = await bora.db.rpc("request_workspace_deletion", {
      p_workspace_id: ada.workspaceId,
      p_name: workspaceName,
    });
    expect(member.error?.code).toBe("42501");

    const wrong = await ada.db.rpc("request_workspace_deletion", {
      p_workspace_id: ada.workspaceId,
      p_name: `${workspaceName} `.toUpperCase(),
    });
    expect(wrong.error?.code).toBe("22023");

    const ok = await ada.db.rpc("request_workspace_deletion", {
      p_workspace_id: ada.workspaceId,
      p_name: workspaceName,
    });
    expect(ok.error).toBeNull();
    expect(Date.parse(ok.data as string)).toBeGreaterThan(Date.now() + 13 * 86_400_000);

    const kept = await ada.db.rpc("cancel_workspace_deletion", { p_workspace_id: ada.workspaceId });
    expect(kept.error).toBeNull();
    const { data } = await serviceClient()
      .from("workspaces")
      .select("deletes_at")
      .eq("id", ada.workspaceId)
      .single();
    expect(data?.deletes_at).toBeNull();
  });
});

describe("presence", () => {
  it("stamps the caller's own membership, and a member still cannot change their role", async () => {
    const { error } = await bora.db.rpc("touch_presence", { p_workspace_id: ada.workspaceId });
    expect(error).toBeNull();

    const { data } = await serviceClient()
      .from("workspace_members")
      .select("last_seen_at, role")
      .eq("workspace_id", ada.workspaceId)
      .eq("user_id", bora.id)
      .single();
    expect(data?.last_seen_at).not.toBeNull();

    const promoted = await bora.db
      .from("workspace_members")
      .update({ role: "admin" })
      .eq("workspace_id", ada.workspaceId)
      .eq("user_id", bora.id)
      .select("role");
    expect(promoted.data ?? []).toEqual([]);
  });

  it("counts the agents each member can use, for any member", async () => {
    const { data, error } = await bora.db.rpc("member_agent_counts", {
      p_workspace_id: ada.workspaceId,
    });
    expect(error).toBeNull();
    expect((data as Array<{ user_id: string }>).map((r) => r.user_id).sort()).toEqual(
      [ada.id, bora.id].sort(),
    );
  });
});

describe("an account's own sign-ins", () => {
  it("lists the caller's sessions and providers and nobody else's", async () => {
    const mine = await bora.db.rpc("my_sessions");
    expect(mine.error).toBeNull();
    expect((mine.data as Array<{ current: boolean }>).some((s) => s.current)).toBe(true);

    const adas = await ada.db.rpc("my_sessions");
    const boraIds = new Set((mine.data as Array<{ id: string }>).map((s) => s.id));
    expect((adas.data as Array<{ id: string }>).some((s) => boraIds.has(s.id))).toBe(false);

    const identities = await bora.db.rpc("my_identities");
    expect(identities.error).toBeNull();
  });

  it("will not sign out somebody else's session", async () => {
    const mine = await bora.db.rpc("my_sessions");
    const theirs = (mine.data as Array<{ id: string }>)[0]!.id;
    const { data } = await ada.db.rpc("revoke_my_session", { p_session_id: theirs });
    expect(data).toBe(false);
  });
});
