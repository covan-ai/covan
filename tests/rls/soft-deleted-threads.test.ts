/**
 * Threads and routines deleted on their own, and brought back (0125).
 *
 * The starter's to delete and the starter's to restore — a thread shared with
 * the team is still theirs, as it is theirs to share. A deleted thread leaves
 * every view at once, sits in its owner's Recently deleted and nobody else's,
 * and a thread whose agent is in the trash waits for the agent.
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
let agentId: string;
let threadId: string;

beforeAll(async () => {
  ada = await createTestUser("trash-ada");
  bora = await createTestUser("trash-bora");
  const { error: joinError } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: ada.workspaceId, user_id: bora.id, role: "member" });
  if (joinError) throw new Error(`could not add bora: ${joinError.message}`);

  const { data: agent, error } = await ada.db
    .from("agents")
    .insert({
      workspace_id: ada.workspaceId,
      name: "Support",
      created_by: ada.id,
      workspace_access: "use",
    })
    .select("id")
    .single();
  if (error || !agent) throw new Error(`could not make the agent: ${error?.message}`);
  agentId = agent.id as string;

  const { data: thread, error: threadError } = await ada.db
    .from("chat_sessions")
    .insert({
      agent_id: agentId,
      user_id: ada.id,
      workspace_id: ada.workspaceId,
      visibility: "shared",
      title: "Refunds",
    })
    .select("id")
    .single();
  if (threadError || !thread) throw new Error(`could not make a thread: ${threadError?.message}`);
  threadId = thread.id as string;
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("soft_delete_session", () => {
  it("is refused to somebody who did not start the thread, shared or not", async () => {
    const { error } = await bora.db.rpc("soft_delete_session", { p_session_id: threadId });
    expect(error?.code).toBe("42501");
  });

  it("takes the thread out of every view and into its owner's trash only", async () => {
    const { error } = await ada.db.rpc("soft_delete_session", { p_session_id: threadId });
    expect(error).toBeNull();

    for (const user of [ada, bora]) {
      const { data } = await user.db.from("chat_sessions").select("id").eq("id", threadId);
      expect(data ?? []).toEqual([]);
    }

    const own = await ada.db.rpc("workspace_trash", { p_workspace_id: ada.workspaceId });
    expect(
      (own.data as Array<{ kind: string; id: string }>).map((r) => [r.kind, r.id]),
    ).toContainEqual(["session", threadId]);
    const his = await bora.db.rpc("workspace_trash", { p_workspace_id: ada.workspaceId });
    expect((his.data as Array<{ kind: string }>).filter((r) => r.kind === "session")).toEqual([]);
  });

  it("comes back for its owner and nobody else", async () => {
    const refused = await bora.db.rpc("restore_session", { p_session_id: threadId });
    expect(refused.error?.code).toBe("P0002");

    const { error } = await ada.db.rpc("restore_session", { p_session_id: threadId });
    expect(error).toBeNull();
    const { data } = await bora.db.from("chat_sessions").select("id").eq("id", threadId);
    expect(data).toEqual([{ id: threadId }]);
  });

  it("waits for its agent when the agent is in the trash", async () => {
    await ada.db.rpc("soft_delete_session", { p_session_id: threadId });
    await ada.db.rpc("soft_delete_agent", { p_agent_id: agentId });

    const { error } = await ada.db.rpc("restore_session", { p_session_id: threadId });
    expect(error?.code).toBe("22023");
  });
});
