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
