/**
 * The counts behind Coverage and an agent's Knowledge tab (0134).
 *
 * A member who can use an agent learns how its replies were grounded, and a
 * member learns how often a document they can see was cited lately — numbers
 * only, across private threads as 0038's always were. Somebody outside the
 * workspace learns neither, and the per-agent bars stay an admin's.
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
let stranger: TestUser;
let agentId: string;
let bundleId: string;

beforeAll(async () => {
  ada = await createTestUser("counts-ada");
  bora = await createTestUser("counts-bora");
  stranger = await createTestUser("counts-stranger");
  const service = serviceClient();
  await service
    .from("workspace_members")
    .insert({ workspace_id: ada.workspaceId, user_id: bora.id, role: "member" });
  const { data: agent } = await ada.db
    .from("agents")
    .insert({
      workspace_id: ada.workspaceId,
      name: "Support",
      created_by: ada.id,
      workspace_access: "use",
    })
    .select("id")
    .single();
  agentId = agent!.id as string;
  const { data: bundle } = await ada.db
    .from("knowledge_bundles")
    .insert({
      workspace_id: ada.workspaceId,
      name: "Policies",
      created_by: ada.id,
      scope: "workspace",
    })
    .select("id")
    .single();
  bundleId = bundle!.id as string;
  const { data: doc } = await service
    .from("documents")
    .insert({ bundle_id: bundleId, name: "refund.md", content: "x" })
    .select("id")
    .single();
  const { data: session } = await service
    .from("chat_sessions")
    .insert({
      agent_id: agentId,
      user_id: ada.id,
      workspace_id: ada.workspaceId,
      visibility: "private",
      title: "Mine",
    })
    .select("id")
    .single();
  await service.from("messages").insert([
    {
      session_id: session!.id,
      role: "assistant",
      content: "cited",
      grounding: "chunks",
      sources: [{ id: doc!.id, name: "refund.md" }],
    },
    { session_id: session!.id, role: "assistant", content: "not close", grounding: "none" },
  ]);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("coverage counts", () => {
  it("answer a member who can use the agent, and nobody outside", async () => {
    const mine = await bora.db.rpc("agent_coverage", { p_agent_id: agentId, p_days: 30 });
    expect(mine.error).toBeNull();
    expect(Number((mine.data as Array<{ answers: number }>)[0]!.answers)).toBe(2);

    const theirs = await stranger.db.rpc("agent_coverage", { p_agent_id: agentId, p_days: 30 });
    expect(theirs.error?.code).toBe("P0002");
  });

  it("count a document's citations in the window for a member, and none for a stranger", async () => {
    const member = await bora.db.rpc("document_citation_counts_since", {
      p_bundle_ids: [bundleId],
      p_days: 30,
    });
    expect((member.data as Array<{ citations: number }>).map((r) => Number(r.citations))).toEqual([
      1,
    ]);

    const outside = await stranger.db.rpc("document_citation_counts_since", {
      p_bundle_ids: [bundleId],
      p_days: 30,
    });
    expect(outside.data ?? []).toEqual([]);
  });

  it("keep the per-agent bars an admin's", async () => {
    const member = await bora.db.rpc("workspace_coverage_agents", {
      p_workspace_id: ada.workspaceId,
      p_days: 30,
    });
    expect(member.error?.code).toBe("42501");
  });
});
