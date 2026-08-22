/**
 * A document can change bundles — and its passages have to come with it.
 *
 * Retrieval reads scope from `document_chunks.bundle_id` (match_chunks, 0005),
 * so re-pointing the document row alone is a move that looks complete and is
 * not: the passages stay searchable only under the old bundle, until it is
 * detached and they stop being searchable at all.
 *
 * Until 0024 that table had no update policy, and RLS answers an update it has
 * no policy for by matching no rows and reporting no error — the failure had no
 * symptom at the database, and the worker had to be taught to notice a move
 * that changed nothing. This file is the guard on the policy itself: a writer
 * can re-point a chunk, a viewer cannot, and neither fact is visible from
 * reading the route.
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
let viewer: TestUser;
let seeded: Seeded;
let secondBundleId: string;
let chunkId: string;

beforeAll(async () => {
  owner = await createTestUser("move-owner");
  viewer = await createTestUser("move-viewer");
  seeded = await seedWorkspace(owner);

  const { error: memberErr } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: owner.workspaceId, user_id: viewer.id, role: "viewer" });
  if (memberErr) throw new Error(`could not seed the membership: ${memberErr.message}`);

  const { data: bundle, error: bundleErr } = await owner.db
    .from("knowledge_bundles")
    .insert({
      workspace_id: owner.workspaceId,
      name: "The bundle it moves into",
      created_by: owner.id,
    })
    .select("id")
    .single();
  if (bundleErr || !bundle)
    throw new Error(`could not seed the second bundle: ${bundleErr?.message}`);
  secondBundleId = bundle.id as string;

  const { data: chunk, error: chunkErr } = await owner.db
    .from("document_chunks")
    .insert({
      document_id: seeded.documentId,
      bundle_id: seeded.bundleId,
      workspace_id: owner.workspaceId,
      chunk_index: 0,
      content: "a passage that has to remain findable after the move",
    })
    .select("id")
    .single();
  if (chunkErr || !chunk) throw new Error(`could not seed the chunk: ${chunkErr?.message}`);
  chunkId = chunk.id as string;
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

/** Which bundle the chunk is searchable under, asked as the service role. */
async function chunkBundle(): Promise<string> {
  const { data } = await serviceClient()
    .from("document_chunks")
    .select("bundle_id")
    .eq("id", chunkId)
    .single();
  return data?.bundle_id as string;
}

describe("moving a document's passages between bundles", () => {
  it("is refused for a viewer", async () => {
    await viewer.db.from("document_chunks").update({ bundle_id: secondBundleId }).eq("id", chunkId);

    expect(await chunkBundle(), "a viewer moved a passage between bundles").toBe(seeded.bundleId);
  });

  it("is allowed for someone who can write in the workspace", async () => {
    const { error } = await owner.db
      .from("document_chunks")
      .update({ bundle_id: secondBundleId })
      .eq("id", chunkId);

    expect(error).toBeNull();
    expect(await chunkBundle(), "the passage did not move — is 0024 applied?").toBe(secondBundleId);
  });
});
