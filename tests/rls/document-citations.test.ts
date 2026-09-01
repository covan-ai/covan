/**
 * Counting the answers that stand on a document, across conversations the
 * counter cannot read.
 *
 * This is the one place in the product where a member learns something from a
 * private session, and the whole design is in what does and does not come back:
 * a number per document, and nothing else. So these tests are as much about the
 * ceiling as the floor — the count has to cross a colleague's private chat
 * (or it answers a personal question rather than a team one), and it has to
 * stop there.
 *
 * `security definer` turns RLS off inside the function body. It does not make
 * the caller somebody else, so `auth.uid()` is still them and the membership
 * check still means something — which is what the non-member cases here are
 * for. A definer function that forgot its own check would pass every other test
 * in this file.
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
let seeded: Seeded;
let secondDocumentId: string;

/** A reply in `user`'s own private session, citing the given documents. */
async function replyCiting(user: TestUser, documentIds: string[]) {
  const { data: session, error: sessionErr } = await user.db
    .from("chat_sessions")
    .insert({
      agent_id: seeded.agentId,
      user_id: user.id,
      workspace_id: user.workspaceId,
      visibility: "private",
    })
    .select("id")
    .single();
  if (sessionErr || !session) throw new Error(`could not seed a session: ${sessionErr?.message}`);

  // The session is the user's own, inserted as them. The reply is not: 0031
  // pins a user's insert to `role = 'user'`, so an assistant message is
  // written by the service role — which is exactly how the chat route writes
  // one, and the only rows this count ever looks at.
  const { error } = await serviceClient()
    .from("messages")
    .insert({
      session_id: session.id,
      role: "assistant",
      content: "An answer.",
      sources: documentIds.map((id) => ({ id, name: "seeded.txt" })),
    });
  if (error) throw new Error(`could not seed a message: ${error.message}`);
}

beforeAll(async () => {
  owner = await createTestUser("citations-owner");
  colleague = await createTestUser("citations-colleague");
  outsider = await createTestUser("citations-outsider");
  seeded = await seedWorkspace(owner);

  const { error: memberErr } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: owner.workspaceId, user_id: colleague.id, role: "member" });
  if (memberErr) throw new Error(`could not seed the membership: ${memberErr.message}`);

  const { data: doc, error: docErr } = await owner.db
    .from("documents")
    .insert({ bundle_id: seeded.bundleId, name: "second.txt" })
    .select("id")
    .single();
  if (docErr || !doc) throw new Error(`could not seed a second document: ${docErr?.message}`);
  secondDocumentId = doc.id as string;

  // Two replies on the seeded document, one of them in the colleague's own
  // private session; one reply on the second document.
  await replyCiting(owner, [seeded.documentId]);
  await replyCiting(colleague, [seeded.documentId]);
  await replyCiting(owner, [secondDocumentId]);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

async function counts(user: TestUser, bundleIds: string[] = [seeded.bundleId]) {
  const { data, error } = await user.db.rpc("document_citation_counts", {
    p_bundle_ids: bundleIds,
  });
  return {
    error,
    map: Object.fromEntries(
      ((data ?? []) as Array<{ document_id: string; citations: number }>).map((r) => [
        r.document_id,
        Number(r.citations),
      ]),
    ),
  };
}

describe("document_citation_counts", () => {
  it("counts a colleague's private conversation, which is the whole point", async () => {
    // The owner cannot read the colleague's session at all. If the count did
    // not cross it this would be 1, and the number would mean "answers I have
    // seen" rather than "answers this team has had".
    const { error, map } = await counts(owner);
    expect(error).toBeNull();
    expect(map[seeded.documentId]).toBe(2);
  });

  it("gives the colleague the same answer as the owner", async () => {
    // A ranking that differs by who is looking is not a ranking of documents.
    const { map } = await counts(colleague);
    expect(map[seeded.documentId]).toBe(2);
  });

  it("still cannot read the session behind the number", async () => {
    // The ceiling. The count crosses; nothing else does.
    const { data } = await owner.db.from("chat_sessions").select("id").eq("user_id", colleague.id);
    expect(data ?? []).toEqual([]);
  });

  it("counts each document separately", async () => {
    const { map } = await counts(owner);
    expect(map[secondDocumentId]).toBe(1);
  });

  it("leaves an uncited document out rather than reporting a zero", async () => {
    const { data: doc } = await owner.db
      .from("documents")
      .insert({ bundle_id: seeded.bundleId, name: "nobody-asks.txt" })
      .select("id")
      .single();
    const { map } = await counts(owner);
    expect(map[doc!.id as string]).toBeUndefined();
  });

  it("tells a non-member nothing", async () => {
    // The membership check inside the function. `security definer` has already
    // turned RLS off by the time it runs, so this is the only thing standing
    // between an outsider and a workspace's numbers.
    const { error, map } = await counts(outsider);
    expect(error).toBeNull();
    expect(map).toEqual({});
  });

  it("ignores a bundle the caller is not in, while answering for one they are", async () => {
    // A caller who names both their own bundle and somebody else's gets their
    // own answer and no hint about the other.
    const { data: bundle } = await outsider.db
      .from("knowledge_bundles")
      .insert({ workspace_id: outsider.workspaceId, name: "Not yours", created_by: outsider.id })
      .select("id")
      .single();
    const { map } = await counts(owner, [seeded.bundleId, bundle!.id as string]);
    expect(map[seeded.documentId]).toBe(2);
    expect(Object.keys(map)).toHaveLength(2);
  });

  it("does not count a citation that carries a name and no id", async () => {
    // Every reply written before #54 looks like this. They are uncountable
    // rather than zero, which is what the window caption exists to say.
    const { data: doc } = await owner.db
      .from("documents")
      .insert({ bundle_id: seeded.bundleId, name: "cited-by-name-only.txt" })
      .select("id")
      .single();

    const { data: session } = await owner.db
      .from("chat_sessions")
      .insert({
        agent_id: seeded.agentId,
        user_id: owner.id,
        workspace_id: owner.workspaceId,
        visibility: "private",
      })
      .select("id")
      .single();
    await serviceClient()
      .from("messages")
      .insert({
        session_id: session!.id,
        role: "assistant",
        content: "An older answer.",
        sources: [{ name: "cited-by-name-only.txt" }],
      });

    const { map } = await counts(owner);
    expect(map[doc!.id as string]).toBeUndefined();
  });
});

describe("citations_counted_since", () => {
  it("reports the oldest reply that could be counted", async () => {
    const { data, error } = await owner.db.rpc("citations_counted_since", {
      p_workspace_id: owner.workspaceId,
    });
    expect(error).toBeNull();
    expect(typeof data).toBe("string");
    expect(Number.isNaN(Date.parse(data as string))).toBe(false);
  });

  it("tells a non-member nothing", async () => {
    const { data, error } = await outsider.db.rpc("citations_counted_since", {
      p_workspace_id: owner.workspaceId,
    });
    expect(error).toBeNull();
    expect(data).toBeNull();
  });

  it("is null for a workspace whose replies carry no ids", async () => {
    // The screen this distinguishes: "nothing has been countable yet" is not
    // "every document scored zero".
    const { data } = await outsider.db.rpc("citations_counted_since", {
      p_workspace_id: outsider.workspaceId,
    });
    expect(data).toBeNull();
  });
});
