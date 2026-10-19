/**
 * Proof that keeping embeddings in a passage index (0116) moves no authority
 * out of Postgres.
 *
 * `match_passages_ranked` is handed passage ids by the worker, which got them
 * from the index. Nothing stops a caller sending any ids it likes, so the
 * function has to read them under the caller's policies and the agent's
 * bundles exactly as `match_chunks` reads rows it found itself — an id from
 * another workspace is not an answer.
 *
 * And the trigger that tells the index what changed: it records a passage
 * whose embedding is not in its row when that passage is deleted or moves
 * bundle, records nothing for one whose embedding is, and no client can read
 * what it wrote.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient,
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

let owner: TestUser;
let stranger: TestUser;
let mine: Seeded;
let theirs: Seeded;
let myPassage: string;
let theirPassage: string;

async function passage(
  user: TestUser,
  seeded: Seeded,
  content: string,
  embedding: number[] | null = null,
): Promise<string> {
  const { data, error } = await serviceClient()
    .from("document_chunks")
    .insert({
      document_id: seeded.documentId,
      bundle_id: seeded.bundleId,
      workspace_id: user.workspaceId,
      chunk_index: Math.floor(Math.random() * 1_000_000),
      content,
      ...(embedding ? { embedding } : {}),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`could not seed a passage: ${error?.message}`);
  return (data as { id: string }).id;
}

async function changesFor(chunkId: string) {
  const { data, error } = await serviceClient()
    .from("passage_vector_changes")
    .select("chunk_id,bundle_id")
    .eq("chunk_id", chunkId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

beforeAll(async () => {
  owner = await createTestUser("passage-owner");
  stranger = await createTestUser("passage-stranger");
  mine = await seedWorkspace(owner);
  theirs = await seedWorkspace(stranger);
  const service = serviceClient();
  for (const s of [mine, theirs]) {
    const { error } = await service
      .from("agent_bundles")
      .insert({ agent_id: s.agentId, bundle_id: s.bundleId });
    if (error) throw new Error(`could not link an agent to its bundle: ${error.message}`);
  }
  myPassage = await passage(owner, mine, "our refund window is thirty days");
  theirPassage = await passage(stranger, theirs, "their salary bands for next year");
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("match_passages_ranked", () => {
  it("answers with the caller's own passages from the ids it is handed", async () => {
    const { data, error } = await owner.db.rpc("match_passages_ranked", {
      p_agent_id: mine.agentId,
      p_vector_ids: [myPassage],
      p_vector_similarities: [0.8],
      p_match_count: 5,
    });
    expect(error).toBeNull();
    expect((data ?? []).map((r: { content: string }) => r.content)).toEqual([
      "our refund window is thirty days",
    ]);
  });

  it("drops an id from another workspace, whatever the caller sends", async () => {
    const { data, error } = await owner.db.rpc("match_passages_ranked", {
      p_agent_id: mine.agentId,
      p_vector_ids: [theirPassage, myPassage],
      p_vector_similarities: [0.99, 0.5],
      p_match_count: 5,
    });
    expect(error).toBeNull();
    const contents = (data ?? []).map((r: { content: string }) => r.content);
    expect(contents).not.toContain("their salary bands for next year");
    expect(contents).toEqual(["our refund window is thirty days"]);
  });

  it("finds nothing through another workspace's agent", async () => {
    const { data, error } = await owner.db.rpc("match_passages_ranked", {
      p_agent_id: theirs.agentId,
      p_vector_ids: [theirPassage],
      p_vector_similarities: [0.99],
      p_match_count: 5,
    });
    expect(error).toBeNull();
    expect(data ?? []).toEqual([]);
  });

  it("keeps the similarity floor", async () => {
    const { data } = await owner.db.rpc("match_passages_ranked", {
      p_agent_id: mine.agentId,
      p_vector_ids: [myPassage],
      p_vector_similarities: [0.1],
      p_match_count: 5,
      p_min_similarity: 0.3,
    });
    expect(data ?? []).toEqual([]);
  });

  it("is not callable without signing in", async () => {
    const { error } = await anonClient().rpc("match_passages_ranked", {
      p_agent_id: mine.agentId,
      p_vector_ids: [myPassage],
      p_vector_similarities: [0.8],
      p_match_count: 5,
    });
    expect(error).not.toBeNull();
  });
});

describe("passage_vector_changes", () => {
  it("records a passage beside the database leaving, and not one in it", async () => {
    const beside = await passage(owner, mine, "a passage whose vector is elsewhere");
    const inline = await passage(
      owner,
      mine,
      "a passage whose vector is here",
      Array.from({ length: 1536 }, (_, i) => (i === 3 ? 1 : 0)),
    );
    const service = serviceClient();
    await service.from("document_chunks").delete().in("id", [beside, inline]);

    expect(await changesFor(beside)).toEqual([{ chunk_id: beside, bundle_id: null }]);
    expect(await changesFor(inline)).toEqual([]);
  });

  it("records the bundle a passage moved to", async () => {
    const moving = await passage(owner, mine, "a passage about to change bundle");
    const service = serviceClient();
    const { data: bundle, error } = await service
      .from("knowledge_bundles")
      .insert({ workspace_id: owner.workspaceId, name: "Elsewhere", created_by: owner.id })
      .select("id")
      .single();
    if (error || !bundle) throw new Error(`could not seed a bundle: ${error?.message}`);
    const target = (bundle as { id: string }).id;
    await service.from("documents").update({ bundle_id: target }).eq("id", mine.documentId);
    await service.from("document_chunks").update({ bundle_id: target }).eq("id", moving);

    expect(await changesFor(moving)).toEqual([{ chunk_id: moving, bundle_id: target }]);
  });

  it("is read by no client", async () => {
    const { data, error } = await owner.db.from("passage_vector_changes").select("chunk_id");
    expect(error !== null || (data ?? []).length === 0).toBe(true);
  });
});
