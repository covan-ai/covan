/**
 * What happens to a connection when the person who made it goes.
 *
 * 0043 said in its own comments that a connection belongs to its workspace —
 * every member can see it, an admin can turn it off, because "somebody leaves"
 * was a case it had thought about. Then it wrote
 * `user_id ... on delete cascade`, so closing a Covan account DELETED the
 * connection and left its documents as orphans nothing could refresh. 0057 says
 * it the way 0043 meant it, and this is where that is provable: a foreign key's
 * action and a policy's reach are both invisible from TypeScript.
 *
 * The second half is `paused_reason`. 0043 granted `authenticated` UPDATE on
 * that column so resuming could clear it, which also meant any member who can
 * write could put an arbitrary sentence in a column the interface prints on a
 * teammate's page. 0057 revokes it and adds `paused_code`, which no client may
 * write at all.
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

/** Not a real token — nothing here decrypts it. */
const CIPHERTEXT = "v1.AAAAAAAAAAAAAAAA.ZmFrZS1jaXBoZXJ0ZXh0";

let admin: TestUser;
let holder: TestUser;
let writer: TestUser;
let viewer: TestUser;
let bundleId: string;

async function addMember(user: TestUser, role: "admin" | "member" | "viewer") {
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: admin.workspaceId, user_id: user.id, role });
  if (error) throw new Error(`could not add ${role}: ${error.message}`);
}

async function makeConnection(userId: string | null): Promise<string> {
  const { data, error } = await serviceClient()
    .from("connections")
    .insert({
      workspace_id: admin.workspaceId,
      bundle_id: bundleId,
      user_id: userId,
      provider: "notion",
      account_label: "Covan HQ",
      secret_ciphertext: CIPHERTEXT,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seeding connection failed: ${error?.message}`);
  return data.id as string;
}

beforeAll(async () => {
  admin = await createTestUser("conn-admin");
  holder = await createTestUser("conn-holder");
  writer = await createTestUser("conn-writer");
  viewer = await createTestUser("conn-viewer");

  const { data: bundle, error } = await admin.db
    .from("knowledge_bundles")
    .insert({ workspace_id: admin.workspaceId, name: "Handbook", created_by: admin.id })
    .select("id")
    .single();
  if (error || !bundle) throw new Error(`seeding bundle failed: ${error?.message}`);
  bundleId = bundle.id;

  await addMember(holder, "member");
  await addMember(writer, "member");
  await addMember(viewer, "viewer");
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("a connection outliving its grant holder", () => {
  it("survives the account closing, unowned", async () => {
    const connectionId = await makeConnection(holder.id);

    // What closing an account does, in the order the product does it: the
    // person's own workspace goes, then the account.
    const db = sql();
    await db.begin(async (tx) => {
      await tx`delete from public.chat_sessions where user_id = ${holder.id}::uuid`;
      await tx`delete from public.workspaces where created_by = ${holder.id}::uuid`;
      await tx`delete from auth.users where id = ${holder.id}::uuid`;
    });

    const { data } = await serviceClient()
      .from("connections")
      .select("id,user_id,bundle_id")
      .eq("id", connectionId)
      .maybeSingle();

    // Before 0057 this was null: the row was deleted, and every document it had
    // imported was left with a null `connection_id` and no way back.
    expect(data).toMatchObject({ id: connectionId, user_id: null, bundle_id: bundleId });
  });

  it("keeps the documents it imported attached to it", async () => {
    const connectionId = await makeConnection(null);
    const { error } = await serviceClient().from("documents").insert({
      bundle_id: bundleId,
      connection_id: connectionId,
      external_id: "page-1",
      name: "Handbook.md",
      size: 10,
      r2_key: "k/handbook",
    });
    expect(error).toBeNull();

    const { data } = await serviceClient()
      .from("documents")
      .select("connection_id")
      .eq("connection_id", connectionId);
    expect(data).toHaveLength(1);
  });
});

describe("who may reconnect one", () => {
  it("lets any writing member take over a connection nobody holds", async () => {
    const connectionId = await makeConnection(null);

    // `writer` is an ordinary member, not an admin and not the grant holder.
    // The point of surviving the grant holder is that the workspace keeps its
    // connection; needing an admin would strand a team without one.
    const { data } = await writer.db
      .from("connections")
      .update({ status: "paused" })
      .eq("id", connectionId)
      .select("id");
    expect(data).toHaveLength(1);
  });

  it("still refuses a viewer", async () => {
    const connectionId = await makeConnection(null);

    const { data } = await viewer.db
      .from("connections")
      .update({ status: "paused" })
      .eq("id", connectionId)
      .select("id");
    // `can_write_in_workspace` is the second half of the orphan clause, and it
    // is what keeps "unowned" from meaning "anybody".
    expect(data ?? []).toEqual([]);
  });

  it("leaves a held connection to its holder and the admins", async () => {
    const connectionId = await makeConnection(admin.id);

    const { data: theirs } = await writer.db
      .from("connections")
      .update({ status: "paused" })
      .eq("id", connectionId)
      .select("id");
    expect(theirs ?? []).toEqual([]);

    const { data: mine } = await admin.db
      .from("connections")
      .update({ status: "paused" })
      .eq("id", connectionId)
      .select("id");
    expect(mine).toHaveLength(1);
  });
});

describe("why it was paused", () => {
  it("is readable by the workspace", async () => {
    const connectionId = await makeConnection(admin.id);
    await serviceClient()
      .from("connections")
      .update({ status: "paused", paused_reason: "access revoked", paused_code: "grant_revoked" })
      .eq("id", connectionId);

    const { data, error } = await writer.db
      .from("connections")
      .select("status,paused_reason,paused_code")
      .eq("id", connectionId)
      .single();

    expect(error).toBeNull();
    expect(data).toMatchObject({ paused_reason: "access revoked", paused_code: "grant_revoked" });
  });

  it("cannot be rewritten by a member", async () => {
    const connectionId = await makeConnection(admin.id);

    const { error } = await admin.db
      .from("connections")
      .update({ paused_reason: "Reconnect your account at evil.example" })
      .eq("id", connectionId);

    // The grant is gone, so this is a column-level refusal rather than a policy
    // one: even the person the connection belongs to cannot write it.
    expect(error?.code).toBe("42501");
  });

  it("cannot be set by a member either", async () => {
    const connectionId = await makeConnection(admin.id);

    const { error } = await admin.db
      .from("connections")
      .update({ paused_code: "grant_revoked" })
      .eq("id", connectionId);

    // `paused_code` was never granted. The interface branches on it, so a
    // client that could write it could make Reconnect appear on any row.
    expect(error?.code).toBe("42501");
  });

  it("still lets a person pause and resume", async () => {
    const connectionId = await makeConnection(admin.id);

    const { data, error } = await admin.db
      .from("connections")
      .update({ status: "paused", sync_interval_minutes: 720 })
      .eq("id", connectionId)
      .select("id");

    // The two columns 0057 left granted, which are the two a person actually
    // changes from the interface.
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("refuses a code the schema does not know", async () => {
    const connectionId = await makeConnection(admin.id);

    const { error } = await serviceClient()
      .from("connections")
      .update({ paused_code: "vibes" })
      .eq("id", connectionId);

    expect(error?.code).toBe("23514");
  });
});

describe("the approval a client may not forge", () => {
  it("is invisible to the people it is about", async () => {
    const connectionId = await makeConnection(admin.id);

    const { error } = await admin.db
      .from("connections")
      .select("removals_approved_at")
      .eq("id", connectionId);

    // Not in 0057's select grant. It is a decision the API records after
    // checking which pause it answers, and a client that could read or write it
    // could skip the check.
    expect(error?.code).toBe("42501");
  });

  it("is not writable either", async () => {
    const connectionId = await makeConnection(admin.id);

    const { error } = await admin.db
      .from("connections")
      .update({ removals_approved_at: new Date().toISOString() })
      .eq("id", connectionId);

    expect(error?.code).toBe("42501");
  });
});
