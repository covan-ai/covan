/**
 * Deleting for good, syncing one file, and counting (0107).
 *
 * `forget_deleted` skips the thirty days, so it asks what a restore would: a
 * deleted bundle or document the caller can see, in a workspace they write
 * in. `resync_document` only forgets a synced file's version, and only for
 * somebody who could change it. `knowledge_usage` counts with the caller's
 * own policies.
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

async function bundle(user: TestUser, name: string, scope: "owner" | "workspace") {
  const { data, error } = await user.db
    .from("knowledge_bundles")
    .insert({ workspace_id: owner.workspaceId, name, created_by: user.id, scope })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

async function document(user: TestUser, bundleId: string, name: string) {
  const { data, error } = await user.db
    .from("documents")
    .insert({ bundle_id: bundleId, name, content: "text", size: 4 })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

beforeAll(async () => {
  owner = await createTestUser("kclean-owner");
  colleague = await createTestUser("kclean-colleague");
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: owner.workspaceId, user_id: colleague.id, role: "member" });
  if (error) throw new Error(error.message);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("deleting for good", () => {
  it("is refused for somebody else's private file, and done for the owner", async () => {
    const mine = await bundle(owner, "Mine", "owner");
    const doc = await document(owner, mine, "secret.txt");
    expect((await owner.db.rpc("soft_delete_document", { p_document_id: doc })).error).toBeNull();

    const byColleague = await colleague.db.rpc("forget_deleted", {
      p_kind: "document",
      p_id: doc,
    });
    expect(byColleague.error?.code).toBe("P0002");

    const byOwner = await owner.db.rpc("forget_deleted", { p_kind: "document", p_id: doc });
    expect(byOwner.error).toBeNull();
    const left = await serviceClient().from("documents").select("id").eq("id", doc);
    expect(left.data ?? []).toEqual([]);
  });

  it("only reaches what is already in Recently deleted", async () => {
    const shared = await bundle(owner, "Shared", "workspace");
    const live = await document(owner, shared, "live.txt");
    const { error } = await colleague.db.rpc("forget_deleted", { p_kind: "document", p_id: live });
    expect(error?.code).toBe("P0002");
  });
});

describe("syncing one file now", () => {
  it("is for synced files only", async () => {
    const shared = await bundle(owner, "Uploads", "workspace");
    const uploaded = await document(owner, shared, "uploaded.txt");
    const { error } = await colleague.db.rpc("resync_document", { p_document_id: uploaded });
    expect(error?.code).toBe("22023");
  });
});

describe("counting", () => {
  it("counts only what the caller can see", async () => {
    const before = await colleague.db.rpc("knowledge_usage", { p_workspace_id: owner.workspaceId });
    const privately = await bundle(owner, "Private count", "owner");
    await document(owner, privately, "uncounted.txt");
    const after = await colleague.db.rpc("knowledge_usage", { p_workspace_id: owner.workspaceId });

    const first = (before.data as Array<{ documents: number }>)[0];
    const second = (after.data as Array<{ documents: number }>)[0];
    expect(Number(second.documents)).toBe(Number(first.documents));
  });
});
