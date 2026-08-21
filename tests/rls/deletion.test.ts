/**
 * What happens when a workspace or a person goes away.
 *
 * Unlike the rest of this suite these are not policy tests — no user can delete
 * a workspace through the API, because `workspaces` has no delete policy, and
 * nobody can delete an account because there is no route for it. They run as
 * the operator does, over SQL, and they exist because 0016 fixed two things
 * that were impossible before it and could only have been discovered by
 * someone with a legal deadline.
 *
 * The other half of each test matters as much as the first: `trg_prevent_last_admin`
 * still has to refuse a member leaving a workspace un-owned. Making deletion
 * work by weakening that guard would be a worse bug than the one being fixed.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  sql,
  type TestUser,
} from "./harness";
import { seedWorkspace } from "./fixtures";

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await createTestUser("alice");
  bob = await createTestUser("bob");
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("deleting a workspace", () => {
  it("works, and takes its contents with it", async () => {
    // Before 0016 this raised: the cascade into workspace_members hit the
    // last-admin guard, so even a single-member personal workspace was
    // permanent. It is the plainest possible operation and it did not work.
    const seeded = await seedWorkspace(alice);
    const db = sql();

    // chat_sessions.workspace_id and ideas.workspace_id are NO ACTION, so they
    // still go first — that is a separate arrangement from the one 0016 fixed.
    await db`delete from public.ideas where workspace_id = ${alice.workspaceId}`;
    await db`delete from public.chat_sessions where workspace_id = ${alice.workspaceId}`;
    await db`delete from public.workspaces where id = ${alice.workspaceId}`;

    const [{ count: workspaces }] = await db<{ count: string }[]>`
      select count(*) from public.workspaces where id = ${alice.workspaceId}`;
    expect(Number(workspaces)).toBe(0);

    // The agent went with it; the person did not.
    const [{ count: agents }] = await db<{ count: string }[]>`
      select count(*) from public.agents where id = ${seeded.agentId}`;
    expect(Number(agents)).toBe(0);

    const [{ count: users }] = await db<{ count: string }[]>`
      select count(*) from auth.users where id = ${alice.id}`;
    expect(Number(users)).toBe(1);
  });

  it("still refuses to leave a surviving workspace without an admin", async () => {
    // The guard, doing its job. Bob is the only admin of his own workspace, and
    // that workspace is not going anywhere.
    const db = sql();

    await expect(
      db`delete from public.workspace_members
         where workspace_id = ${bob.workspaceId} and user_id = ${bob.id}`,
    ).rejects.toThrow(/last admin/);
  });

  it("still refuses to demote the last admin", async () => {
    const db = sql();

    await expect(
      db`update public.workspace_members set role = 'member'
         where workspace_id = ${bob.workspaceId} and user_id = ${bob.id}`,
    ).rejects.toThrow(/last admin/);
  });
});

describe("deleting a person", () => {
  it("keeps what they made in workspaces that outlive them, without their name on it", async () => {
    // The case the six NO ACTION keys made impossible: someone who ever created
    // anything in a workspace they no longer belong to could not be erased,
    // because the agent — or bundle, or idea, or invitation — still pointed at
    // them.
    const db = sql();

    // Carol joins Bob's workspace and leaves an agent behind.
    const carol = await createTestUser("carol");
    const { error: joinError } = await serviceClient()
      .from("workspace_members")
      .insert({ workspace_id: bob.workspaceId, user_id: carol.id, role: "member" });
    if (joinError) throw new Error(joinError.message);

    const agentId = await carol.db
      .from("agents")
      .insert({ workspace_id: bob.workspaceId, name: "Carol's agent", created_by: carol.id })
      .select("id")
      .single()
      .then(({ data, error }) => {
        if (error) throw new Error(error.message);
        return data.id as string;
      });

    // Her own workspace goes first — she is its only admin, and the guard still
    // covers that. This is the step a "delete my account" route would own, and
    // the question it leaves open is what to do when the workspace has other
    // members. Here it does not.
    await db`delete from public.chat_sessions where workspace_id = ${carol.workspaceId}`;
    await db`delete from public.workspaces where created_by = ${carol.id}`;

    await db`delete from auth.users where id = ${carol.id}`;

    const [{ count: users }] = await db<{ count: string }[]>`
      select count(*) from auth.users where id = ${carol.id}`;
    expect(Number(users)).toBe(0);

    // Bob's workspace still has the agent. It just no longer claims she made it.
    const [agent] = await db<{ created_by: string | null }[]>`
      select created_by from public.agents where id = ${agentId}`;
    expect(agent).toBeDefined();
    expect(agent.created_by).toBeNull();
  });

  it("takes everything that was theirs alone", async () => {
    // The other side of the same coin: attribution is nulled, ownership
    // cascades. A profile, a private session or a delivery channel has no
    // meaning without its person and should not survive them.
    const db = sql();
    const dave = await createTestUser("dave");
    const seeded = await seedWorkspace(dave);

    await db`delete from public.ideas where workspace_id = ${dave.workspaceId}`;
    await db`delete from public.chat_sessions where workspace_id = ${dave.workspaceId}`;
    await db`delete from public.workspaces where created_by = ${dave.id}`;
    await db`delete from auth.users where id = ${dave.id}`;

    for (const [table, id] of [
      ["profiles", dave.id],
      ["chat_sessions", seeded.sessionId],
      ["delivery_channels", seeded.channelId],
      ["routines", seeded.routineId],
    ] as const) {
      const [{ count }] = await db<{ count: string }[]>`
        select count(*) from ${db(`public.${table}`)} where id = ${id}`;
      expect(Number(count), `${table} outlived its owner`).toBe(0);
    }
  });
});
