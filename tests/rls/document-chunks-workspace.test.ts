/**
 * A passage names a document and a bundle in its own workspace (0092).
 *
 * The policies on `document_chunks` asked only whether the caller may write in
 * the chunk's `workspace_id`. So a member could file a chunk under their own
 * workspace naming another workspace's document or bundle — a citation waiting
 * to name a file the reader has no right to know exists.
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
let other: TestUser;
let mine: Seeded;
let theirs: Seeded;

beforeAll(async () => {
  owner = await createTestUser("chunks-owner");
  other = await createTestUser("chunks-other");
  mine = await seedWorkspace(owner);
  theirs = await seedWorkspace(other);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

function chunk(over: Record<string, unknown>) {
  return {
    document_id: mine.documentId,
    bundle_id: mine.bundleId,
    workspace_id: owner.workspaceId,
    chunk_index: 0,
    content: "a passage",
    ...over,
  };
}

describe("a passage", () => {
  it("can be written for a document in the writer's own workspace", async () => {
    const { error } = await owner.db.from("document_chunks").insert(chunk({}));
    expect(error).toBeNull();
  });

  it.each([
    ["another workspace's document", { document_id: "THEIR_DOC" }],
    ["another workspace's bundle", { bundle_id: "THEIR_BUNDLE" }],
  ])("cannot name %s", async (_label, over) => {
    const resolved = Object.fromEntries(
      Object.entries(over).map(([k, v]) => [
        k,
        v === "THEIR_DOC" ? theirs.documentId : theirs.bundleId,
      ]),
    );
    const { error } = await owner.db.from("document_chunks").insert(chunk(resolved));
    expect(error?.code).toBe("23514");
  });

  it("is held to the rule for the service role too", async () => {
    const { error } = await serviceClient()
      .from("document_chunks")
      .insert(chunk({ document_id: theirs.documentId }));
    expect(error?.code).toBe("23514");
  });

  it("still moves with its document to another bundle in the workspace", async () => {
    const { data: second } = await owner.db
      .from("knowledge_bundles")
      .insert({ workspace_id: owner.workspaceId, name: "Second", created_by: owner.id })
      .select("id")
      .single();
    // Chunks first, then the document — the order `routes/documents.ts` uses.
    const moved = await owner.db
      .from("document_chunks")
      .update({ bundle_id: second!.id })
      .eq("document_id", mine.documentId);
    expect(moved.error).toBeNull();
  });
});
