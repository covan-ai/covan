/**
 * What an API key starts ends with it (0088).
 *
 * A routine, a delivery channel and a webhook trigger made with a key carry
 * the key's id, and revoking the key pauses the routine, disables the channel
 * and deletes the trigger -- in the same statement as the revocation. Before
 * 0088 none of them knew which key made them, so a leaked key could leave a
 * routine delivering the workspace to a webhook of its choosing every morning,
 * and revoking it changed nothing.
 *
 * The routine is stamped by the database from the token, so these tests make
 * it the way PostgREST would apply a key's minted token: claims on the
 * transaction, role `authenticated`. Channels and triggers are written by the
 * API with the service role and the key passed along, so they are seeded that
 * way here.
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
import { seedWorkspace, type Seeded } from "./fixtures";

let owner: TestUser;
let seeded: Seeded;

async function makeKey(name: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from("api_keys")
    .insert({
      workspace_id: owner.workspaceId,
      user_id: owner.id,
      name,
      token_hash: crypto.randomUUID().replace(/-/g, "").repeat(2),
      prefix: "covan_sk_test",
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make a key: ${error.message}`);
  return data.id as string;
}

async function makeChannel(apiKeyId: string | null): Promise<string> {
  const { data, error } = await serviceClient()
    .from("delivery_channels")
    .insert({
      workspace_id: owner.workspaceId,
      user_id: owner.id,
      kind: "webhook",
      label: "receiver.example.com/…",
      secret_ciphertext: "not-a-real-ciphertext",
      api_key_id: apiKeyId,
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make a channel: ${error.message}`);
  return data.id as string;
}

/** A routine as the owner. `apiKeyId` set is a key request; null is a session. */
async function makeRoutine(
  channelId: string,
  apiKeyId: string | null,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const claims: Record<string, string> = { sub: owner.id, role: "authenticated" };
  if (apiKeyId) {
    claims.covan_key = apiKeyId;
    claims.covan_ws = owner.workspaceId;
  }
  const values = {
    workspace_id: owner.workspaceId,
    agent_id: seeded.agentId,
    user_id: owner.id,
    name: "Nightly digest",
    source_kind: "web",
    source_config: { url: "https://example.com/feed" },
    instruction: "summarise",
    delivery_channel_id: channelId,
    schedule_cron: "0 9 * * *",
    ...extra,
  };
  let id = "";
  await sql().begin(async (tx) => {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    await tx`set local role authenticated`;
    const [row] = await tx`insert into public.routines ${tx(values)} returning id`;
    id = row.id as string;
  });
  return id;
}

async function routine(id: string) {
  const { data } = await serviceClient()
    .from("routines")
    .select("status, paused_reason, api_key_id")
    .eq("id", id)
    .single();
  return data!;
}

async function revoke(keyId: string) {
  // Through the person's own client, exactly as `DELETE /api-keys/:id` does.
  const { data, error } = await owner.db
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", keyId)
    .select("id");
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
}

beforeAll(async () => {
  owner = await createTestUser("key-revocation-owner");
  seeded = await seedWorkspace(owner);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("a routine", () => {
  it("made with a key carries the key, without the API having to say so", async () => {
    const keyId = await makeKey("stamps");
    const id = await makeRoutine(seeded.channelId, keyId);
    expect((await routine(id)).api_key_id).toBe(keyId);
  });

  it("cannot be given a key by a client that names one", async () => {
    // The column is the token's to fill (0088's default), so a routine cannot
    // be made to look like a key's (and die with it) or like nobody's. Since
    // 0094 a client cannot even name it; 0088's trigger would overwrite it if
    // one could.
    const keyId = await makeKey("named");
    await expect(makeRoutine(seeded.channelId, null, { api_key_id: keyId })).rejects.toMatchObject({
      code: "42501",
    });

    const id = await makeRoutine(seeded.channelId, null);
    const { error } = await owner.db.from("routines").update({ api_key_id: keyId }).eq("id", id);
    expect(error?.code).toBe("42501");
    expect((await routine(id)).api_key_id).toBeNull();
  });
});

describe("revoking the key", () => {
  it("pauses its routines, disables its channels and deletes its triggers", async () => {
    const keyId = await makeKey("revoked");
    const keyChannel = await makeChannel(keyId);
    const byKey = await makeRoutine(seeded.channelId, keyId);
    // A routine a person made, delivering to the key's channel: still a
    // destination the key chose, so it pauses too.
    const toKeyChannel = await makeRoutine(keyChannel, null);
    // And one that has nothing to do with the key.
    const unrelated = await makeRoutine(seeded.channelId, null);

    const webhookRoutine = await makeRoutine(seeded.channelId, null, {
      trigger_kind: "webhook",
      source_kind: "none",
      source_config: {},
    });
    const { error: triggerError } = await serviceClient().from("routine_triggers").insert({
      routine_id: webhookRoutine,
      token_hash: crypto.randomUUID(),
      api_key_id: keyId,
    });
    expect(triggerError).toBeNull();

    await revoke(keyId);

    expect(await routine(byKey)).toMatchObject({
      status: "paused",
      paused_reason: expect.stringMatching(/API key .* was revoked/),
    });
    expect((await routine(toKeyChannel)).status).toBe("paused");
    expect((await routine(unrelated)).status).toBe("active");
    expect((await routine(webhookRoutine)).status).toBe("active");

    const { data: channel } = await serviceClient()
      .from("delivery_channels")
      .select("disabled_at")
      .eq("id", keyChannel)
      .single();
    expect(channel?.disabled_at).not.toBeNull();

    const { data: triggers } = await serviceClient()
      .from("routine_triggers")
      .select("routine_id")
      .eq("routine_id", webhookRoutine);
    expect(triggers).toEqual([]);
  });

  it("leaves a disabled channel impossible to choose again", async () => {
    const keyId = await makeKey("chosen-again");
    const keyChannel = await makeChannel(keyId);
    await revoke(keyId);

    const id = await makeRoutine(seeded.channelId, null);
    const { error } = await owner.db
      .from("routines")
      .update({ delivery_channel_id: keyChannel })
      .eq("id", id);
    expect(error?.code).toBe("23514");
  });

  it("is the only way a key goes: a client cannot delete one", async () => {
    // A delete would `set null` every tag above without running the trigger.
    const keyId = await makeKey("undeletable");
    const { error } = await owner.db.from("api_keys").delete().eq("id", keyId);
    expect(error?.code).toBe("42501");
  });
});
