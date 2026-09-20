/**
 * What the database says about where a routine files its output.
 *
 * 0056 added `routines.output_bundle_id`, and the executor writes a document
 * into whatever bundle that column names — with the SERVICE ROLE, which
 * bypasses row level security entirely. So the column is only as safe as the
 * policy that decides what may be written into it, and a policy is only
 * provable here.
 *
 * The attack it closes is one request. `authenticated` holds a table-level
 * UPDATE on `routines` from 0023 with no column list, and the anon key ships in
 * the browser bundle: point your own routine's output at a bundle id belonging
 * to a workspace you are not in, wait for the next run, and your agent's
 * summary — text you wrote the instruction for — becomes a document in their
 * knowledge base, where their agents retrieve it and quote it back to them as
 * their own material. 0027 learned this lesson about `source_config`; this is
 * the same lesson about a different column.
 *
 * The rest is what a person would predict and the schema has to agree with:
 * deleting a routine must not delete the year of digests it wrote, and a
 * colleague may read a document a private routine filed without being told
 * which routine that was.
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
let outsider: TestUser;
let mine: Seeded;
let theirs: Seeded;

beforeAll(async () => {
  owner = await createTestUser("filing-owner");
  colleague = await createTestUser("filing-colleague");
  outsider = await createTestUser("filing-outsider");

  mine = await seedWorkspace(owner, "private");
  // A different person in a different workspace, with a bundle of their own.
  theirs = await seedWorkspace(outsider, "private");

  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: owner.workspaceId, user_id: colleague.id, role: "member" });
  if (error) throw new Error(`could not add the colleague: ${error.message}`);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("which bundle a routine may file into", () => {
  it("accepts one in the routine's own workspace", async () => {
    const { error } = await owner.db
      .from("routines")
      .update({ output_bundle_id: mine.bundleId })
      .eq("id", mine.routineId);

    expect(error).toBeNull();
  });

  // THE CROSS-TENANT WRITE. Everything else in this file is housekeeping.
  it("refuses one in a workspace the caller is not in", async () => {
    const { error } = await owner.db
      .from("routines")
      .update({ output_bundle_id: theirs.bundleId })
      .eq("id", mine.routineId);

    expect(error?.code).toBe("42501");

    // And the row is unchanged, rather than changed and then hidden.
    const { data } = await serviceClient()
      .from("routines")
      .select("output_bundle_id")
      .eq("id", mine.routineId)
      .single();
    expect(data?.output_bundle_id).toBe(mine.bundleId);
  });

  it("refuses one at creation too, not only on update", async () => {
    const { error } = await owner.db.from("routines").insert({
      workspace_id: owner.workspaceId,
      agent_id: mine.agentId,
      user_id: owner.id,
      name: "Files somewhere it should not",
      source_kind: "none",
      source_config: {},
      instruction: "summarise",
      delivery_channel_id: mine.channelId,
      schedule_cron: "0 9 * * *",
      output_bundle_id: theirs.bundleId,
    });

    expect(error?.code).toBe("42501");
  });

  it("lets the owner turn filing off again", async () => {
    const { error } = await owner.db
      .from("routines")
      .update({ output_bundle_id: null })
      .eq("id", mine.routineId);

    expect(error).toBeNull();
  });

  // 0027's trigger froze `source_config` and `source_kind` after creation. This
  // column is deliberately not frozen: moving a routine's output to a different
  // bundle is an ordinary thing to want, and the WITH CHECK is what keeps it
  // safe rather than immutability.
  it("can be changed more than once", async () => {
    const second = await seedWorkspace(owner, "private");

    await owner.db
      .from("routines")
      .update({ output_bundle_id: mine.bundleId })
      .eq("id", mine.routineId);
    const { error } = await owner.db
      .from("routines")
      .update({ output_bundle_id: second.bundleId })
      .eq("id", mine.routineId);

    expect(error).toBeNull();
  });
});

describe("how many documents a routine keeps", () => {
  it("refuses a retention of zero, which would prune everything it just wrote", async () => {
    const { error } = await owner.db
      .from("routines")
      .update({ output_retention: 0 })
      .eq("id", mine.routineId);

    expect(error?.code).toBe("23514");
  });

  it("refuses one past ten years of weekly", async () => {
    const { error } = await owner.db
      .from("routines")
      .update({ output_retention: 521 })
      .eq("id", mine.routineId);

    expect(error?.code).toBe("23514");
  });

  it("accepts both ends of the range", async () => {
    for (const n of [1, 520]) {
      const { error } = await owner.db
        .from("routines")
        .update({ output_retention: n })
        .eq("id", mine.routineId);
      expect(error, `retention ${n}`).toBeNull();
    }
  });

  it("defaults to a year of weekly", async () => {
    const { data } = await serviceClient()
      .from("routines")
      .select("output_retention")
      .eq("id", theirs.routineId)
      .single();

    expect(data?.output_retention).toBe(52);
  });
});

describe("what a filed document survives", () => {
  /** Files a document the way the executor does: service role, routine_id set. */
  async function fileOne(routineId: string, bundleId: string, name: string): Promise<string> {
    const { data, error } = await serviceClient()
      .from("documents")
      .insert({ bundle_id: bundleId, routine_id: routineId, name, size: 10, r2_key: `k/${name}` })
      .select("id")
      .single();
    if (error) throw new Error(`filing failed: ${error.message}`);
    return data.id as string;
  }

  it("outlives the routine that wrote it", async () => {
    const throwaway = await seedWorkspace(owner, "private");
    const documentId = await fileOne(throwaway.routineId, throwaway.bundleId, "digest.md");

    await serviceClient().from("routines").delete().eq("id", throwaway.routineId);

    // `set null`, not `cascade`, and it is a product decision rather than a
    // schema one: deleting a routine must not delete the year of digests it
    // wrote. They stay, become ordinary documents, and stop being added to.
    const { data } = await serviceClient()
      .from("documents")
      .select("id, routine_id")
      .eq("id", documentId)
      .single();

    expect(data).toMatchObject({ id: documentId, routine_id: null });
  });

  it("leaves the run that produced it readable after it is deleted", async () => {
    const throwaway = await seedWorkspace(owner, "private");
    const documentId = await fileOne(throwaway.routineId, throwaway.bundleId, "gone.md");

    const { error: runError } = await serviceClient().from("routine_runs").insert({
      routine_id: throwaway.routineId,
      status: "ok",
      items_new: 3,
      document_id: documentId,
    });
    expect(runError).toBeNull();

    await serviceClient().from("documents").delete().eq("id", documentId);

    const { data } = await serviceClient()
      .from("routine_runs")
      .select("status, items_new, document_id")
      .eq("routine_id", throwaway.routineId)
      .single();

    // A run row pointing at a deleted document would be worse than one that
    // says nothing.
    expect(data).toMatchObject({ status: "ok", items_new: 3, document_id: null });
  });
});

describe("what a colleague can see about a filed document", () => {
  it("reads the document but not the private routine behind it", async () => {
    const shared = await seedWorkspace(owner, "shared");
    // The routine stays private; only the bundle is reachable by the workspace.
    await serviceClient()
      .from("routines")
      .update({ visibility: "private" })
      .eq("id", shared.routineId);

    const { error: fileError } = await serviceClient().from("documents").insert({
      bundle_id: shared.bundleId,
      routine_id: shared.routineId,
      name: "Weekly digest.md",
      size: 10,
      r2_key: "k/weekly",
    });
    expect(fileError).toBeNull();

    const { data, error } = await colleague.db
      .from("documents")
      .select("name, routine_id, routines(name)")
      .eq("bundle_id", shared.bundleId)
      .eq("name", "Weekly digest.md")
      .single();

    expect(error).toBeNull();
    // The document is theirs to read — it is in a bundle in their workspace.
    expect(data?.name).toBe("Weekly digest.md");
    expect(data?.routine_id).toBe(shared.routineId);
    // The routine is not theirs to see, so the embed resolves to nothing and
    // the interface says "a routine" rather than naming one. A null name beside
    // a real id is the expected combination, not a bug.
    expect(data?.routines).toBeNull();
  });
});
