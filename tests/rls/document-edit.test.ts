/**
 * The question an agent's edit asks before it writes (`worker/src/lib/docs/edit.ts`).
 *
 * The edit writes `r2_key`, `size` and `content` with the service role, because
 * 0085 grants those columns to no client. What keeps that write scoped is the
 * question asked first, through the caller's own client: update the row's
 * `name` to itself and see whether the row comes back. That only works if the
 * documents update policy answers it the way the edit reads it — the row for
 * somebody who may change the document, nothing for everybody else — and if
 * the columns really are closed to clients, or the service role would not be
 * needed at all. Neither is visible from the worker, so both are pinned here.
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
let member: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let seeded: Seeded;
let privateDocId: string;

beforeAll(async () => {
  owner = await createTestUser("edit-owner");
  member = await createTestUser("edit-member");
  viewer = await createTestUser("edit-viewer");
  outsider = await createTestUser("edit-outsider");
  seeded = await seedWorkspace(owner);

  const { error: memberErr } = await serviceClient()
    .from("workspace_members")
    .insert([
      { workspace_id: owner.workspaceId, user_id: member.id, role: "member" },
      { workspace_id: owner.workspaceId, user_id: viewer.id, role: "viewer" },
    ]);
  if (memberErr) throw new Error(`could not seed the memberships: ${memberErr.message}`);

  // The owner's own folder, which nobody else in the workspace may write to.
  const { data: bundle, error: bundleErr } = await owner.db
    .from("knowledge_bundles")
    .insert({
      workspace_id: owner.workspaceId,
      name: "Only mine",
      created_by: owner.id,
      scope: "owner",
    })
    .select("id")
    .single();
  if (bundleErr || !bundle) throw new Error(`could not seed the bundle: ${bundleErr?.message}`);
  const { data: doc, error: docErr } = await owner.db
    .from("documents")
    .insert({ bundle_id: bundle.id, name: "Private notes.md", size: 5, content: "notes" })
    .select("id")
    .single();
  if (docErr || !doc) throw new Error(`could not seed the document: ${docErr?.message}`);
  privateDocId = doc.id as string;
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

/** The edit's probe, exactly as it is sent. */
async function probe(user: TestUser, id: string, name: string) {
  return user.db.from("documents").update({ name }).eq("id", id).select("id").maybeSingle();
}

async function nameOf(id: string): Promise<string> {
  const { data } = await serviceClient().from("documents").select("name").eq("id", id).single();
  return data?.name as string;
}

describe("the edit's permission probe", () => {
  it("answers with the row for somebody who may change the document", async () => {
    const name = await nameOf(seeded.documentId);
    const { data, error } = await probe(owner, seeded.documentId, name);
    expect(error).toBeNull();
    expect(data?.id).toBe(seeded.documentId);

    const asMember = await probe(member, seeded.documentId, name);
    expect(asMember.data?.id, "a member could not change a shared document").toBe(
      seeded.documentId,
    );
  });

  it("answers with nothing for a viewer, an outsider, and a member on somebody's own folder", async () => {
    const shared = await nameOf(seeded.documentId);
    expect((await probe(viewer, seeded.documentId, shared)).data).toBeNull();
    expect((await probe(outsider, seeded.documentId, shared)).data).toBeNull();

    const mine = await nameOf(privateDocId);
    expect((await probe(member, privateDocId, mine)).data).toBeNull();
    expect((await probe(owner, privateDocId, mine)).data?.id).toBe(privateDocId);
  });

  it("changes nothing, because it writes the name the row already has", async () => {
    const before = await nameOf(seeded.documentId);
    await probe(owner, seeded.documentId, before);
    expect(await nameOf(seeded.documentId)).toBe(before);
  });
});

describe("the columns the edit writes with the service role", () => {
  it("are closed to the document's own writer", async () => {
    const { error } = await owner.db
      .from("documents")
      .update({ content: "rewritten by a client" })
      .eq("id", seeded.documentId);
    expect(error?.code, "a client wrote documents.content directly").toBe("42501");
  });
});
