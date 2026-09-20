/**
 * What the database says about a routine's ingest token.
 *
 * This table exists because of two grants 0023 wrote. It gave `authenticated` a
 * table-level SELECT **and** UPDATE on `routines`, neither with a column list,
 * and `routines_select_visible` shares a routine with everybody in its
 * workspace. Had the token's hash been a column on `routines`, both of those
 * would have reached it: a colleague could read the hash of a shared routine's
 * token, and any routine's owner could write their own row's hash to equal
 * somebody else's — which is not a leak but a takeover, because the sender's
 * payload then arrives at a routine with the attacker's instruction and the
 * attacker's delivery channel.
 *
 * So the argument for a separate table is entirely about grants and policies,
 * and grants and policies are only provable here.
 *
 * The other half is `claim_due_routines`. Its new filter decides whether a
 * routine that has no schedule to be due on can starve the ones that do out of
 * a tick's batch — which is a thing no unit test can see, because the function
 * is SQL.
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
import { seedWorkspace, type Seeded } from "./fixtures";

let owner: TestUser;
let colleague: TestUser;
let shared: Seeded;

/** The route mints these with the service role, because no client may write the hash. */
async function giveTrigger(routineId: string, hash: string) {
  const { error } = await serviceClient()
    .from("routine_triggers")
    .upsert({ routine_id: routineId, token_hash: hash }, { onConflict: "routine_id" });
  if (error) throw new Error(`seeding routine_triggers failed: ${error.message}`);
}

beforeAll(async () => {
  owner = await createTestUser("trigger-owner");
  colleague = await createTestUser("trigger-colleague");

  shared = await seedWorkspace(owner, "shared");

  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: owner.workspaceId, user_id: colleague.id, role: "member" });
  if (error) throw new Error(`could not add the colleague: ${error.message}`);

  await giveTrigger(shared.routineId, "hash-of-the-owners-token");
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("the token hash", () => {
  it("is not selectable by the routine's own owner", async () => {
    const { error } = await owner.db
      .from("routine_triggers")
      .select("routine_id, token_hash")
      .eq("routine_id", shared.routineId);

    expect(error?.code).toBe("42501");
  });

  // And a `select *` does not quietly come back without it — the whole read is
  // refused. PostgREST expands `*` to every column the table has, including the
  // one the grant withholds, so Postgres answers 42501 for the row rather than
  // handing back the part you were allowed. That is stricter than "the column
  // is absent" and it is the reason `lib/export/tables.ts` names its columns
  // for tables like this one instead of asking for everything.
  it("is not reachable by asking for everything either", async () => {
    const { error } = await owner.db
      .from("routine_triggers")
      .select("*")
      .eq("routine_id", shared.routineId)
      .single();

    expect(error?.code).toBe("42501");
  });

  it("leaves the three columns the grant does name readable", async () => {
    const { data, error } = await owner.db
      .from("routine_triggers")
      .select("routine_id, created_at, last_used_at")
      .eq("routine_id", shared.routineId)
      .single();

    expect(error).toBeNull();
    expect(data).toMatchObject({ routine_id: shared.routineId });
    expect(data).toHaveProperty("last_used_at");
    expect(data).not.toHaveProperty("token_hash");
  });

  // The takeover. Without the separate table and its missing UPDATE grant, this
  // is how one member points another's webhook at their own routine.
  it("cannot be written by the owner", async () => {
    const { error } = await owner.db
      .from("routine_triggers")
      .update({ token_hash: "hash-of-somebody-elses-token" })
      .eq("routine_id", shared.routineId);

    expect(error?.code).toBe("42501");
  });

  it("cannot be inserted by the owner either", async () => {
    const { error } = await owner.db
      .from("routine_triggers")
      .insert({ routine_id: shared.routineId, token_hash: "mine-now" });

    expect(error).not.toBeNull();
  });

  // One token, one routine — so even a write that got past the grants could not
  // aim two routines at one sender's payload.
  it("belongs to one routine and no more", async () => {
    const second = await seedWorkspace(owner, "private");
    const { error } = await serviceClient()
      .from("routine_triggers")
      .insert({ routine_id: second.routineId, token_hash: "hash-of-the-owners-token" });

    expect(error?.code).toBe("23505");
  });
});

describe("who can see that a routine has a trigger", () => {
  // Deliberately narrower than the routine's own visibility. Sharing a routine
  // shares what it does and what it sent; it does not share the ability to fire
  // it, and a colleague who can read the row could otherwise tell that a
  // webhook exists and when it last ran.
  it("is the owner, even for a routine shared with the workspace", async () => {
    const { data: mine } = await owner.db
      .from("routine_triggers")
      .select("routine_id")
      .eq("routine_id", shared.routineId);
    expect(mine).toHaveLength(1);

    const { data: theirs } = await colleague.db
      .from("routine_triggers")
      .select("routine_id")
      .eq("routine_id", shared.routineId);
    expect(theirs).toEqual([]);
  });

  it("does not let a colleague turn it off", async () => {
    await colleague.db.from("routine_triggers").delete().eq("routine_id", shared.routineId);

    // Silently nothing, which is what a delete filtered by RLS does — the row
    // is still there.
    const { data } = await owner.db
      .from("routine_triggers")
      .select("routine_id")
      .eq("routine_id", shared.routineId);
    expect(data).toHaveLength(1);
  });

  it("does let the owner turn it off", async () => {
    const throwaway = await seedWorkspace(owner, "private");
    await giveTrigger(throwaway.routineId, "hash-to-be-deleted");

    const { error } = await owner.db
      .from("routine_triggers")
      .delete()
      .eq("routine_id", throwaway.routineId);

    expect(error).toBeNull();
    const { data } = await owner.db
      .from("routine_triggers")
      .select("routine_id")
      .eq("routine_id", throwaway.routineId);
    expect(data).toEqual([]);
  });
});

describe("trigger_kind", () => {
  // Said at creation rather than discovered as an inconsistency later: every
  // answer to "the routine has a feed and somebody poked it, does it re-fetch?"
  // is bad, so the pairing is refused instead.
  it("refuses a webhook trigger on a routine that watches something", async () => {
    const { error } = await owner.db
      .from("routines")
      .update({ trigger_kind: "webhook" })
      .eq("id", shared.routineId);

    // The seeded routine is source_kind 'web'.
    expect(error).not.toBeNull();
  });

  it("accepts one on a routine with no source", async () => {
    const { data: created, error } = await owner.db
      .from("routines")
      .insert({
        workspace_id: owner.workspaceId,
        agent_id: shared.agentId,
        user_id: owner.id,
        name: "Poked only",
        source_kind: "none",
        source_config: {},
        instruction: "summarise what arrived",
        delivery_channel_id: shared.channelId,
        schedule_cron: "0 9 * * *",
        trigger_kind: "webhook",
      })
      .select("id, trigger_kind")
      .single();

    expect(error).toBeNull();
    expect(created?.trigger_kind).toBe("webhook");
  });

  it("refuses a value nobody implemented", async () => {
    const { error } = await owner.db
      .from("routines")
      .update({ trigger_kind: "carrier_pigeon" })
      .eq("id", shared.routineId);

    expect(error).not.toBeNull();
  });
});

describe("claim_due_routines", () => {
  /**
   * A routine with no source, which is what a poke-only one has to be — 0055
   * refuses `trigger_kind = 'webhook'` on a routine that still has a feed to
   * read.
   *
   * Created rather than edited. 0027 pins `source_kind` and `source_config` for
   * the life of the row, with a trigger and not merely a policy, because a
   * routine whose URL can be changed after it was checked is the vulnerability
   * that migration closed. So `seedWorkspace` followed by an update is not a
   * shortcut, it is a thing the database refuses.
   */
  async function seedSourcelessRoutine(name: string): Promise<string> {
    const { data, error } = await owner.db
      .from("routines")
      .insert({
        workspace_id: owner.workspaceId,
        agent_id: shared.agentId,
        user_id: owner.id,
        name,
        visibility: "private",
        source_kind: "none",
        source_config: {},
        instruction: "summarise",
        delivery_channel_id: shared.channelId,
        schedule_cron: "0 9 * * *",
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`seeding a sourceless routine failed: ${error?.message}`);
    return data.id as string;
  }

  /** Make a routine due, the way a tick would find it. */
  async function makeDue(routineId: string, triggerKind: string) {
    await sql()`
      update public.routines
      set trigger_kind = ${triggerKind},
          status = 'active',
          claimed_at = null,
          next_run_at = now() - interval '1 minute'
      where id = ${routineId}
    `;
  }

  async function claimedIds(): Promise<string[]> {
    const { data, error } = await serviceClient().rpc("claim_due_routines", { p_limit: 50 });
    if (error) throw new Error(error.message);
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  }

  it("skips a routine that only runs when poked", async () => {
    const poked = await seedSourcelessRoutine("Poke only");
    await makeDue(poked, "webhook");

    expect(await claimedIds()).not.toContain(poked);
  });

  it("still claims one that does both", async () => {
    const both = await seedSourcelessRoutine("Poke or schedule");
    await makeDue(both, "both");

    expect(await claimedIds()).toContain(both);
  });

  it("still claims an ordinary scheduled one", async () => {
    const scheduled = await seedWorkspace(owner, "private");
    await makeDue(scheduled.routineId, "schedule");

    expect(await claimedIds()).toContain(scheduled.routineId);
  });

  // The filter is inside the `for update skip locked` sub-select. Outside it,
  // webhook-only rows would be locked and counted against p_limit before being
  // discarded — so a handful of them could starve the scheduled ones out of a
  // tick's batch, silently, on the plan where the batch is four.
  it("does not let poke-only routines eat the batch", async () => {
    const scheduled = await seedWorkspace(owner, "private");
    await makeDue(scheduled.routineId, "schedule");

    for (let i = 0; i < 3; i++) {
      const poked = await seedSourcelessRoutine(`Poke only ${i}`);
      await makeDue(poked, "webhook");
    }

    const { data, error } = await serviceClient().rpc("claim_due_routines", { p_limit: 1 });
    if (error) throw new Error(error.message);
    expect(((data ?? []) as { id: string }[]).map((r) => r.id)).toEqual([scheduled.routineId]);
  });
});
