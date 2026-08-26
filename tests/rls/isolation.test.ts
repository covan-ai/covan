/**
 * Two strangers: Alice and Bob, each in the workspace the signup trigger gave
 * them, with no membership in common.
 *
 * Bob is not attacking anything exotic here — he is issuing the same requests
 * the app issues, with his own valid token, against ids that belong to Alice.
 * That is exactly what a bug in a route would produce: a real session asking
 * for someone else's row. The database has to be the thing that says no.
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
let bob: TestUser;
let seeded: Seeded;
/** Bob's own workspace's worth of content — his own agent is the trick below. */
let outsiderSeed: Seeded;
/** A genuine member of Alice's workspace, distinct from Alice herself. */
let member: TestUser;

beforeAll(async () => {
  alice = await createTestUser("alice");
  bob = await createTestUser("bob");
  seeded = await seedWorkspace(alice);
  outsiderSeed = await seedWorkspace(bob);

  member = await createTestUser("isolation-member");
  const { error: memberError } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: alice.workspaceId, user_id: member.id, role: "member" });
  if (memberError) {
    throw new Error(`could not add member to alice's workspace: ${memberError.message}`);
  }
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

/** Every row Alice owns, and the column Bob would look it up by. */
const rows = () => [
  { table: "agents", id: seeded.agentId },
  { table: "knowledge_bundles", id: seeded.bundleId },
  { table: "documents", id: seeded.documentId },
  { table: "chat_sessions", id: seeded.sessionId },
  { table: "messages", id: seeded.messageId },
  { table: "ideas", id: seeded.ideaId },
  { table: "routines", id: seeded.routineId },
  { table: "delivery_channels", id: seeded.channelId },
];

describe("a user from another workspace", () => {
  it("seeded something to be denied", () => {
    // Without this, every test below would pass against ids that are undefined.
    for (const { table, id } of rows()) {
      expect(id, `${table} was not seeded`).toBeTruthy();
    }
  });

  it("cannot read any of it", async () => {
    const visible: string[] = [];

    for (const { table, id } of rows()) {
      const { data } = await bob.db.from(table).select("id").eq("id", id);
      if (data && data.length > 0) visible.push(table);
    }

    expect(visible).toEqual([]);
  });

  it("cannot find it by listing the table either", async () => {
    // A policy can be right for a filtered lookup and wrong for a bare list.
    const leaked: string[] = [];

    for (const { table, id } of rows()) {
      const { data } = await bob.db.from(table).select("id");
      if ((data ?? []).some((row) => row.id === id)) leaked.push(table);
    }

    expect(leaked).toEqual([]);
  });

  it("cannot update any of it", async () => {
    // An UPDATE that matches no rows under RLS reports success with an empty
    // result — which is the denial. A row coming back means it was written.
    const written: string[] = [];

    for (const { table, id } of rows()) {
      const { data } = await bob.db
        .from(table)
        .update({ created_at: new Date(0).toISOString() })
        .eq("id", id)
        .select("id");
      if (data && data.length > 0) written.push(table);
    }

    expect(written).toEqual([]);
  });

  it("cannot delete any of it", async () => {
    const deleted: string[] = [];

    for (const { table, id } of rows()) {
      const { data } = await bob.db.from(table).delete().eq("id", id).select("id");
      if (data && data.length > 0) deleted.push(table);
    }

    expect(deleted).toEqual([]);

    // And Alice still has everything. Proves the check above was not passing
    // because the rows had already gone.
    for (const { table, id } of rows()) {
      const { data } = await alice.db.from(table).select("id").eq("id", id);
      expect(data, `${table} disappeared`).toHaveLength(1);
    }
  });

  it("cannot plant a row in the other workspace", async () => {
    const { error } = await bob.db.from("agents").insert({
      workspace_id: alice.workspaceId,
      name: "Bob was here",
      created_by: bob.id,
    });

    expect(error).not.toBeNull();
  });

  it("cannot make themselves a member of it", async () => {
    // workspace_members has no INSERT policy — only the signup trigger and the
    // service-role client write to it. This is what stops self-invitation.
    const { error } = await bob.db.from("workspace_members").insert({
      workspace_id: alice.workspaceId,
      user_id: bob.id,
      role: "admin",
    });

    expect(error).not.toBeNull();
  });

  it("cannot see the other's workspace or profile", async () => {
    const { data: workspaces } = await bob.db
      .from("workspaces")
      .select("id")
      .eq("id", alice.workspaceId);
    expect(workspaces ?? []).toEqual([]);

    // profiles is readable across a shared workspace by design. Alice and Bob
    // share none, so Bob must not see her email address.
    const { data: profiles } = await bob.db.from("profiles").select("id").eq("id", alice.id);
    expect(profiles ?? []).toEqual([]);
  });
});

/**
 * chat_sessions insert checks user_id = auth.uid() and nothing else, while the
 * select policy hands reads to every workspace member once visibility is
 * 'shared' — keyed on workspace_id, a column the writer chooses. Foreign keys
 * bypass RLS, so any real workspace uuid is accepted unless the policy itself
 * reconciles workspace_id against the caller's membership and the agent's own.
 */
describe("chat_sessions: the workspace and the agent must agree", () => {
  it("cannot plant a shared session inside a workspace it does not belong to", async () => {
    const { error } = await bob.db.from("chat_sessions").insert({
      agent_id: outsiderSeed.agentId, // bob's own agent, which is the trick
      user_id: bob.id,
      workspace_id: seeded.workspaceId, // alice's workspace — bob is not a member
      visibility: "shared",
      kind: "brainstorm",
      title: "Q3 layoff plan",
    });

    expect(error).not.toBeNull();
  });

  it("cannot attach a session to an agent from another workspace", async () => {
    const { error } = await member.db.from("chat_sessions").insert({
      agent_id: outsiderSeed.agentId, // bob's agent, from bob's workspace
      user_id: member.id,
      workspace_id: seeded.workspaceId, // member's own workspace — mismatched agent
      visibility: "private",
      kind: "chat",
      title: "mismatched",
    });

    expect(error).not.toBeNull();
  });
});

/**
 * Onboarding answers are keyed on `user_id`, not `id`, so they sit outside the
 * generic loop above. They are also the one table here a user writes for
 * themselves before belonging to anything, which makes "your own" the entire
 * policy — worth its own denial.
 */
describe("another user's onboarding answers", () => {
  beforeAll(async () => {
    // Alice answers for herself, through her own client, the way the route does.
    const { error } = await alice.db
      .from("user_onboarding")
      .upsert({ user_id: alice.id, role: "engineering" }, { onConflict: "user_id" });
    expect(error).toBeNull();
  });

  it("cannot be read by anyone else", async () => {
    const { data } = await bob.db.from("user_onboarding").select("user_id").eq("user_id", alice.id);
    expect(data ?? []).toEqual([]);
  });

  it("cannot be found by listing the table either", async () => {
    const { data } = await bob.db.from("user_onboarding").select("user_id");
    expect((data ?? []).some((row) => row.user_id === alice.id)).toBe(false);
  });

  it("cannot be updated by anyone else", async () => {
    const { data } = await bob.db
      .from("user_onboarding")
      .update({ role: "sales" })
      .eq("user_id", alice.id)
      .select("user_id");
    expect(data ?? []).toEqual([]);

    // And Alice's answer is untouched — proving the empty result above was a
    // denial and not a row that had already gone.
    const { data: mine } = await alice.db
      .from("user_onboarding")
      .select("role")
      .eq("user_id", alice.id)
      .maybeSingle();
    expect(mine?.role).toBe("engineering");
  });

  it("cannot be forged on someone else's behalf", async () => {
    const { error } = await bob.db.from("user_onboarding").insert({
      user_id: alice.id,
      role: "founder",
    });
    expect(error).not.toBeNull();
  });
});
