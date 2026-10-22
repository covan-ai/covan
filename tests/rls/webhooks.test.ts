/**
 * Webhooks (0131), read and written through the policies.
 *
 * An admin's own client writes an endpoint and can never read its secret
 * back; a member sees and writes nothing. The record of deliveries is the
 * admins' to read and nobody's to write. An event is queued only for what the
 * whole workspace can see, and its payload carries labels, never what was
 * written in a message.
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
let endpointId: string;

beforeAll(async () => {
  ada = await createTestUser("hooks-ada");
  bora = await createTestUser("hooks-bora");
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: ada.workspaceId, user_id: bora.id, role: "member" });
  if (error) throw new Error(`could not add bora: ${error.message}`);
  const { data: agent, error: agentError } = await ada.db
    .from("agents")
    .insert({
      workspace_id: ada.workspaceId,
      name: "Support",
      created_by: ada.id,
      workspace_access: "use",
    })
    .select("id")
    .single();
  if (agentError) throw new Error(`could not make an agent: ${agentError.message}`);
  agentId = agent.id as string;
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

const endpoint = (user: TestUser, url = "https://hooks.acme.test/covan") => ({
  workspace_id: ada.workspaceId,
  url,
  events: ["thread.finished", "agent.needs_you"],
  secret_ciphertext: "sealed",
  created_by: user.id,
});

describe("endpoints", () => {
  it("are an admin's to add, https only, and their secret is nobody's to read", async () => {
    expect((await bora.db.from("webhook_endpoints").insert(endpoint(bora))).error).not.toBeNull();
    const http = await ada.db
      .from("webhook_endpoints")
      .insert(endpoint(ada, "http://hooks.acme.test"));
    expect(http.error?.code).toBe("23514");

    const { data, error } = await ada.db
      .from("webhook_endpoints")
      .insert(endpoint(ada))
      .select("id")
      .single();
    expect(error).toBeNull();
    endpointId = data!.id as string;

    const secret = await ada.db.from("webhook_endpoints").select("secret_ciphertext");
    expect(secret.error).not.toBeNull();
    const { data: seen } = await bora.db.from("webhook_endpoints").select("id");
    expect(seen ?? []).toEqual([]);
  });
});

describe("events", () => {
  it("are queued for a shared thread's answer, without its words, and not for a private one", async () => {
    const service = serviceClient();
    const session = async (visibility: string, title: string) => {
      const { data, error } = await service
        .from("chat_sessions")
        .insert({
          agent_id: agentId,
          user_id: ada.id,
          workspace_id: ada.workspaceId,
          visibility,
          title,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      return data.id as string;
    };
    const shared = await session("shared", "Refund policy");
    const priv = await session("private", "Private plan");
    await service.from("messages").insert([
      {
        session_id: shared,
        role: "assistant",
        content: "the words of the answer",
        outcome: "answered",
      },
      { session_id: priv, role: "assistant", content: "private words", outcome: "answered" },
    ]);

    const { data } = await ada.db
      .from("webhook_deliveries")
      .select("event, payload")
      .eq("endpoint_id", endpointId);
    expect((data ?? []).map((d) => d.event)).toEqual(["thread.finished"]);
    expect(JSON.stringify(data)).not.toContain("words");
    expect(JSON.stringify(data)).toContain("Refund policy");

    const { data: memberView } = await bora.db.from("webhook_deliveries").select("id");
    expect(memberView ?? []).toEqual([]);
    const write = await ada.db
      .from("webhook_deliveries")
      .update({ status: "ok" })
      .eq("endpoint_id", endpointId);
    expect(write.error).not.toBeNull();
  });

  it("can be tested and resent by an admin only", async () => {
    const member = await bora.db.rpc("enqueue_webhook_test", { p_endpoint_id: endpointId });
    expect(member.error?.code).toBe("42501");
    const { data: id, error } = await ada.db.rpc("enqueue_webhook_test", {
      p_endpoint_id: endpointId,
    });
    expect(error).toBeNull();
    const early = await ada.db.rpc("resend_webhook_delivery", { p_delivery_id: id });
    expect(early.error?.code).toBe("22023");
  });
});
