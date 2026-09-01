/**
 * Who uploaded a document, and who cannot claim somebody else did.
 *
 * `documents.created_by` (0037) exists so an erasure request has something to
 * find. That makes it different from the other `created_by` columns, which are
 * decoration: this one will be read to decide what gets deleted, so a wrong
 * value is worse than no value — it either reaches a colleague's documents or
 * misses the asker's.
 *
 * Nothing in the API sends the column. The default is `auth.uid()` and the
 * upload route inserts through the caller's own client, so the honest path
 * cannot get it wrong by forgetting. These tests are about the dishonest one:
 * the Data API is reachable directly, and a hand-written insert or update can
 * name any column it likes.
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
let seeded: Seeded;

beforeAll(async () => {
  owner = await createTestUser("attribution-owner");
  colleague = await createTestUser("attribution-colleague");
  seeded = await seedWorkspace(owner);

  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: owner.workspaceId, user_id: colleague.id, role: "member" });
  if (error) throw new Error(`could not seed the membership: ${error.message}`);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

/** A document inserted the way the upload route inserts one: without the column. */
async function upload(user: TestUser, name: string) {
  const { data, error } = await user.db
    .from("documents")
    .insert({ bundle_id: seeded.bundleId, name })
    .select("id,created_by")
    .single();
  return { data, error };
}

describe("documents.created_by", () => {
  it("records the uploader without being told to", async () => {
    const { data, error } = await upload(owner, "the-default-fills-it-in.txt");
    expect(error).toBeNull();
    expect(data?.created_by).toBe(owner.id);
  });

  it("records the colleague when the colleague uploads", async () => {
    // Same bundle, same workspace. Attribution is per upload, not per bundle.
    const { data, error } = await upload(colleague, "not-the-owners.txt");
    expect(error).toBeNull();
    expect(data?.created_by).toBe(colleague.id);
  });

  it("lets an insert say what the default would have said anyway", async () => {
    const { data, error } = await owner.db
      .from("documents")
      .insert({ bundle_id: seeded.bundleId, name: "explicit-and-true.txt", created_by: owner.id })
      .select("created_by")
      .single();
    expect(error).toBeNull();
    expect(data?.created_by).toBe(owner.id);
  });

  it("refuses an upload filed under somebody else's name", async () => {
    // The forgery the policy exists for. Both of these are workspace members
    // with every right to upload here — the question is only whose it is.
    const { error } = await colleague.db
      .from("documents")
      .insert({
        bundle_id: seeded.bundleId,
        name: "filed-under-the-owner.txt",
        created_by: owner.id,
      })
      .select("id")
      .single();
    expect(error).not.toBeNull();
  });

  it("allows an explicit null, which is what the service role writes", async () => {
    const { data, error } = await serviceClient()
      .from("documents")
      .insert({ bundle_id: seeded.bundleId, name: "no-uid-behind-it.txt" })
      .select("created_by")
      .single();
    expect(error).toBeNull();
    expect(data?.created_by).toBeNull();
  });
});

describe("documents.created_by is not editable", () => {
  it("still lets a colleague move somebody else's document", async () => {
    // The reason this is a trigger and not a `with check`. Moving a file
    // between bundles is a workspace-member's right, including for a file
    // they did not upload — and `with check (created_by = auth.uid())` would
    // have refused exactly this while claiming to prevent forgery.
    const { data: doc } = await upload(owner, "the-owners-to-move.txt");
    const { data: bundle, error: bundleErr } = await owner.db
      .from("knowledge_bundles")
      .insert({ workspace_id: owner.workspaceId, name: "Somewhere else", created_by: owner.id })
      .select("id")
      .single();
    if (bundleErr || !bundle)
      throw new Error(`could not seed a second bundle: ${bundleErr?.message}`);

    const { data: moved, error } = await colleague.db
      .from("documents")
      .update({ bundle_id: bundle.id })
      .eq("id", doc!.id)
      .select("bundle_id,created_by")
      .single();

    expect(error).toBeNull();
    expect(moved?.bundle_id).toBe(bundle.id);
    // And it is still the owner's upload afterwards.
    expect(moved?.created_by).toBe(owner.id);
  });

  it("refuses to reassign an upload to somebody else", async () => {
    const { data: doc } = await upload(colleague, "mine-until-i-say-otherwise.txt");
    const { error } = await colleague.db
      .from("documents")
      .update({ created_by: owner.id })
      .eq("id", doc!.id)
      .select("id")
      .single();
    expect(error).not.toBeNull();
  });

  it("refuses to claim somebody else's upload as your own", async () => {
    // The other direction, and the one that would quietly enlarge what an
    // erasure request deletes.
    const { data: doc } = await upload(owner, "not-yours-to-claim.txt");
    const { error } = await colleague.db
      .from("documents")
      .update({ created_by: colleague.id })
      .eq("id", doc!.id)
      .select("id")
      .single();
    expect(error).not.toBeNull();
  });

  it("refuses to erase the attribution", async () => {
    const { data: doc } = await upload(owner, "cannot-be-anonymised.txt");
    const { error } = await owner.db
      .from("documents")
      .update({ created_by: null })
      .eq("id", doc!.id)
      .select("id")
      .single();
    expect(error).not.toBeNull();
  });
});

describe("a document outlives its uploader", () => {
  it("keeps the row and drops the name", async () => {
    // 0016's rule, which this column follows: attribution says who made a
    // thing, not whose it is. A workspace with other people in it keeps the
    // document; only the name goes.
    const leaver = await createTestUser("attribution-leaver");
    const { error: memberErr } = await serviceClient()
      .from("workspace_members")
      .insert({ workspace_id: owner.workspaceId, user_id: leaver.id, role: "member" });
    if (memberErr) throw new Error(`could not seed the membership: ${memberErr.message}`);

    const { data: doc, error: uploadErr } = await upload(leaver, "left-behind.txt");
    expect(uploadErr).toBeNull();
    expect(doc?.created_by).toBe(leaver.id);

    // Their own workspace goes first, by hand. `destroyTestUsers` finds a test
    // user's workspaces through `created_by`, and this test is about that
    // column becoming null — so once the user is gone the workspace would no
    // longer be findable, and it would outlive the run.
    const { error: wsErr } = await serviceClient()
      .from("workspaces")
      .delete()
      .eq("id", leaver.workspaceId);
    expect(wsErr).toBeNull();

    const { error: deleteErr } = await serviceClient().auth.admin.deleteUser(leaver.id);
    expect(deleteErr).toBeNull();

    const { data: after, error } = await owner.db
      .from("documents")
      .select("id,created_by")
      .eq("id", doc!.id)
      .single();
    expect(error).toBeNull();
    expect(after?.id).toBe(doc!.id);
    expect(after?.created_by).toBeNull();
  });
});
