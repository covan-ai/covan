/**
 * Knowledge is yours until you share it (0106).
 *
 * Every member used to read every bundle, and every writer could change or
 * delete any of them. A bundle is now its maker's alone until they share it:
 * its documents, its passages, its attachment to an agent and its place in
 * the trash all follow it.
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
let colleague: TestUser;
let admin: TestUser;
let seeded: Seeded;
let bundle: string;
let document: string;

async function add(user: TestUser, role: "admin" | "member") {
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: owner.workspaceId, user_id: user.id, role });
  if (error) throw new Error(`could not add ${role}: ${error.message}`);
}

beforeAll(async () => {
  owner = await createTestUser("kscope-owner");
  colleague = await createTestUser("kscope-colleague");
  admin = await createTestUser("kscope-admin");
  await add(colleague, "member");
  await add(admin, "admin");
  // The owner's own workspace, with an agent shared for editing.
  seeded = await seedWorkspace(owner);

  const made = await owner.db
    .from("knowledge_bundles")
    .insert({ workspace_id: owner.workspaceId, name: "My notes", created_by: owner.id })
    .select("id,scope")
    .single();
  if (made.error) throw new Error(made.error.message);
  expect(made.data.scope).toBe("owner");
  bundle = made.data.id as string;

  const doc = await owner.db
    .from("documents")
    .insert({ bundle_id: bundle, name: "salary.txt", content: "what I earn" })
    .select("id")
    .single();
  if (doc.error) throw new Error(doc.error.message);
  document = doc.data.id as string;

  const { error } = await serviceClient().from("document_chunks").insert({
    document_id: document,
    bundle_id: bundle,
    workspace_id: owner.workspaceId,
    chunk_index: 0,
    content: "what I earn",
    context: "salary.txt",
  });
  if (error) throw new Error(error.message);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

const sees = async (user: TestUser, table: string, column: string, id: string) =>
  ((await user.db.from(table).select(column).eq(column, id)).data ?? []).length > 0;

describe("a new bundle", () => {
  it("is its maker's alone: the bundle, its documents and its passages", async () => {
    expect(await sees(owner, "knowledge_bundles", "id", bundle)).toBe(true);
    expect(await sees(owner, "documents", "id", document)).toBe(true);
    expect(await sees(owner, "document_chunks", "document_id", document)).toBe(true);

    for (const other of [colleague, admin]) {
      expect(await sees(other, "knowledge_bundles", "id", bundle)).toBe(false);
      expect(await sees(other, "documents", "id", document)).toBe(false);
      expect(await sees(other, "document_chunks", "document_id", document)).toBe(false);
    }
  });

  it("cannot be written into, renamed or deleted by anybody else", async () => {
    const write = await colleague.db
      .from("documents")
      .insert({ bundle_id: bundle, name: "planted.txt", content: "x" });
    expect(write.error).not.toBeNull();

    const renamed = await admin.db
      .from("knowledge_bundles")
      .update({ name: "Mine now" })
      .eq("id", bundle)
      .select("id");
    expect(renamed.data ?? []).toEqual([]);

    const deleted = await admin.db.rpc("soft_delete_bundle", { p_bundle_id: bundle });
    expect(deleted.error?.code).toBe("P0002");
    const docDeleted = await colleague.db.rpc("soft_delete_document", { p_document_id: document });
    expect(docDeleted.error?.code).toBe("P0002");
  });

  it("can be attached to an agent by its owner only", async () => {
    const byColleague = await colleague.db
      .from("agent_bundles")
      .insert({ agent_id: seeded.agentId, bundle_id: bundle });
    expect(byColleague.error).not.toBeNull();

    const byOwner = await owner.db
      .from("agent_bundles")
      .insert({ agent_id: seeded.agentId, bundle_id: bundle });
    expect(byOwner.error).toBeNull();

    // Attached, and still nobody else's to see — the attachment included.
    const links = await colleague.db
      .from("agent_bundles")
      .select("bundle_id")
      .eq("agent_id", seeded.agentId)
      .eq("bundle_id", bundle);
    expect(links.data ?? []).toEqual([]);
  });

  it("grounds the owner's retrieval and nobody else's, and never a shared reply", async () => {
    const embedding = Array.from({ length: 1536 }, () => 0);
    const ask = (user: TestUser, extra: Record<string, unknown> = {}) =>
      user.db.rpc("match_chunks", {
        p_agent_id: seeded.agentId,
        p_query_embedding: embedding,
        p_match_count: 5,
        p_min_similarity: -1,
        p_query_terms: ["earn"],
        ...extra,
      });

    const mine = await ask(owner);
    expect((mine.data ?? []).map((r: { document_id: string }) => r.document_id)).toContain(
      document,
    );

    const theirs = await ask(colleague);
    expect((theirs.data ?? []).map((r: { document_id: string }) => r.document_id)).not.toContain(
      document,
    );

    const shared = await ask(owner, { p_shared_only: true });
    expect((shared.data ?? []).map((r: { document_id: string }) => r.document_id)).not.toContain(
      document,
    );

    // The service role sees everything unless told whose turn it is.
    const asColleague = await serviceClient().rpc("match_chunks", {
      p_agent_id: seeded.agentId,
      p_query_embedding: embedding,
      p_match_count: 5,
      p_min_similarity: -1,
      p_query_terms: ["earn"],
      p_viewer: colleague.id,
    });
    expect(
      (asColleague.data ?? []).map((r: { document_id: string }) => r.document_id),
    ).not.toContain(document);
  });

  it("is shared by its owner, and not by an admin", async () => {
    const byAdmin = await admin.db
      .from("knowledge_bundles")
      .update({ scope: "workspace" })
      .eq("id", bundle)
      .select("id");
    expect(byAdmin.data ?? []).toEqual([]);

    const byOwner = await owner.db
      .from("knowledge_bundles")
      .update({ scope: "workspace" })
      .eq("id", bundle);
    expect(byOwner.error).toBeNull();

    expect(await sees(colleague, "documents", "id", document)).toBe(true);
    expect(await sees(colleague, "document_chunks", "document_id", document)).toBe(true);
  });

  it("can be taken private again by its owner alone", async () => {
    const byAdmin = await admin.db
      .from("knowledge_bundles")
      .update({ scope: "owner" })
      .eq("id", bundle);
    expect(byAdmin.error?.code).toBe("42501");

    const byOwner = await owner.db
      .from("knowledge_bundles")
      .update({ scope: "owner" })
      .eq("id", bundle);
    expect(byOwner.error).toBeNull();
    expect(await sees(colleague, "documents", "id", document)).toBe(false);
  });

  it("stays out of everybody else's trash", async () => {
    const { error } = await owner.db.rpc("soft_delete_bundle", { p_bundle_id: bundle });
    expect(error).toBeNull();

    const trash = async (user: TestUser) =>
      ((await user.db.rpc("workspace_trash", { p_workspace_id: owner.workspaceId })).data ??
        []) as Array<{
        id: string;
      }>;
    expect((await trash(owner)).map((r) => r.id)).toContain(bundle);
    expect((await trash(colleague)).map((r) => r.id)).not.toContain(bundle);

    const restored = await colleague.db.rpc("restore_bundle", { p_bundle_id: bundle });
    expect(restored.error?.code).toBe("P0002");
    expect((await owner.db.rpc("restore_bundle", { p_bundle_id: bundle })).error).toBeNull();
  });
});

describe("a bundle nobody made", () => {
  it("is shared, since nobody could own it", async () => {
    const { data, error } = await serviceClient()
      .from("knowledge_bundles")
      .insert({ workspace_id: owner.workspaceId, name: "Imported" })
      .select("scope")
      .single();
    expect(error).toBeNull();
    expect(data?.scope).toBe("workspace");
  });
});
