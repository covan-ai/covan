/**
 * The document columns the engine reads as fact, and who may write them (0085).
 *
 * `documents` policies scope the ROW: a bundle in a workspace you can write.
 * Until 0085 that was the whole of it, and every column on the row was the
 * caller's to set through the Data API -- including the ones the sync engine,
 * the routine executor and the purge act on without asking anybody:
 *
 *   r2_key         what download serves and what the purge deletes
 *   connection_id  which rows a connection's sync rewrites and a routine reads
 *   routine_id     which rows a routine's retention prunes
 *   deleted_at     when the thirty days started
 *
 * Each of those let a member of one workspace reach into another: a key that
 * names somebody else's stored object, a document that claims somebody else's
 * connection. These tests are the refusals, plus the two things the fix must
 * not break: removing a connection or a routine still clears the reference on
 * the documents, because that UPDATE arrives as a foreign-key action carrying
 * the caller's JWT.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

let owner: TestUser;
let outsider: TestUser;
let ownerSeed: Seeded;
let outsiderSeed: Seeded;

/** A key in the shape the upload route mints. */
function keyUnder(bundleId: string, name = "file.txt"): string {
  return `${bundleId}/${crypto.randomUUID()}-${name}`;
}

/** What the API's own upload would insert. */
async function upload(user: TestUser, bundleId: string, extra: Record<string, unknown> = {}) {
  return user.db
    .from("documents")
    .insert({ bundle_id: bundleId, name: "upload.txt", size: 1, ...extra })
    .select("id, r2_key, deleted_at, deleted_by")
    .single();
}

beforeAll(async () => {
  owner = await createTestUser("engine-cols-owner");
  outsider = await createTestUser("engine-cols-outsider");
  ownerSeed = await seedWorkspace(owner);
  outsiderSeed = await seedWorkspace(outsider);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("an inserted storage key", () => {
  it("is accepted in the shape the API mints, under the row's own bundle", async () => {
    const r2Key = keyUnder(ownerSeed.bundleId, "notes.md");
    const { data, error } = await upload(owner, ownerSeed.bundleId, { r2_key: r2Key });
    expect(error).toBeNull();
    expect(data?.r2_key).toBe(r2Key);
  });

  it("is refused under another workspace's bundle", async () => {
    // The outsider's own bundle, a key naming the owner's: download would have
    // served the owner's file, and the purge would have deleted it.
    const { data, error } = await upload(outsider, outsiderSeed.bundleId, {
      r2_key: keyUnder(ownerSeed.bundleId),
    });
    expect(data).toBeNull();
    expect(error?.code).toBe("23514");
  });

  it("is refused when it is anything but a fresh key under the bundle", async () => {
    const own = outsiderSeed.bundleId;
    for (const r2Key of [
      `${own}/../${ownerSeed.bundleId}/${crypto.randomUUID()}-file.txt`,
      `${own}/x`,
      `avatars/${owner.id}/${crypto.randomUUID()}.png`,
      `${own}/${crypto.randomUUID()}-a/b.txt`,
    ]) {
      const { error } = await upload(outsider, own, { r2_key: r2Key });
      expect(error?.code, r2Key).toBe("23514");
    }
  });

  it("belongs to one row only", async () => {
    // Even the service role cannot hand one object to two rows: purging either
    // would delete the other's bytes.
    const r2Key = keyUnder(ownerSeed.bundleId);
    const first = await serviceClient()
      .from("documents")
      .insert({ bundle_id: ownerSeed.bundleId, name: "a.txt", r2_key: r2Key });
    expect(first.error).toBeNull();
    const second = await serviceClient()
      .from("documents")
      .insert({ bundle_id: ownerSeed.bundleId, name: "b.txt", r2_key: r2Key });
    expect(second.error?.code).toBe("23505");
  });
});

describe("columns only the engine writes", () => {
  it("cannot be set on insert", async () => {
    const connection = await serviceClient()
      .from("connections")
      .insert({
        workspace_id: owner.workspaceId,
        bundle_id: ownerSeed.bundleId,
        user_id: owner.id,
        provider: "notion",
        account_label: "owner notion",
        secret_ciphertext: "not-a-real-ciphertext",
      })
      .select("id")
      .single();
    expect(connection.error).toBeNull();

    for (const extra of [
      { connection_id: connection.data!.id },
      { routine_id: ownerSeed.routineId },
      { external_id: "page-1" },
      { external_url: "https://notion.so/page-1" },
      { deleted_at: "2000-01-01T00:00:00Z" },
      { created_at: "2000-01-01T00:00:00Z" },
    ]) {
      const { error } = await upload(outsider, outsiderSeed.bundleId, extra);
      expect(error?.code, JSON.stringify(extra)).toBe("42501");
    }
  });

  it("cannot be changed on a document the caller may otherwise write", async () => {
    const { data: doc } = await upload(owner, ownerSeed.bundleId);
    for (const change of [
      { r2_key: keyUnder(ownerSeed.bundleId) },
      { connection_id: null },
      { routine_id: ownerSeed.routineId },
      { external_url: "javascript:alert(1)" },
      { synced_at: "2000-01-01T00:00:00Z" },
      { name: "renamed.txt" },
    ]) {
      const { error } = await owner.db.from("documents").update(change).eq("id", doc!.id);
      expect(error?.code, JSON.stringify(change)).toBe("42501");
    }
  });
});

describe("moving and hiding a document", () => {
  it("moves within the workspace", async () => {
    const { data: doc } = await upload(owner, ownerSeed.bundleId);
    const { data: other } = await owner.db
      .from("knowledge_bundles")
      .insert({ workspace_id: owner.workspaceId, name: "Elsewhere", created_by: owner.id })
      .select("id")
      .single();

    const { data, error } = await owner.db
      .from("documents")
      .update({ bundle_id: other!.id })
      .eq("id", doc!.id)
      .select("bundle_id")
      .single();
    expect(error).toBeNull();
    expect(data?.bundle_id).toBe(other!.id);
  });

  it("does not move into another workspace, even one the caller can write", async () => {
    // The owner joins the outsider's workspace as a member, so both bundles
    // pass the policies. The API refused this move with a 400; the database
    // now refuses it too.
    const { error: joinError } = await serviceClient()
      .from("workspace_members")
      .insert({ workspace_id: outsider.workspaceId, user_id: owner.id, role: "member" });
    expect(joinError).toBeNull();

    const { data: doc } = await upload(owner, ownerSeed.bundleId);
    const { error } = await owner.db
      .from("documents")
      .update({ bundle_id: outsiderSeed.bundleId })
      .eq("id", doc!.id);
    expect(error?.code).toBe("23514");

    await serviceClient()
      .from("workspace_members")
      .delete()
      .eq("workspace_id", outsider.workspaceId)
      .eq("user_id", owner.id);
  });

  it("is hidden through soft_delete_document, not by writing deleted_at", async () => {
    // A backdated `deleted_at` would hand the row to the purge thirty days
    // early. The column is the definer function's, which stamps now().
    const { data: doc } = await upload(owner, ownerSeed.bundleId);
    const { error } = await owner.db
      .from("documents")
      .update({ deleted_at: "2000-01-01T00:00:00Z" })
      .eq("id", doc!.id);
    expect(error?.code).toBe("42501");

    const { data } = await serviceClient()
      .from("documents")
      .select("deleted_at")
      .eq("id", doc!.id)
      .single();
    expect(data?.deleted_at).toBeNull();
  });
});

describe("what the guard must not stop", () => {
  it("lets removing a connection clear it from the documents it imported", async () => {
    const { data: connection } = await serviceClient()
      .from("connections")
      .insert({
        workspace_id: owner.workspaceId,
        bundle_id: ownerSeed.bundleId,
        user_id: owner.id,
        provider: "notion",
        account_label: "to be removed",
        secret_ciphertext: "not-a-real-ciphertext",
      })
      .select("id")
      .single();
    const { data: doc } = await serviceClient()
      .from("documents")
      .insert({
        bundle_id: ownerSeed.bundleId,
        name: "synced.md",
        connection_id: connection!.id,
        external_id: "page-9",
        r2_key: keyUnder(ownerSeed.bundleId, "synced.md"),
      })
      .select("id")
      .single();

    // As the person, through their own client: the `set null` runs as a
    // foreign-key action with their JWT still in the request.
    const { data: removed, error } = await owner.db
      .from("connections")
      .delete()
      .eq("id", connection!.id)
      .select("id");
    expect(error).toBeNull();
    expect(removed).toHaveLength(1);

    const { data } = await serviceClient()
      .from("documents")
      .select("connection_id")
      .eq("id", doc!.id)
      .single();
    expect(data?.connection_id).toBeNull();
  });

  it("lets deleting a routine clear it from the documents it filed", async () => {
    const throwaway = await seedWorkspace(owner);
    const { data: doc } = await serviceClient()
      .from("documents")
      .insert({
        bundle_id: throwaway.bundleId,
        name: "digest.md",
        routine_id: throwaway.routineId,
        r2_key: keyUnder(throwaway.bundleId, "digest.md"),
      })
      .select("id")
      .single();

    const { data: removed, error } = await owner.db
      .from("routines")
      .delete()
      .eq("id", throwaway.routineId)
      .select("id");
    expect(error).toBeNull();
    expect(removed).toHaveLength(1);

    const { data } = await serviceClient()
      .from("documents")
      .select("routine_id")
      .eq("id", doc!.id)
      .single();
    expect(data?.routine_id).toBeNull();
  });

  it("lets soft delete and restore go through their functions", async () => {
    const { data: doc } = await upload(owner, ownerSeed.bundleId);
    expect((await owner.db.rpc("soft_delete_document", { p_document_id: doc!.id })).error).toBe(
      null,
    );
    expect((await owner.db.rpc("restore_document", { p_document_id: doc!.id })).error).toBe(null);
  });
});
