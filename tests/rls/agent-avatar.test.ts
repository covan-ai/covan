/**
 * An agent's face, and what deleting it would take with it (0120).
 *
 * `avatar` is one of eight mark names or null, written through the caller's
 * own client like `name` beside it — so it is held to the same column grant and
 * the same edit policy, and a name outside the eight is the database's to
 * refuse, not only the API's.
 *
 * `agent_delete_summary` counts what a delete takes with it — threads,
 * routines, folders — for the dialog's sentence (A25). It is a definer
 * function because a delete takes threads the caller cannot see, so it asks
 * the question `soft_delete_agent` asks before it answers: full access, or
 * nothing. A member who may only use the agent gets the refusal the delete
 * button would give them, and somebody outside the workspace learns nothing,
 * not even that the agent exists.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let agentId: string;

beforeAll(async () => {
  owner = await createTestUser("avatar-owner");
  member = await createTestUser("avatar-member");
  outsider = await createTestUser("avatar-outsider");

  const { error: joinError } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: owner.workspaceId, user_id: member.id, role: "member" });
  if (joinError) throw new Error(`could not add the member: ${joinError.message}`);

  // Shared with the workspace at `use`: the member can reach it, not change it.
  const { data, error } = await owner.db
    .from("agents")
    .insert({
      workspace_id: owner.workspaceId,
      name: "Support",
      created_by: owner.id,
      avatar: "headset",
      workspace_access: "use",
    })
    .select("id, avatar")
    .single();
  if (error || !data) throw new Error(`could not make the agent: ${error?.message}`);
  expect(data.avatar).toBe("headset");
  agentId = data.id as string;

  // Two of the owner's threads, one of them private, and a routine.
  for (const visibility of ["private", "shared"]) {
    const { error: sessionError } = await owner.db.from("chat_sessions").insert({
      agent_id: agentId,
      user_id: owner.id,
      workspace_id: owner.workspaceId,
      visibility,
      title: `A ${visibility} thread`,
    });
    if (sessionError) throw new Error(`could not seed a thread: ${sessionError.message}`);
  }
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("agents.avatar", () => {
  it("lets whoever may edit the agent change its mark, and put the monogram back", async () => {
    const { data, error } = await owner.db
      .from("agents")
      .update({ avatar: "owl" })
      .eq("id", agentId)
      .select("avatar")
      .single();
    expect(error).toBeNull();
    expect(data?.avatar).toBe("owl");

    const back = await owner.db
      .from("agents")
      .update({ avatar: null })
      .eq("id", agentId)
      .select("avatar")
      .single();
    expect(back.error).toBeNull();
    expect(back.data?.avatar).toBeNull();
  });

  it("refuses a mark that is not one of the eight", async () => {
    const { error } = await owner.db
      .from("agents")
      .update({ avatar: "unicorn" })
      .eq("id", agentId)
      .select("id");
    expect(error?.code).toBe("23514");
  });

  it("does not let somebody who may only use the agent change its face", async () => {
    const { data } = await member.db
      .from("agents")
      .update({ avatar: "cat" })
      .eq("id", agentId)
      .select("id");
    expect(data ?? []).toEqual([]);

    const { data: row } = await serviceClient()
      .from("agents")
      .select("avatar")
      .eq("id", agentId)
      .single();
    expect(row?.avatar).not.toBe("cat");
  });
});

describe("agent_delete_summary", () => {
  it("counts every thread a delete would take, private ones included", async () => {
    const { data, error } = await owner.db
      .rpc("agent_delete_summary", { p_agent_id: agentId })
      .single<{ threads: number; routines: number; folders: number }>();
    expect(error).toBeNull();
    expect(data).toEqual({ threads: 2, routines: 0, folders: 0 });
  });

  it("refuses a member who could not delete the agent", async () => {
    const { error } = await member.db.rpc("agent_delete_summary", { p_agent_id: agentId });
    expect(error?.code).toBe("42501");
  });

  it("tells somebody outside the workspace nothing", async () => {
    const { error } = await outsider.db.rpc("agent_delete_summary", { p_agent_id: agentId });
    expect(error?.code).toBe("P0002");
  });
});
