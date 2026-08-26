/**
 * The role that only reads.
 *
 * Until 0021 no policy on a shared table looked at `role` at all, so a plain
 * member could delete any agent in the workspace — and the Team screen said
 * `member` was the role that could not change things. This file is the line
 * that claim now has behind it.
 *
 * Both halves matter equally, and the second is the one that would go wrong
 * quietly. A viewer must be stopped from changing the workspace's shared
 * things; a viewer must NOT be stopped from using them, because a viewer who
 * cannot chat is a login with nothing behind it. A migration that tightened one
 * table too many would leave every test in the first half passing.
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
let member: TestUser;
let seeded: Seeded;

beforeAll(async () => {
  owner = await createTestUser("viewer-owner");
  viewer = await createTestUser("viewer-viewer");
  member = await createTestUser("viewer-member");

  seeded = await seedWorkspace(owner, "shared");

  // workspace_members has no INSERT policy — joining goes through
  // accept_invitation, which bypasses RLS. Same here.
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert([
      { workspace_id: owner.workspaceId, user_id: viewer.id, role: "viewer" },
      { workspace_id: owner.workspaceId, user_id: member.id, role: "member" },
    ]);
  if (error) throw new Error(`could not seed the memberships: ${error.message}`);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

/** Did the row survive? Asked as the service role, so RLS cannot mask it. */
async function stillThere(table: string, id: string): Promise<boolean> {
  const { data } = await serviceClient().from(table).select("id").eq("id", id);
  return (data ?? []).length > 0;
}

describe("a viewer reads the workspace", () => {
  it("sees the agents, the knowledge and the documents", async () => {
    // The point of the role. If this fails, a viewer has been locked out of the
    // product rather than restricted within it.
    for (const [table, id] of [
      ["agents", seeded.agentId],
      ["knowledge_bundles", seeded.bundleId],
      ["documents", seeded.documentId],
      ["workspaces", owner.workspaceId],
    ] as const) {
      const { data } = await viewer.db.from(table).select("id").eq("id", id);
      expect((data ?? []).length, `a viewer cannot see ${table}`).toBe(1);
    }
  });
});

describe("a viewer changes nothing the workspace shares", () => {
  it("cannot create an agent", async () => {
    const { data } = await viewer.db
      .from("agents")
      .insert({ workspace_id: owner.workspaceId, name: "Viewer's agent", created_by: viewer.id })
      .select("id");
    expect(data ?? []).toEqual([]);
  });

  it("cannot rename or delete one", async () => {
    await viewer.db.from("agents").update({ name: "Renamed" }).eq("id", seeded.agentId);
    await viewer.db.from("agents").delete().eq("id", seeded.agentId);

    expect(await stillThere("agents", seeded.agentId), "a viewer deleted an agent").toBe(true);
    const { data } = await serviceClient()
      .from("agents")
      .select("name")
      .eq("id", seeded.agentId)
      .single();
    expect(data?.name, "a viewer renamed an agent").not.toBe("Renamed");
  });

  it("cannot delete a knowledge bundle or a document", async () => {
    await viewer.db.from("documents").delete().eq("id", seeded.documentId);
    await viewer.db.from("knowledge_bundles").delete().eq("id", seeded.bundleId);

    expect(await stillThere("documents", seeded.documentId)).toBe(true);
    expect(await stillThere("knowledge_bundles", seeded.bundleId)).toBe(true);
  });

  it("cannot delete a document", async () => {
    const { error } = await viewer.db
      .from("documents")
      .delete()
      .eq("id", seeded.documentId)
      .select("id");

    // RLS refuses by matching nothing, which is why the route has to read the
    // deleted rows back rather than trusting the absence of an error.
    expect(error).toBeNull();

    const { data } = await serviceClient().from("documents").select("id").eq("id", seeded.documentId);
    expect(data).toHaveLength(1);
  });

  it("cannot attach knowledge to an agent", async () => {
    // Changing what an agent knows without editing its row — the case that is
    // easy to miss, because it is a write to a join table rather than to
    // anything that looks like the agent.
    const { data } = await viewer.db
      .from("agent_bundles")
      .insert({ agent_id: seeded.agentId, bundle_id: seeded.bundleId })
      .select("agent_id");
    expect(data ?? []).toEqual([]);
  });
});

describe("a member still builds", () => {
  // The other half of the fix. Making `member` read-only would also have made
  // the Team screen true, and would have been the wrong answer: this is a
  // product about a team training one agent together.
  it("creates and deletes an agent of their own", async () => {
    const { data: made, error } = await member.db
      .from("agents")
      .insert({ workspace_id: owner.workspaceId, name: "Member's agent", created_by: member.id })
      .select("id")
      .single();

    expect(error, "a member can no longer build").toBeNull();

    await member.db.from("agents").delete().eq("id", made.id);
    expect(await stillThere("agents", made.id)).toBe(false);
  });

  it("attaches knowledge to an agent", async () => {
    const { error } = await member.db
      .from("agent_bundles")
      .insert({ agent_id: seeded.agentId, bundle_id: seeded.bundleId });
    expect(error).toBeNull();
  });
});

describe("a viewer still uses what is there", () => {
  it("chats with an agent, and the conversation is theirs", async () => {
    // The whole reason `viewer` writes to nothing SHARED rather than to nothing
    // at all. A session, a message and an idea are keyed to the person, not to
    // their role, and none of them is touched by 0021.
    const { data: session, error: sessionError } = await viewer.db
      .from("chat_sessions")
      .insert({
        agent_id: seeded.agentId,
        user_id: viewer.id,
        workspace_id: owner.workspaceId,
        visibility: "private",
        title: "A viewer's question",
      })
      .select("id")
      .single();
    expect(sessionError, "a viewer cannot start a conversation").toBeNull();

    const { error: messageError } = await viewer.db.from("messages").insert({
      session_id: session.id,
      sender_id: viewer.id,
      role: "user",
      content: "What did we decide about the roadmap?",
    });
    expect(messageError, "a viewer cannot speak in their own session").toBeNull();

    const { error: ideaError } = await viewer.db.from("ideas").insert({
      session_id: session.id,
      workspace_id: owner.workspaceId,
      title: "A viewer's idea",
      created_by: viewer.id,
    });
    expect(ideaError, "a viewer cannot record an idea").toBeNull();
  });
});

/**
 * ideas_update_session_visible specified only USING, which Postgres reuses as
 * the WITH CHECK — undoing the INSERT policy's created_by = auth.uid() pin.
 * Neither the update nor the delete policy called can_write_in_workspace, so
 * unlike every other shared table 0021 touched, a viewer could edit and delete
 * someone else's card. seeded.sessionId is the 'shared' session seedWorkspace
 * built for `owner`, so both viewer and member can see it.
 */
describe("ideas: your own card is yours to change, not anyone's", () => {
  it("cannot delete another member's idea card", async () => {
    const { data: card } = await owner.db
      .from("ideas")
      .insert({
        session_id: seeded.sessionId,
        workspace_id: owner.workspaceId,
        title: "owner's card",
        created_by: owner.id,
      })
      .select("id")
      .single();

    await viewer.db.from("ideas").delete().eq("id", card!.id);

    // Read back through the service role, so RLS masking the row cannot be
    // mistaken for the row having been deleted.
    const { data } = await serviceClient().from("ideas").select("id").eq("id", card!.id);
    expect(data).toHaveLength(1);
  });

  it("cannot reattribute a card to somebody else", async () => {
    const { data: card } = await member.db
      .from("ideas")
      .insert({
        session_id: seeded.sessionId,
        workspace_id: owner.workspaceId,
        title: "mine",
        created_by: member.id,
      })
      .select("id")
      .single();

    await member.db.from("ideas").update({ created_by: owner.id }).eq("id", card!.id);

    const { data } = await serviceClient()
      .from("ideas")
      .select("created_by")
      .eq("id", card!.id)
      .single();
    expect(data!.created_by).toBe(member.id);
  });
});
