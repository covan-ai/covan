/**
 * The subtler half of tenancy: someone who is legitimately inside the
 * workspace.
 *
 * Cross-tenant leaks are the loud failure, and isolation.test.ts covers them.
 * The quiet one is a policy that treats "member of this workspace" as
 * permission to read everything in it — which would hand Carol every private
 * chat Alice has ever had with an agent. Covan draws the line at
 * `visibility`: agents and knowledge are shared, sessions and routines are
 * private unless their owner marks them shared. This file is that line.
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

let alice: TestUser;
let carol: TestUser;
let priv: Seeded;
let shared: Seeded;

beforeAll(async () => {
  alice = await createTestUser("alice");
  carol = await createTestUser("carol");

  priv = await seedWorkspace(alice, "private");
  shared = await seedWorkspace(alice, "shared");

  // workspace_members has no INSERT policy — joining a workspace goes through
  // the invitation route, which writes with the service-role client. Same here.
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: alice.workspaceId, user_id: carol.id, role: "member" });
  if (error) throw new Error(`could not add carol to the workspace: ${error.message}`);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

async function visible(user: TestUser, table: string, id: string): Promise<boolean> {
  const { data } = await user.db.from(table).select("id").eq("id", id);
  return (data ?? []).length > 0;
}

describe("a fellow workspace member", () => {
  it("sees what the workspace shares", async () => {
    expect(await visible(carol, "agents", priv.agentId)).toBe(true);
    expect(await visible(carol, "knowledge_bundles", priv.bundleId)).toBe(true);
    expect(await visible(carol, "documents", priv.documentId)).toBe(true);
    expect(await visible(carol, "workspaces", alice.workspaceId)).toBe(true);
  });

  it("sees a co-member's profile", async () => {
    // Deliberate: the team page lists names, avatars and email addresses of
    // people you share a workspace with.
    expect(await visible(carol, "profiles", alice.id)).toBe(true);
  });

  it("does not see a private session, or anything hanging off it", async () => {
    expect(await visible(carol, "chat_sessions", priv.sessionId)).toBe(false);
    expect(await visible(carol, "messages", priv.messageId)).toBe(false);
    expect(await visible(carol, "ideas", priv.ideaId)).toBe(false);
  });

  it("does not see a private routine, or its delivery channel", async () => {
    expect(await visible(carol, "routines", priv.routineId)).toBe(false);
    // Delivery channels hold an encrypted secret and stay owner-only even when
    // the routine using them is shared.
    expect(await visible(carol, "delivery_channels", priv.channelId)).toBe(false);
    expect(await visible(carol, "delivery_channels", shared.channelId)).toBe(false);
  });

  it("does see a session and routine their owner marked shared", async () => {
    // The other half of the invariant: if this ever fails, sharing is broken
    // and the tests above would still pass by denying everything.
    expect(await visible(carol, "chat_sessions", shared.sessionId)).toBe(true);
    expect(await visible(carol, "messages", shared.messageId)).toBe(true);
    expect(await visible(carol, "routines", shared.routineId)).toBe(true);
  });

  it("cannot delete a shared session they do not own", async () => {
    // Readable is not writable: the delete policy stays owner-only.
    const { data } = await carol.db
      .from("chat_sessions")
      .delete()
      .eq("id", shared.sessionId)
      .select("id");
    expect(data ?? []).toEqual([]);
    expect(await visible(alice, "chat_sessions", shared.sessionId)).toBe(true);
  });

  it("cannot promote themselves to admin", async () => {
    const { data } = await carol.db
      .from("workspace_members")
      .update({ role: "admin" })
      .eq("workspace_id", alice.workspaceId)
      .eq("user_id", carol.id)
      .select("role");
    expect(data ?? []).toEqual([]);
  });
});

describe("leaving a workspace", () => {
  /**
   * Fresh users throughout, so this can sit anywhere in the file: it takes
   * memberships away, and the assertions above depend on Carol keeping hers.
   */
  async function join(workspaceId: string, userId: string, role: "admin" | "member") {
    const { error } = await serviceClient()
      .from("workspace_members")
      .insert({ workspace_id: workspaceId, user_id: userId, role });
    if (error) throw new Error(`could not add ${userId}: ${error.message}`);
  }

  async function membership(user: TestUser, workspaceId: string): Promise<boolean> {
    // Read as the service role, not as the user: once they have left, the
    // select policy stops returning the row either way, so asking as them
    // cannot tell "gone" from "invisible".
    const { data } = await serviceClient()
      .from("workspace_members")
      .select("user_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", user.id);
    return (data ?? []).length > 0;
  }

  it("is something a member can do for themselves", async () => {
    // The gap: workspace_members had select-fellow, update-admin and
    // delete-admin, all of them about what an admin does TO somebody. There was
    // no way to remove your own row, so joining was one-way.
    const host = await createTestUser("leave-host");
    const guest = await createTestUser("leave-guest");
    await join(host.workspaceId, guest.id, "member");

    const { error } = await guest.db
      .from("workspace_members")
      .delete()
      .eq("workspace_id", host.workspaceId)
      .eq("user_id", guest.id);

    expect(error).toBeNull();
    expect(await membership(guest, host.workspaceId), "the membership survived").toBe(false);
    // The host's workspace is untouched — one person leaving is not a deletion.
    expect(await membership(host, host.workspaceId)).toBe(true);
  });

  it("does not become a way to remove anybody else", async () => {
    // The new policy is keyed to auth.uid(). If it were keyed to membership
    // instead, every member would inherit delete-admin's reach.
    const host = await createTestUser("evict-host");
    const guest = await createTestUser("evict-guest");
    const other = await createTestUser("evict-other");
    await join(host.workspaceId, guest.id, "member");
    await join(host.workspaceId, other.id, "member");

    await guest.db
      .from("workspace_members")
      .delete()
      .eq("workspace_id", host.workspaceId)
      .eq("user_id", other.id);

    expect(await membership(other, host.workspaceId), "a member evicted a peer").toBe(true);
  });

  it("still refuses the last admin of a workspace that is staying", async () => {
    // Deciding what a leaving last admin should do to the workspace is the
    // product question 0016's header left open; the answer is that they hand
    // the role over first. Nothing here is new — trg_prevent_last_admin has
    // always refused this — but leaving is now a thing people can attempt, so
    // it is worth asserting that the guard covers the new door too.
    const solo = await createTestUser("solo-admin");
    await join(solo.workspaceId, (await createTestUser("solo-member")).id, "member");

    const { error } = await solo.db
      .from("workspace_members")
      .delete()
      .eq("workspace_id", solo.workspaceId)
      .eq("user_id", solo.id);

    expect(error?.message ?? "").toMatch(/last admin/);
    expect(await membership(solo, solo.workspaceId)).toBe(true);
  });

  it("lets an admin leave once somebody else can run the place", async () => {
    // The other half: the guard is about the workspace keeping an admin, not
    // about admins being stuck. This one already worked before the new policy —
    // delete-admin covers your own row as much as anybody's — so it is here as
    // a regression guard rather than as proof of the fix. Only a plain member
    // needed something new.
    const host = await createTestUser("cohost-a");
    const cohost = await createTestUser("cohost-b");
    await join(host.workspaceId, cohost.id, "admin");

    const { error } = await cohost.db
      .from("workspace_members")
      .delete()
      .eq("workspace_id", host.workspaceId)
      .eq("user_id", cohost.id);

    expect(error).toBeNull();
    expect(await membership(cohost, host.workspaceId)).toBe(false);
    expect(await membership(host, host.workspaceId)).toBe(true);
  });
});

describe("a removed member's own conversation", () => {
  /**
   * The half `after being removed` below never built. It removes Carol, who
   * owns nothing in Alice's workspace, so it proves she loses sight of other
   * people's rows and says nothing about her own.
   *
   * The rows here are the ones that matter: a private session the guest opened
   * against the HOST's agent. They wrote the questions, so keeping those is
   * arguable — but every assistant reply in the thread was grounded in the
   * workspace's knowledge bundles, so a readable transcript is a readable copy
   * of what those documents said. Removing somebody has to take it back.
   *
   * Fresh users throughout: this takes a membership away, and the assertions
   * elsewhere in the file depend on Carol keeping hers.
   */
  let host: TestUser;
  let guest: TestUser;
  let seeded: Seeded;
  let ownSessionId: string;
  let ownMessageId: string;
  let cardInSharedSessionId: string;

  async function setMembership(present: boolean) {
    const members = serviceClient().from("workspace_members");
    const { error } = present
      ? await members.insert({
          workspace_id: host.workspaceId,
          user_id: guest.id,
          role: "member",
        })
      : await members.delete().eq("workspace_id", host.workspaceId).eq("user_id", guest.id);
    if (error) throw new Error(`could not set membership: ${error.message}`);
  }

  /** Reads as the service role, so "gone" is distinguishable from "invisible". */
  async function stillExists(table: string, id: string): Promise<boolean> {
    const { data } = await serviceClient().from(table).select("id").eq("id", id);
    return (data ?? []).length > 0;
  }

  beforeAll(async () => {
    host = await createTestUser("keeps-host");
    guest = await createTestUser("keeps-guest");
    seeded = await seedWorkspace(host, "shared");
    await setMembership(true);

    const { data: session, error: sessionError } = await guest.db
      .from("chat_sessions")
      .insert({
        agent_id: seeded.agentId,
        user_id: guest.id,
        workspace_id: host.workspaceId,
        visibility: "private",
        title: "What the guest asked the workspace's agent",
      })
      .select("id")
      .single();
    if (sessionError) throw new Error(`guest could not open a session: ${sessionError.message}`);
    ownSessionId = session.id as string;

    const { data: message, error: messageError } = await guest.db
      .from("messages")
      .insert({
        session_id: ownSessionId,
        sender_id: guest.id,
        role: "user",
        content: "what does the pricing document say?",
      })
      .select("id")
      .single();
    if (messageError) throw new Error(`guest could not write a message: ${messageError.message}`);
    ownMessageId = message.id as string;

    // A card of their own on somebody else's shared board — same shape, one
    // table further out, and the policy there carries the same open branch.
    const { data: card, error: cardError } = await guest.db
      .from("ideas")
      .insert({
        session_id: seeded.sessionId,
        workspace_id: host.workspaceId,
        title: "The guest's card",
        created_by: guest.id,
      })
      .select("id")
      .single();
    if (cardError) throw new Error(`guest could not add a card: ${cardError.message}`);
    cardInSharedSessionId = card.id as string;

    await setMembership(false);
  });

  it("stops being readable, along with what the agent answered in it", async () => {
    expect(await visible(guest, "chat_sessions", ownSessionId)).toBe(false);
    expect(await visible(guest, "messages", ownMessageId)).toBe(false);
    expect(await visible(guest, "ideas", cardInSharedSessionId)).toBe(false);
  });

  it("cannot be appended to", async () => {
    // Harmless on its own — the agent is unreachable, so nothing answers — but
    // it is a write into a workspace they are no longer in.
    const { error } = await guest.db.from("messages").insert({
      session_id: ownSessionId,
      sender_id: guest.id,
      role: "user",
      content: "are you still there?",
    });
    expect(error, "an ex-member appended to a workspace thread").not.toBeNull();
  });

  it("cannot be edited or deleted either", async () => {
    const { data: edited } = await guest.db
      .from("messages")
      .update({ content: "rewritten from outside the workspace" })
      .eq("id", ownMessageId)
      .select("id");
    expect(edited ?? []).toEqual([]);

    const { data: deleted } = await guest.db
      .from("chat_sessions")
      .delete()
      .eq("id", ownSessionId)
      .select("id");
    expect(deleted ?? []).toEqual([]);
    // Deleting is not obviously harmful, but a shared thread the team relies on
    // is not an ex-member's to destroy, and the rows have to survive for the
    // re-invitation below to mean anything.
    expect(await stillExists("chat_sessions", ownSessionId)).toBe(true);
  });

  it("comes back if they are invited back", async () => {
    // Nothing is deleted by removal — the rows are simply out of reach, which
    // is what makes this reversible and what the removal dialog promises.
    await setMembership(true);
    expect(await visible(guest, "chat_sessions", ownSessionId)).toBe(true);
    expect(await visible(guest, "messages", ownMessageId)).toBe(true);
    expect(await visible(guest, "ideas", cardInSharedSessionId)).toBe(true);
    await setMembership(false);
  });

  it("does not take the workspace's own copy with it", async () => {
    // The other half of the invariant: the guest's card sits on the host's
    // shared board, and the host keeps reading it after the guest is gone.
    expect(await visible(host, "ideas", cardInSharedSessionId)).toBe(true);
    expect(await visible(host, "chat_sessions", seeded.sessionId)).toBe(true);
  });
});

describe("after being removed from the workspace", () => {
  // Runs last on purpose: it takes Carol's membership away, and the assertions
  // above depend on her having it.
  beforeAll(async () => {
    const { error } = await serviceClient()
      .from("workspace_members")
      .delete()
      .eq("workspace_id", alice.workspaceId)
      .eq("user_id", carol.id);
    if (error) throw new Error(`could not remove carol: ${error.message}`);
  });

  it("loses sight of everything at once", async () => {
    expect(await visible(carol, "agents", priv.agentId)).toBe(false);
    expect(await visible(carol, "knowledge_bundles", priv.bundleId)).toBe(false);
    expect(await visible(carol, "documents", priv.documentId)).toBe(false);
    expect(await visible(carol, "workspaces", alice.workspaceId)).toBe(false);
    expect(await visible(carol, "chat_sessions", shared.sessionId)).toBe(false);
    expect(await visible(carol, "routines", shared.routineId)).toBe(false);
  });

  it("can no longer see the profile of someone they no longer share a workspace with", async () => {
    expect(await visible(carol, "profiles", alice.id)).toBe(false);
  });
});
