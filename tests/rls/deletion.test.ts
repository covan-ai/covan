/**
 * What happens when a workspace or a person goes away.
 *
 * Unlike the rest of this suite these are not policy tests — `workspaces` has
 * no delete policy and `auth.users` is outside RLS entirely, so both deletions
 * happen with the service role. They run as `DELETE /account` does, over SQL,
 * and they exist because 0016 fixed two things that were impossible before it
 * and could only have been discovered by someone with a legal deadline.
 *
 * There is now a route on top of this — `worker/src/routes/account.ts` — and
 * the order it uses is the subject of the last test here: the empty workspaces
 * have to go first, or `trg_prevent_last_admin` refuses the membership row that
 * the user's own cascade depends on.
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

  it("takes the conversation and the idea that used to hold it open", async () => {
    // The two deletes the test above still performs are the subject of this
    // one. Before 0035, `chat_sessions.workspace_id` and `ideas.workspace_id`
    // were plain references with no delete rule, so NO ACTION refused the
    // workspace while a single row named it — and four places carried the same
    // procedure for getting past that: the test above, `routes/account.ts`,
    // `export-roundtrip.test.ts`, and `docs/team.md`.
    //
    // So: a workspace with a conversation and an idea still in it, deleted
    // with nothing cleared first. This is the assertion the workarounds exist
    // in place of, which is why it is worth having before they go.
    const gwen = await createTestUser("gwen");
    const seeded = await seedWorkspace(gwen);
    const db = sql();

    await db`delete from public.workspaces where id = ${gwen.workspaceId}`;

    const [{ count: sessions }] = await db<{ count: string }[]>`
      select count(*) from public.chat_sessions where id = ${seeded.sessionId}`;
    expect(Number(sessions)).toBe(0);

    const [{ count: ideas }] = await db<{ count: string }[]>`
      select count(*) from public.ideas where id = ${seeded.ideaId}`;
    expect(Number(ideas)).toBe(0);
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

describe("deleting a workspace a delivery channel was added from", () => {
  it("succeeds, and leaves the channel and the routine using it working", async () => {
    // The case no other test builds: a channel whose workspace and whose
    // routine are two different workspaces.
    //
    // Every rule in the schema treats a channel as belonging to a person —
    // routines_insert_own admits any channel where dc.user_id = auth.uid()
    // without comparing workspaces, and the executor matches on user_id too.
    // Only delivery_channels.workspace_id disagreed, by cascading. So a routine
    // in Erin's workspace could hold Frank's workspace open forever, and Frank
    // could not see the routine, let alone delete it.
    const db = sql();
    const erin = await createTestUser("erin");
    const frank = await createTestUser("frank");

    const { error: joinError } = await serviceClient()
      .from("workspace_members")
      .insert({ workspace_id: frank.workspaceId, user_id: erin.id, role: "member" });
    if (joinError) throw new Error(joinError.message);

    // Erin adds a channel while Frank's workspace is the active one. That is
    // the only thing that decides workspace_id — see POST /delivery-channels.
    const { data: channel, error: channelError } = await serviceClient()
      .from("delivery_channels")
      .insert({
        workspace_id: frank.workspaceId,
        user_id: erin.id,
        kind: "email",
        label: "e••••n@covan.test",
        secret_ciphertext: "not-a-real-ciphertext",
      })
      .select("id")
      .single();
    if (channelError) throw new Error(channelError.message);

    // ...and uses it on a routine in her own workspace. The policy allows this,
    // which is the first half of the finding.
    const { data: agent, error: agentError } = await erin.db
      .from("agents")
      .insert({ workspace_id: erin.workspaceId, name: "Erin's agent", created_by: erin.id })
      .select("id")
      .single();
    if (agentError) throw new Error(agentError.message);

    const { data: routine, error: routineError } = await erin.db
      .from("routines")
      .insert({
        workspace_id: erin.workspaceId,
        agent_id: agent.id,
        user_id: erin.id,
        name: "Erin's routine",
        source_kind: "rss",
        instruction: "summarise",
        delivery_channel_id: channel.id,
        schedule_cron: "0 9 * * *",
      })
      .select("id")
      .single();
    expect(routineError, "a routine may use its owner's channel from any workspace").toBeNull();

    // Frank dismantles his workspace. Before 0019 this raised
    // "violates foreign key constraint routines_delivery_channel_id_fkey" —
    // the cascade took the channel and the deferred check found Erin's routine
    // still pointing at it.
    await db`delete from public.workspaces where id = ${frank.workspaceId}`;

    const [{ count: workspaces }] = await db<{ count: string }[]>`
      select count(*) from public.workspaces where id = ${frank.workspaceId}`;
    expect(Number(workspaces), "a routine elsewhere kept the workspace alive").toBe(0);

    // Erin keeps her channel — it was hers, not the workspace's — and it now
    // records that the workspace it was added from is gone.
    const [survivor] = await db<{ workspace_id: string | null }[]>`
      select workspace_id from public.delivery_channels where id = ${channel.id}`;
    expect(survivor, "the channel went with a workspace that did not own it").toBeDefined();
    expect(survivor.workspace_id).toBeNull();

    // And the routine still delivers somewhere.
    const [{ count: routines }] = await db<{ count: string }[]>`
      select count(*) from public.routines
      where id = ${routine.id} and delivery_channel_id = ${channel.id}`;
    expect(Number(routines)).toBe(1);
  });

  it("still refuses to delete a channel a routine is using", async () => {
    // The other half. Loosening the workspace key must not loosen this one:
    // it is what the API turns into the 409 the interface explains.
    const db = sql();
    const gwen = await createTestUser("gwen");
    const seeded = await seedWorkspace(gwen);

    await expect(
      db`delete from public.delivery_channels where id = ${seeded.channelId}`,
    ).rejects.toThrow(/routines_delivery_channel_id_fkey/);
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

  it("takes their API keys, in the order the route deletes things", async () => {
    // Two claims in one test, because they are the same claim from either end.
    //
    // First: a key is a person, so it has to die with them. `0033` says so with
    // `on delete cascade` and nothing else in the codebase asserts it — a later
    // migration that recreated the table with a different clause would leave a
    // working credential belonging to somebody who no longer exists, and every
    // request it made would resolve to a user id that is gone.
    //
    // Second: the order. `prevent_last_admin_removal` asks only whether the
    // workspace still stands and whether another admin remains — it never asks
    // how many members are left, and everybody starts as the sole admin of
    // their own. Deleting the user first is therefore refused for essentially
    // every account there will ever be, which is why the route empties the
    // workspaces nobody is left in before it touches `auth.users`.
    const db = sql();
    const erin = await createTestUser("erin");
    const seeded = await seedWorkspace(erin);

    const [key] = await db<{ id: string }[]>`
      insert into public.api_keys (workspace_id, user_id, name, token_hash, prefix)
      values (${erin.workspaceId}, ${erin.id}, 'Nightly report',
              ${`hash-${erin.id}`}, 'covan_sk_ab12cd')
      returning id`;

    // The refusal, proven rather than assumed — if this ever stops throwing,
    // the ordering below has become decoration and the comment above is wrong.
    await expect(db`delete from auth.users where id = ${erin.id}`).rejects.toThrow(/last admin/);

    // The two references that do not cascade, cleared first — the same order
    // the route uses, and the reason it has to. This is what the test caught:
    // without it `delete from workspaces` fails on
    // `chat_sessions_workspace_id_fkey` for every workspace anybody has used.
    await db`delete from public.ideas where workspace_id = ${erin.workspaceId}`;
    await db`delete from public.chat_sessions where workspace_id = ${erin.workspaceId}`;
    await db`delete from public.workspaces where id = ${erin.workspaceId}`;
    await db`delete from auth.users where id = ${erin.id}`;

    // `chat_sessions` is not asserted here — it was deleted by name two lines
    // up, so its absence would prove nothing. The test above it covers the
    // cascade case.
    for (const [table, id] of [
      ["api_keys", key.id],
      ["profiles", erin.id],
    ] as const) {
      const [{ count }] = await db<{ count: string }[]>`
        select count(*) from ${db(`public.${table}`)} where id = ${id}`;
      expect(Number(count), `${table} outlived its owner`).toBe(0);
    }
  });
});
