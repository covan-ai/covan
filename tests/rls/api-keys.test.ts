/**
 * What the database says about API keys.
 *
 * A key is a credential that becomes a person: the Worker looks it up, mints a
 * short-lived token for its owner, and the request arrives as them. Everything
 * downstream of that is already covered by the rest of this suite, because the
 * request is indistinguishable from a browser's. What is NOT covered anywhere
 * else is the `api_keys` table itself, and it holds the one thing in this
 * database that is worth stealing on its own.
 *
 * So: a key is visible only to the person it belongs to, an update may revoke
 * and rename and nothing else, revocation is one-way, and the count an admin can
 * ask for is refused to everybody else.
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
let colleague: TestUser;
let outsider: TestUser;

/** A key row, inserted as the person it belongs to, the way the route does. */
async function createKey(user: TestUser, name: string, workspaceId = user.workspaceId) {
  return user.db
    .from("api_keys")
    .insert({
      workspace_id: workspaceId,
      user_id: user.id,
      name,
      // Any distinct string: nothing in the database interprets it, and the
      // hashing happens in the Worker.
      token_hash: `hash-${name}-${user.id}`,
      prefix: "covan_sk_aaaaaa",
    })
    .select("id")
    .single();
}

beforeAll(async () => {
  owner = await createTestUser("keys-owner");
  colleague = await createTestUser("keys-colleague");
  outsider = await createTestUser("keys-outsider");

  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: owner.workspaceId, user_id: colleague.id, role: "member" });
  if (error) throw new Error(`could not add the colleague: ${error.message}`);
}, 60_000);

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("who can see a key", () => {
  it("shows a key to nobody but its owner", async () => {
    const { data: created, error } = await createKey(owner, "owner-visible");
    expect(error).toBeNull();

    const mine = await owner.db.from("api_keys").select("id").eq("id", created!.id);
    expect(mine.data).toHaveLength(1);

    // A colleague in the same workspace, and an admin of it, still sees nothing:
    // the select policy has no admin branch, deliberately. A key acts as its
    // owner, so listing somebody else's is listing their credentials.
    const theirs = await colleague.db.from("api_keys").select("id").eq("id", created!.id);
    expect(theirs.data).toEqual([]);

    const strangers = await outsider.db.from("api_keys").select("id").eq("id", created!.id);
    expect(strangers.data).toEqual([]);
  });

  it("refuses a key minted in somebody else's name", async () => {
    const { error } = await colleague.db.from("api_keys").insert({
      workspace_id: owner.workspaceId,
      user_id: owner.id,
      name: "not mine to make",
      token_hash: "hash-impersonation",
      prefix: "covan_sk_aaaaaa",
    });

    expect(error).not.toBeNull();
  });

  it("refuses a key in a workspace the caller is not in", async () => {
    const { error } = await createKey(outsider, "wrong-workspace", owner.workspaceId);

    expect(error).not.toBeNull();
  });
});

describe("what an update may do", () => {
  it("lets the owner revoke", async () => {
    const { data: created } = await createKey(owner, "to-revoke");

    const { data, error } = await owner.db
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", created!.id)
      .select("id");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("refuses to un-revoke", async () => {
    // Without this, revocation is reversible and a key revoked because it leaked
    // comes back the moment the same request is replayed with a null.
    const { data: created } = await createKey(owner, "stays-revoked");
    await owner.db
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", created!.id);

    const { error } = await owner.db
      .from("api_keys")
      .update({ revoked_at: null })
      .eq("id", created!.id);

    expect(error).not.toBeNull();
  });

  it("refuses to move the secret behind a row", async () => {
    // Renaming is allowed; re-pointing is not. Otherwise "revoke a key" becomes
    // "swap the credential a row's history is describing".
    const { data: created } = await createKey(owner, "fixed-hash");

    const renamed = await owner.db
      .from("api_keys")
      .update({ name: "a better name" })
      .eq("id", created!.id)
      .select("id");
    expect(renamed.error).toBeNull();
    expect(renamed.data).toHaveLength(1);

    const rehashed = await owner.db
      .from("api_keys")
      .update({ token_hash: "hash-of-a-key-i-just-made-up" })
      .eq("id", created!.id);
    expect(rehashed.error).not.toBeNull();

    const reowned = await owner.db
      .from("api_keys")
      .update({ user_id: colleague.id })
      .eq("id", created!.id);
    expect(reowned.error).not.toBeNull();
  });

  it("refuses an update to somebody else's key", async () => {
    const { data: created } = await createKey(owner, "not-yours-to-revoke");

    const { data } = await colleague.db
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", created!.id)
      .select("id");

    // No error, no rows: the policy hides it rather than refusing it, which is
    // what RLS does on an UPDATE that matches nothing.
    expect(data).toEqual([]);
  });
});

describe("workspace_api_key_count", () => {
  it("tells an admin how many live keys somebody has", async () => {
    // The number the removal dialog needs: their keys die with their membership,
    // and an admin who is not told finds out when a script stops overnight.
    const { data: created } = await createKey(colleague, "colleagues-live-key", owner.workspaceId);

    const { data, error } = await owner.db.rpc("workspace_api_key_count", {
      p_workspace_id: owner.workspaceId,
      p_user_id: colleague.id,
    });

    expect(error).toBeNull();
    expect(data).toBeGreaterThanOrEqual(1);

    // And a revoked key is not a live one.
    const before = data as number;
    await colleague.db
      .from("api_keys")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", created!.id);

    const after = await owner.db.rpc("workspace_api_key_count", {
      p_workspace_id: owner.workspaceId,
      p_user_id: colleague.id,
    });
    expect(after.data).toBe(before - 1);
  });

  it("raises for a member who is not an admin, rather than answering zero", async () => {
    // 0032's rule: a definer function that returns an empty answer to somebody
    // it should have refused is indistinguishable from an empty workspace.
    const { error } = await colleague.db.rpc("workspace_api_key_count", {
      p_workspace_id: owner.workspaceId,
      p_user_id: owner.id,
    });

    expect(error).not.toBeNull();
  });

  it("raises for somebody outside the workspace entirely", async () => {
    const { error } = await outsider.db.rpc("workspace_api_key_count", {
      p_workspace_id: owner.workspaceId,
      p_user_id: owner.id,
    });

    expect(error).not.toBeNull();
  });
});
