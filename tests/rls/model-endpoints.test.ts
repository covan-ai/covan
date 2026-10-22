/**
 * A workspace's own model endpoints (0135), through the policies.
 *
 * Every member sees that an endpoint exists; only an admin adds or removes
 * one, and its address is never changed after the fact. Nobody reads the
 * sealed key. And a token held to another workspace — an API key's — sees
 * none of this workspace's endpoints.
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

let ada: TestUser;
let bora: TestUser;
let endpointId: string;
let elsewhere: string;
const ROLLBACK = Symbol("rollback");

const row = (user: TestUser, url = "https://llm.acme.test/v1") => ({
  workspace_id: ada.workspaceId,
  label: "acme-openai-proxy",
  model: "gpt-5-mini",
  base_url: url,
  api_key_ciphertext: "sealed",
  created_by: user.id,
});

beforeAll(async () => {
  ada = await createTestUser("endpoints-ada");
  bora = await createTestUser("endpoints-bora");
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: ada.workspaceId, user_id: bora.id, role: "member" });
  if (error) throw new Error(`could not add bora: ${error.message}`);
  elsewhere = bora.workspaceId;
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("model endpoints", () => {
  it("are an admin's to add, https only, and their key nobody's to read", async () => {
    expect(
      (await bora.db.from("workspace_model_endpoints").insert(row(bora))).error,
    ).not.toBeNull();
    const http = await ada.db
      .from("workspace_model_endpoints")
      .insert(row(ada, "http://llm.acme.test"));
    expect(http.error?.code).toBe("23514");

    const { data, error } = await ada.db
      .from("workspace_model_endpoints")
      .insert(row(ada))
      .select("id")
      .single();
    expect(error).toBeNull();
    endpointId = data!.id as string;

    expect(
      (await ada.db.from("workspace_model_endpoints").select("api_key_ciphertext")).error,
    ).not.toBeNull();
    const seen = await bora.db
      .from("workspace_model_endpoints")
      .select("label")
      .eq("id", endpointId);
    expect(seen.data).toEqual([{ label: "acme-openai-proxy" }]);
  });

  it("keep their address, and a member cannot remove one", async () => {
    const moved = await ada.db
      .from("workspace_model_endpoints")
      .update({ base_url: "https://elsewhere.test" })
      .eq("id", endpointId);
    expect(moved.error).not.toBeNull();

    const removed = await bora.db
      .from("workspace_model_endpoints")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", endpointId)
      .select("id");
    expect(removed.data ?? []).toEqual([]);
  });

  it("are out of sight of a token held to another workspace", async () => {
    const claims = { sub: bora.id, role: "authenticated", covan_ws: elsewhere };
    let n = -1;
    try {
      await sql().begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
        await tx`set local role authenticated`;
        const [r] =
          await tx`select count(*)::int as n from public.workspace_model_endpoints where id = ${endpointId}`;
        n = r!.n as number;
        throw ROLLBACK;
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    expect(n).toBe(0);
  });
});
