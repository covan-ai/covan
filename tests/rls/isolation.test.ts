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
import { closeSql, createTestUser, destroyTestUsers, type TestUser } from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

let alice: TestUser;
let bob: TestUser;
let seeded: Seeded;

beforeAll(async () => {
  alice = await createTestUser("alice");
  bob = await createTestUser("bob");
  seeded = await seedWorkspace(alice);
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
