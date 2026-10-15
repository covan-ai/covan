/**
 * What the database says about a routine that waits for an event (0108).
 *
 * The table exists for `routine_triggers`' reason, with more at stake: the row
 * holds a third party's id for an arrangement this deployment made with its
 * own provider keys, and sometimes a bot token. Had any of it been a column on
 * `routines`, 0023's table-level grants would have shown it to every colleague
 * on a shared routine and let its owner rewrite it. So the argument for the
 * table is entirely about grants and policies, which only a real database can
 * prove.
 *
 * The other half is the three functions: `claim_due_routines` must not hand
 * the scheduler a routine that is never due, `claim_event_subscriptions` must
 * find exactly the rows out of step with their routines, and
 * `count_routine_event` must stop a burst at the limit. All three are SQL, and
 * none of them is visible to a unit test.
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
let waiting: string;

/** An event routine has no source of its own (0108 widens 0055's rule). */
async function seedEventRoutine(name: string, visibility = "private"): Promise<string> {
  const { data, error } = await owner.db
    .from("routines")
    .insert({
      workspace_id: owner.workspaceId,
      agent_id: shared.agentId,
      user_id: owner.id,
      name,
      visibility,
      source_kind: "none",
      source_config: {},
      instruction: "tell me what matters",
      delivery_channel_id: shared.channelId,
      schedule_cron: "0 9 * * *",
      trigger_kind: "event",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`seeding an event routine failed: ${error?.message}`);
  return data.id as string;
}

/** Only the engine writes these, so the fixture does too. */
async function subscribe(routineId: string, over: Record<string, unknown> = {}) {
  const { error } = await serviceClient()
    .from("routine_event_subscriptions")
    .upsert(
      {
        routine_id: routineId,
        provider: "composio",
        event_type: "gmail.new_message",
        config: { query: "is:unread" },
        external_id: `ti_${routineId.slice(0, 8)}`,
        secret_ciphertext: "v1.sealed.secret",
        state: { cursor: "abc" },
        status: "active",
        ...over,
      },
      { onConflict: "routine_id" },
    );
  if (error) throw new Error(`seeding routine_event_subscriptions failed: ${error.message}`);
}

beforeAll(async () => {
  owner = await createTestUser("events-owner");
  colleague = await createTestUser("events-colleague");
  shared = await seedWorkspace(owner, "shared");

  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: owner.workspaceId, user_id: colleague.id, role: "member" });
  if (error) throw new Error(`could not add the colleague: ${error.message}`);

  waiting = await seedEventRoutine("Inbox", "shared");
  await subscribe(waiting);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("the subscription row", () => {
  it("shows its owner what they chose and how it stands", async () => {
    const { data, error } = await owner.db
      .from("routine_event_subscriptions")
      .select("routine_id, provider, event_type, config, status, status_detail, last_event_at")
      .eq("routine_id", waiting)
      .single();

    expect(error).toBeNull();
    expect(data).toMatchObject({
      provider: "composio",
      event_type: "gmail.new_message",
      config: { query: "is:unread" },
      status: "active",
    });
  });

  it.each(["external_id", "secret_ciphertext", "state", "hour_count", "attempts"])(
    "never shows anybody %s",
    async (column) => {
      const { error } = await owner.db
        .from("routine_event_subscriptions")
        .select(`routine_id, ${column}`)
        .eq("routine_id", waiting);

      expect(error?.code).toBe("42501");
    },
  );

  // `*` expands to every column, the withheld ones included, so the whole read
  // is refused rather than quietly trimmed — `routine-triggers.test.ts` says
  // why that is the stricter answer.
  it("is not reachable by asking for everything either", async () => {
    const { error } = await owner.db
      .from("routine_event_subscriptions")
      .select("*")
      .eq("routine_id", waiting);

    expect(error?.code).toBe("42501");
  });

  // Sharing a routine shares what it does, not which inbox it listens to.
  it("is invisible to a colleague, even on a shared routine", async () => {
    const { data: routine } = await colleague.db
      .from("routines")
      .select("id")
      .eq("id", waiting)
      .maybeSingle();
    expect(routine?.id).toBe(waiting);

    const { data } = await colleague.db
      .from("routine_event_subscriptions")
      .select("routine_id")
      .eq("routine_id", waiting);
    expect(data).toEqual([]);
  });

  it("comes back embedded in the owner's routine, and as nothing in a colleague's", async () => {
    const select =
      "id, event:routine_event_subscriptions(provider, event_type, config, status, status_detail, last_event_at, expires_at)";
    const { data: mine } = await owner.db
      .from("routines")
      .select(select)
      .eq("id", waiting)
      .single();
    expect(mine?.event).toMatchObject({ event_type: "gmail.new_message" });

    const { data: theirs } = await colleague.db
      .from("routines")
      .select(select)
      .eq("id", waiting)
      .single();
    expect(theirs?.event ?? null).toBeNull();
  });

  // The takeover 0055 describes for a token hash: an owner who can rewrite
  // their own row's provider id can point it at somebody else's arrangement.
  it("cannot be rewritten by its owner", async () => {
    const { error } = await owner.db
      .from("routine_event_subscriptions")
      .update({ external_id: "ti_somebody_elses" })
      .eq("routine_id", waiting);

    expect(error?.code).toBe("42501");
  });

  it("cannot be made by its owner", async () => {
    const other = await seedEventRoutine("Unsubscribed");
    const { error } = await owner.db.from("routine_event_subscriptions").insert({
      routine_id: other,
      provider: "composio",
      event_type: "gmail.new_message",
    });

    expect(error).not.toBeNull();
  });

  // Unlike a webhook trigger, which a client may delete: a row deleted here
  // would leave the arrangement running at the provider with nothing to name
  // it. Stopping goes through the API, which unsubscribes first.
  it("cannot be deleted by its owner", async () => {
    const { error } = await owner.db
      .from("routine_event_subscriptions")
      .delete()
      .eq("routine_id", waiting);

    expect(error?.code).toBe("42501");
  });

  it("goes with its routine", async () => {
    const doomed = await seedEventRoutine("Doomed");
    await subscribe(doomed);

    await serviceClient().from("routines").delete().eq("id", doomed);

    const { data } = await serviceClient()
      .from("routine_event_subscriptions")
      .select("routine_id")
      .eq("routine_id", doomed);
    expect(data).toEqual([]);
  });
});

describe("trigger_kind = 'event'", () => {
  // The seeded routine is source_kind 'web'.
  it("is refused on a routine that watches something", async () => {
    const { error } = await owner.db
      .from("routines")
      .update({ trigger_kind: "event" })
      .eq("id", shared.routineId);

    expect(error).not.toBeNull();
  });

  it("is accepted on a routine with no source", async () => {
    const { data } = await owner.db
      .from("routines")
      .select("trigger_kind")
      .eq("id", waiting)
      .single();
    expect(data?.trigger_kind).toBe("event");
  });

  it("is never claimed by the scheduler", async () => {
    await sql()`
      update public.routines
      set status = 'active', claimed_at = null, next_run_at = now() - interval '1 minute'
      where id = ${waiting}
    `;
    const { data, error } = await serviceClient().rpc("claim_due_routines", { p_limit: 50 });
    if (error) throw new Error(error.message);
    expect(((data ?? []) as { id: string }[]).map((r) => r.id)).not.toContain(waiting);
  });
});

describe("claim_event_subscriptions", () => {
  async function claimed(): Promise<string[]> {
    const { data, error } = await serviceClient().rpc("claim_event_subscriptions", {
      p_limit: 50,
    });
    if (error) throw new Error(error.message);
    return ((data ?? []) as { routine_id: string }[]).map((r) => r.routine_id);
  }

  it("hands out a pending row that is due", async () => {
    const id = await seedEventRoutine("Pending");
    await subscribe(id, { status: "pending", external_id: null, next_attempt_at: null });
    expect(await claimed()).toContain(id);
  });

  // A lease, so a second tick does not subscribe the same row twice.
  it("does not hand the same row out twice inside its lease", async () => {
    const id = await seedEventRoutine("Leased");
    await subscribe(id, { status: "failed", next_attempt_at: null });
    expect(await claimed()).toContain(id);
    expect(await claimed()).not.toContain(id);
  });

  it("waits out a failed row's back-off", async () => {
    const id = await seedEventRoutine("Backing off");
    await subscribe(id, {
      status: "failed",
      next_attempt_at: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(await claimed()).not.toContain(id);
  });

  it("hands out an active row whose routine was paused, so the provider is told", async () => {
    const id = await seedEventRoutine("Paused");
    await subscribe(id);
    await sql()`update public.routines set status = 'paused' where id = ${id}`;
    expect(await claimed()).toContain(id);
  });

  it("hands out a disabled row whose routine is running again", async () => {
    const id = await seedEventRoutine("Restored");
    await subscribe(id, { status: "disabled" });
    expect(await claimed()).toContain(id);
  });

  it("hands out an active row about to lapse", async () => {
    const id = await seedEventRoutine("Lapsing");
    await subscribe(id, { expires_at: new Date(Date.now() + 60 * 60_000).toISOString() });
    expect(await claimed()).toContain(id);
  });

  it("leaves a healthy row alone", async () => {
    const id = await seedEventRoutine("Healthy");
    await subscribe(id, { expires_at: new Date(Date.now() + 5 * 86_400_000).toISOString() });
    expect(await claimed()).not.toContain(id);
  });

  it("leaves an expired row for a person", async () => {
    const id = await seedEventRoutine("Expired");
    await subscribe(id, { status: "expired" });
    expect(await claimed()).not.toContain(id);
  });

  it("is not callable by a signed-in client", async () => {
    const { error } = await owner.db.rpc("claim_event_subscriptions", { p_limit: 1 });
    expect(error).not.toBeNull();
  });
});

describe("count_routine_event", () => {
  async function count(routineId: string, perHour = 3, perDay = 5): Promise<string> {
    const { data, error } = await serviceClient().rpc("count_routine_event", {
      p_routine_id: routineId,
      p_per_hour: perHour,
      p_per_day: perDay,
    });
    if (error) throw new Error(error.message);
    return data as string;
  }

  it("stops a burst at the hourly limit", async () => {
    const id = await seedEventRoutine("Burst");
    await subscribe(id);

    const verdicts = [];
    for (let i = 0; i < 4; i++) verdicts.push(await count(id));
    expect(verdicts).toEqual(["ok", "ok", "ok", "hour"]);
  });

  it("stops at the daily limit once the hours have reset", async () => {
    const id = await seedEventRoutine("Daily");
    await subscribe(id, {
      hour_started_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      hour_count: 3,
      day_started_at: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
      day_count: 5,
    });

    expect(await count(id)).toBe("day");
  });

  it("starts a new hour once the old one has passed", async () => {
    const id = await seedEventRoutine("Quiet hour");
    await subscribe(id, {
      hour_started_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      hour_count: 3,
    });

    expect(await count(id)).toBe("ok");
  });

  // A routine paused for a flood should say when it last ran, not when the
  // flood last knocked.
  it("stamps last_event_at only on an event it lets through", async () => {
    const id = await seedEventRoutine("Stamped");
    await subscribe(id, { last_event_at: null });

    await count(id, 0, 5);
    const [refused] = await sql()`
      select last_event_at from public.routine_event_subscriptions where routine_id = ${id}
    `;
    expect(refused.last_event_at).toBeNull();

    await count(id, 3, 5);
    const [allowed] = await sql()`
      select last_event_at from public.routine_event_subscriptions where routine_id = ${id}
    `;
    expect(allowed.last_event_at).not.toBeNull();
  });

  it("answers missing for a routine with no subscription", async () => {
    expect(await count("00000000-0000-4000-8000-000000000000")).toBe("missing");
  });

  it("is not callable by a signed-in client", async () => {
    const { error } = await owner.db.rpc("count_routine_event", {
      p_routine_id: waiting,
      p_per_hour: 1000,
      p_per_day: 1000,
    });
    expect(error).not.toBeNull();
  });
});

describe("routine_runs.triggered_by", () => {
  async function insertRun(triggeredBy: string | null) {
    return serviceClient()
      .from("routine_runs")
      .insert({ routine_id: waiting, status: "ok", triggered_by: triggeredBy });
  }

  it.each(["schedule", "manual", "webhook", "event", "reply"])("accepts %s", async (value) => {
    const { error } = await insertRun(value);
    expect(error).toBeNull();
  });

  it("refuses a value nobody implemented", async () => {
    const { error } = await insertRun("carrier_pigeon");
    expect(error).not.toBeNull();
  });

  it("is readable wherever the run is", async () => {
    const { data, error } = await colleague.db
      .from("routine_runs")
      .select("triggered_by, trigger_label")
      .eq("routine_id", waiting)
      .limit(1);
    expect(error).toBeNull();
    expect(data?.length).toBe(1);
  });
});
