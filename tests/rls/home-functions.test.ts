/**
 * Home's numbers and feed (0123, 0124), read through the policies.
 *
 * Every function here is a definer, because each counts across threads the
 * caller cannot see. What has to hold is that a count is all that crosses:
 * no title of a private thread, no spend for a member, nothing at all for
 * somebody outside the workspace. And the routine columns 0123 added are the
 * engine's to stamp — who paused a routine is not something a body can claim.
 *
 * The cast: ada is the admin, with an agent shared at `use`, a private routine
 * and a private thread; bora is a member; cem is outside.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";

let ada: TestUser;
let bora: TestUser;
let cem: TestUser;
let agentId: string;
let routineId: string;

beforeAll(async () => {
  ada = await createTestUser("home-ada");
  bora = await createTestUser("home-bora");
  cem = await createTestUser("home-cem");
  const service = serviceClient();

  const { error: joinError } = await service
    .from("workspace_members")
    .insert({ workspace_id: ada.workspaceId, user_id: bora.id, role: "member" });
  if (joinError) throw new Error(`could not add bora: ${joinError.message}`);

  const { data: agent, error: agentError } = await ada.db
    .from("agents")
    .insert({
      workspace_id: ada.workspaceId,
      name: "Research",
      created_by: ada.id,
      workspace_access: "use",
      avatar: "owl",
    })
    .select("id")
    .single();
  if (agentError || !agent) throw new Error(`could not make the agent: ${agentError?.message}`);
  agentId = agent.id as string;

  const { data: channel, error: channelError } = await service
    .from("delivery_channels")
    .insert({
      workspace_id: ada.workspaceId,
      user_id: ada.id,
      kind: "email",
      label: "a••••a@acme.test",
      secret_ciphertext: "not-a-real-ciphertext",
    })
    .select("id")
    .single();
  if (channelError || !channel)
    throw new Error(`could not seed a channel: ${channelError?.message}`);

  const { data: routine, error: routineError } = await ada.db
    .from("routines")
    .insert({
      workspace_id: ada.workspaceId,
      agent_id: agentId,
      user_id: ada.id,
      name: "Weekly competitor brief",
      visibility: "private",
      source_kind: "none",
      source_config: {},
      instruction: "Summarise the week",
      delivery_channel_id: channel.id,
      schedule_cron: "0 9 * * 1",
      timezone: "UTC",
      trigger_kind: "schedule",
      next_run_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (routineError || !routine)
    throw new Error(`could not seed a routine: ${routineError?.message}`);
  routineId = routine.id as string;

  const { error: threadError } = await ada.db.from("chat_sessions").insert({
    agent_id: agentId,
    user_id: ada.id,
    workspace_id: ada.workspaceId,
    visibility: "private",
    title: "A private thread",
  });
  if (threadError) throw new Error(`could not seed a thread: ${threadError.message}`);

  // A failed run, written as the engine writes it.
  const { data: run, error: runThreadError } = await service
    .from("chat_sessions")
    .insert({
      agent_id: agentId,
      user_id: ada.id,
      workspace_id: ada.workspaceId,
      kind: "routine",
      routine_id: routineId,
      visibility: "private",
      title: "Weekly competitor brief",
    })
    .select("id")
    .single();
  if (runThreadError || !run)
    throw new Error(`could not seed a run thread: ${runThreadError?.message}`);
  await service
    .from("messages")
    .insert({ session_id: run.id, role: "assistant", content: "This run failed: 503" });
  const { error: runError } = await service.from("routine_runs").insert({
    routine_id: routineId,
    status: "failed",
    error: "503",
    session_id: run.id,
    finished_at: new Date().toISOString(),
  });
  if (runError) throw new Error(`could not seed a run: ${runError.message}`);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("home_counts and home_agent_threads", () => {
  it("count the team's threads and runs for any member, private ones included", async () => {
    const { data, error } = await bora.db
      .rpc("home_counts", { p_workspace_id: ada.workspaceId, p_days: 7 })
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({ threads_window: 1, runs_total: 1, runs_failed: 1 });

    const threads = await bora.db.rpc("home_agent_threads", { p_workspace_id: ada.workspaceId });
    expect(threads.data).toEqual([{ agent_id: agentId, threads: 1 }]);
  });

  it("answer nothing to somebody outside the workspace", async () => {
    const { error } = await cem.db.rpc("home_counts", { p_workspace_id: ada.workspaceId });
    expect(error?.code).toBe("42501");
  });
});

describe("money and people", () => {
  it("are an admin's", async () => {
    for (const fn of ["workspace_spend_daily", "workspace_threads_by_member"]) {
      const member = await bora.db.rpc(fn, { p_workspace_id: ada.workspaceId });
      expect(member.error?.code, fn).toBe("42501");
      const admin = await ada.db.rpc(fn, { p_workspace_id: ada.workspaceId });
      expect(admin.error, fn).toBeNull();
    }
  });

  it("are counted per member, never with a title", async () => {
    const { data } = await ada.db.rpc("workspace_threads_by_member", {
      p_workspace_id: ada.workspaceId,
    });
    const keys = Object.keys((data as Array<Record<string, unknown>>)[0] ?? {}).sort();
    expect(keys).toEqual(["avatar_url", "name", "threads", "user_id"]);
  });
});

describe("routine runs as threads", () => {
  it("put a failed run in its owner's Needs you, and nowhere for a member of a private routine", async () => {
    const mine = await ada.db.rpc("inbox_rows", {
      p_workspace_id: ada.workspaceId,
      p_filter: "needs_you",
    });
    expect((mine.data as Array<{ needs_kind: string }>).map((r) => r.needs_kind)).toEqual([
      "routine_failed",
    ]);

    const his = await bora.db.rpc("inbox_rows", { p_workspace_id: ada.workspaceId });
    expect(his.data).toEqual([]);
  });

  it("stamp who paused a routine, and refuse a body that claims it", async () => {
    const { data } = await ada.db
      .from("routines")
      .update({ status: "paused" })
      .eq("id", routineId)
      .select("paused_by, paused_at")
      .single();
    expect(data?.paused_by).toBe(ada.id);
    expect(data?.paused_at).not.toBeNull();

    const forged = await ada.db.from("routines").update({ paused_by: bora.id }).eq("id", routineId);
    expect(forged.error).not.toBeNull();
  });
});

describe("workspace_activity", () => {
  it("shows a private routine's run to its owner and not to a member", async () => {
    const own = await ada.db.rpc("workspace_activity", { p_workspace_id: ada.workspaceId });
    expect((own.data as Array<{ action: string }>).map((e) => e.action)).toContain(
      "routine.run_failed",
    );
    const his = await bora.db.rpc("workspace_activity", { p_workspace_id: ada.workspaceId });
    expect((his.data as Array<{ action: string }>).map((e) => e.action)).not.toContain(
      "routine.run_failed",
    );
  });

  it("refuses somebody outside the workspace", async () => {
    const { error } = await cem.db.rpc("workspace_activity", { p_workspace_id: ada.workspaceId });
    expect(error?.code).toBe("42501");
  });
});
