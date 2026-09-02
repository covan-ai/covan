/**
 * Deletion that can be taken back, and the record of who took it.
 *
 * Every claim 0037 makes is a claim about policies, so this is where it has to
 * be proved — against a real database, through PostgREST, with the anon key a
 * browser actually carries. The API is not in the path of any of it, which is
 * the point: soft deletion opens a window that only the policies can close, and
 * an `.is("deleted_at", null)` in a route would prove nothing about what
 * somebody typing into `curl` can read.
 *
 * The one that would go wrong quietly is `document_chunks`. A deleted document
 * disappears from every list the moment its row is marked, so the feature looks
 * finished — while the chunks still hold the document's text and their policy
 * asks only about workspace membership. That is a whole file's contents left
 * readable behind a deletion somebody believes happened.
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
let outsider: TestUser;
let seeded: Seeded;

beforeAll(async () => {
  owner = await createTestUser("del-owner");
  viewer = await createTestUser("del-viewer");
  outsider = await createTestUser("del-outsider");

  seeded = await seedWorkspace(owner, "shared");

  const { error } = await serviceClient()
    .from("workspace_members")
    .insert([{ workspace_id: owner.workspaceId, user_id: viewer.id, role: "viewer" }]);
  if (error) throw new Error(`could not seed the viewer membership: ${error.message}`);

  // A chunk carrying the document's words, so the leak has something to leak.
  // Written with the service role: the app writes chunks through the caller's
  // client, but the embedding column wants a vector and this test does not care
  // about retrieval quality, only about who can read the text.
  const { error: chunkError } = await serviceClient().from("document_chunks").insert({
    document_id: seeded.documentId,
    bundle_id: seeded.bundleId,
    workspace_id: owner.workspaceId,
    chunk_index: 0,
    content: "the secret sentence inside the deleted document",
  });
  if (chunkError) throw new Error(`could not seed a chunk: ${chunkError.message}`);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

/** Asked as the service role, so RLS cannot mask the answer. */
async function rawRow(table: string, id: string) {
  const { data } = await serviceClient().from(table).select("*").eq("id", id).maybeSingle();
  return data as Record<string, unknown> | null;
}

/** Undo whatever a test did, so the next one starts from a live workspace. */
async function undelete() {
  const service = serviceClient();
  for (const table of ["agents", "knowledge_bundles", "documents", "chat_sessions", "routines"]) {
    await service
      .from(table)
      .update({ deleted_at: null, deleted_via: null })
      .eq("workspace_id", owner.workspaceId);
  }
  // documents has no workspace_id — it reaches one through its bundle.
  await service
    .from("documents")
    .update({ deleted_at: null, deleted_via: null })
    .eq("bundle_id", seeded.bundleId);
  await service.from("workspace_events").delete().eq("workspace_id", owner.workspaceId);
}

describe("a deleted agent stops existing for everybody", () => {
  afterAll(undelete);

  it("is hidden from the person who deleted it, not just from a viewer", async () => {
    const { error } = await owner.db.rpc("soft_delete_agent", { p_agent_id: seeded.agentId });
    expect(error).toBeNull();

    const { data } = await owner.db.from("agents").select("id").eq("id", seeded.agentId);
    expect(data ?? []).toHaveLength(0);

    // Hidden, not destroyed — which is the entire promise.
    expect(await rawRow("agents", seeded.agentId)).not.toBeNull();
  });

  it("takes its sessions, messages and ideas with it", async () => {
    const asOwner = owner.db;

    const { data: sessions } = await asOwner
      .from("chat_sessions")
      .select("id")
      .eq("id", seeded.sessionId);
    expect(sessions ?? []).toHaveLength(0);

    // The session was shared, so this is not "private things stay private" —
    // it is the parent's deletion reaching through session_is_visible.
    const { data: messages } = await asOwner
      .from("messages")
      .select("id")
      .eq("id", seeded.messageId);
    expect(messages ?? []).toHaveLength(0);

    const { data: ideas } = await asOwner.from("ideas").select("id").eq("id", seeded.ideaId);
    expect(ideas ?? []).toHaveLength(0);
  });

  it("marks exactly what it hid, so a restore knows what to bring back", async () => {
    const session = await rawRow("chat_sessions", seeded.sessionId);
    expect(session?.deleted_via).toBe(seeded.agentId);

    const routine = await rawRow("routines", seeded.routineId);
    expect(routine?.deleted_via).toBe(seeded.agentId);
  });

  it("comes back whole", async () => {
    const { error } = await owner.db.rpc("restore_agent", { p_agent_id: seeded.agentId });
    expect(error).toBeNull();

    const { data: agents } = await owner.db.from("agents").select("id").eq("id", seeded.agentId);
    expect(agents ?? []).toHaveLength(1);

    const { data: messages } = await owner.db
      .from("messages")
      .select("id")
      .eq("id", seeded.messageId);
    expect(messages ?? []).toHaveLength(1);
  });
});

describe("a deleted document takes its words with it", () => {
  afterAll(undelete);

  it("hides the chunks, not just the document row", async () => {
    await owner.db.rpc("soft_delete_document", { p_document_id: seeded.documentId });

    const { data: docs } = await owner.db
      .from("documents")
      .select("id")
      .eq("id", seeded.documentId);
    expect(docs ?? []).toHaveLength(0);

    // The leak. A member reading document_chunks directly through PostgREST is
    // the shortest path to a deleted file's contents, and dc_select_member used
    // to ask only whether they were in the workspace.
    const { data: chunks } = await owner.db
      .from("document_chunks")
      .select("content")
      .eq("document_id", seeded.documentId);
    expect(chunks ?? []).toHaveLength(0);
  });

  it("is refused to a viewer as firmly as to anybody else", async () => {
    const { data } = await viewer.db
      .from("document_chunks")
      .select("content")
      .eq("document_id", seeded.documentId);
    expect(data ?? []).toHaveLength(0);
  });

  it("stops grounding answers", async () => {
    // match_chunks is security invoker, so this runs under the caller's own
    // policies — but it is asserted separately because the RPC is what people
    // read when they ask what the agent can still see.
    const { data, error } = await owner.db.rpc("match_chunks", {
      p_agent_id: seeded.agentId,
      p_query_embedding: new Array(1536).fill(0),
      p_match_count: 10,
      p_min_similarity: 0,
    });
    expect(error).toBeNull();
    const hits = (data ?? []) as { document_id: string }[];
    expect(hits.some((h) => h.document_id === seeded.documentId)).toBe(false);
  });
});

describe("restoring brings back exactly what went", () => {
  afterAll(undelete);

  it("leaves a separately-deleted document deleted when its bundle returns", async () => {
    // Delete the document on its own first, then the bundle around it. The
    // document now carries `deleted_via = null` — it was its own decision — so
    // restoring the bundle must not undo it.
    await owner.db.rpc("soft_delete_document", { p_document_id: seeded.documentId });
    await owner.db.rpc("soft_delete_bundle", { p_bundle_id: seeded.bundleId });

    await owner.db.rpc("restore_bundle", { p_bundle_id: seeded.bundleId });

    const { data: bundles } = await owner.db
      .from("knowledge_bundles")
      .select("id")
      .eq("id", seeded.bundleId);
    expect(bundles ?? []).toHaveLength(1);

    const { data: docs } = await owner.db
      .from("documents")
      .select("id")
      .eq("id", seeded.documentId);
    expect(docs ?? []).toHaveLength(0);
  });

  it("refuses a document whose bundle is still deleted, and says which to press", async () => {
    await owner.db.rpc("soft_delete_bundle", { p_bundle_id: seeded.bundleId });

    const { error } = await owner.db.rpc("restore_document", {
      p_document_id: seeded.documentId,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/restore the bundle/i);
  });
});

describe("who may delete", () => {
  afterAll(undelete);

  it("refuses a viewer", async () => {
    const { error } = await viewer.db.rpc("soft_delete_agent", { p_agent_id: seeded.agentId });
    expect(error?.code).toBe("42501");
    expect(await rawRow("agents", seeded.agentId)).toMatchObject({ deleted_at: null });
  });

  it("refuses somebody who is not in the workspace at all", async () => {
    const { error } = await outsider.db.rpc("soft_delete_agent", { p_agent_id: seeded.agentId });
    // P0002 rather than 42501: the row is not visible to resolve, so the
    // function cannot get as far as asking about permission. Either refusal is
    // correct; what matters is that nothing was marked.
    expect(error).not.toBeNull();
    expect(await rawRow("agents", seeded.agentId)).toMatchObject({ deleted_at: null });
  });

  it("refuses a viewer the trash as an error, not as an empty list", async () => {
    const { error } = await viewer.db.rpc("workspace_trash", {
      p_workspace_id: owner.workspaceId,
    });
    expect(error?.code).toBe("42501");
  });
});

describe("the trash lists decisions, not consequences", () => {
  afterAll(undelete);

  it("shows one row for a bundle, whatever it contained", async () => {
    await owner.db.rpc("soft_delete_bundle", { p_bundle_id: seeded.bundleId });

    const { data, error } = await owner.db.rpc("workspace_trash", {
      p_workspace_id: owner.workspaceId,
    });
    expect(error).toBeNull();

    const rows = (data ?? []) as { kind: string; id: string; deleted_by_name: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "bundle", id: seeded.bundleId });
    expect(rows[0].deleted_by_name).not.toBeNull();
  });
});

describe("the audit log", () => {
  afterAll(undelete);

  it("records one event for a bundle and none for its documents", async () => {
    await owner.db.rpc("soft_delete_bundle", { p_bundle_id: seeded.bundleId });

    const { data } = await owner.db
      .from("workspace_events")
      .select("action,subject_type,subject_label")
      .eq("workspace_id", owner.workspaceId);

    const events = (data ?? []) as { action: string }[];
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("bundle.deleted");
  });

  it("keeps the name the thing had, so the row survives the purge", async () => {
    const { data } = await owner.db
      .from("workspace_events")
      .select("subject_label")
      .eq("workspace_id", owner.workspaceId)
      .limit(1);
    expect((data ?? [])[0]?.subject_label).toBe("Seeded bundle");
  });

  it("is invisible to a member who is not an admin", async () => {
    const { data } = await viewer.db
      .from("workspace_events")
      .select("id")
      .eq("workspace_id", owner.workspaceId);
    expect(data ?? []).toHaveLength(0);
  });

  it("cannot be written to, by anybody", async () => {
    // No insert policy exists and the INSERT grant is withheld. Both would have
    // to be added back for this to succeed, which is the second lock.
    const { error } = await owner.db.from("workspace_events").insert({
      workspace_id: owner.workspaceId,
      action: "agent.deleted",
      subject_type: "agent",
      subject_label: "something that never happened",
    });
    expect(error).not.toBeNull();
  });
});

describe("removing somebody is told apart from their leaving", () => {
  it("writes member.removed when an admin does it, and member.left when they do", async () => {
    const service = serviceClient();

    // Two people to spend, because each of these is a one-way door.
    const removed = await createTestUser("del-removed");
    const leaver = await createTestUser("del-leaver");

    await service.from("workspace_members").insert([
      { workspace_id: owner.workspaceId, user_id: removed.id, role: "member" },
      { workspace_id: owner.workspaceId, user_id: leaver.id, role: "member" },
    ]);

    await owner.db
      .from("workspace_members")
      .delete()
      .eq("workspace_id", owner.workspaceId)
      .eq("user_id", removed.id);

    await leaver.db
      .from("workspace_members")
      .delete()
      .eq("workspace_id", owner.workspaceId)
      .eq("user_id", leaver.id);

    const { data } = await owner.db
      .from("workspace_events")
      .select("action,subject_id")
      .eq("workspace_id", owner.workspaceId)
      .in("action", ["member.removed", "member.left"]);

    const events = (data ?? []) as { action: string; subject_id: string }[];
    expect(events.find((e) => e.subject_id === removed.id)?.action).toBe("member.removed");
    expect(events.find((e) => e.subject_id === leaver.id)?.action).toBe("member.left");
  });
});
