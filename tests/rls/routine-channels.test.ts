/**
 * The channels a routine delivers to after its primary (0130), and the run
 * totals read beside them.
 *
 * Only somebody who owns both the routine and the channel adds one to the
 * list; only the routine's owner takes one off. A colleague who can see a
 * shared routine sees which channels it names, never what they are. The
 * totals answer for the runs the caller can see, and nothing of a private
 * routine of somebody else's.
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
let routineId: string;
let primary: string;
let extra: string;
let boras: string;

async function channel(user: TestUser, label: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from("delivery_channels")
    .insert({
      workspace_id: ada.workspaceId,
      user_id: user.id,
      kind: "email",
      label,
      secret_ciphertext: "sealed",
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make a channel: ${error.message}`);
  return data.id as string;
}

beforeAll(async () => {
  ada = await createTestUser("channels-ada");
  bora = await createTestUser("channels-bora");
  const service = serviceClient();
  const { error: memberError } = await service
    .from("workspace_members")
    .insert({ workspace_id: ada.workspaceId, user_id: bora.id, role: "member" });
  if (memberError) throw new Error(`could not add bora: ${memberError.message}`);

  const { data: agent, error: agentError } = await ada.db
    .from("agents")
    .insert({
      workspace_id: ada.workspaceId,
      name: "Support",
      created_by: ada.id,
      workspace_access: "use",
    })
    .select("id")
    .single();
  if (agentError) throw new Error(`could not make an agent: ${agentError.message}`);

  primary = await channel(ada, "primary");
  extra = await channel(ada, "extra");
  boras = await channel(bora, "boras");

  const { data: routine, error } = await ada.db
    .from("routines")
    .insert({
      workspace_id: ada.workspaceId,
      agent_id: agent.id,
      user_id: ada.id,
      name: "Digest",
      visibility: "shared",
      source_kind: "none",
      source_config: {},
      instruction: "Summarise the week",
      delivery_channel_id: primary,
      schedule_cron: "0 9 * * *",
      timezone: "UTC",
      next_run_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error) throw new Error(`could not make a routine: ${error.message}`);
  routineId = routine.id as string;
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("a routine's other channels", () => {
  it("takes the owner's own channel and nobody else's", async () => {
    const own = await ada.db
      .from("routine_channels")
      .insert({ routine_id: routineId, delivery_channel_id: extra });
    expect(own.error).toBeNull();

    const theirs = await ada.db
      .from("routine_channels")
      .insert({ routine_id: routineId, delivery_channel_id: boras });
    expect(theirs.error).not.toBeNull();

    const notTheirRoutine = await bora.db
      .from("routine_channels")
      .insert({ routine_id: routineId, delivery_channel_id: boras });
    expect(notTheirRoutine.error).not.toBeNull();
  });

  it("shows a colleague which channels, not what they are, and is not theirs to change", async () => {
    const { data } = await bora.db
      .from("routine_channels")
      .select("delivery_channel_id")
      .eq("routine_id", routineId);
    expect(data).toEqual([{ delivery_channel_id: extra }]);

    const { data: seen } = await bora.db.from("delivery_channels").select("id").eq("id", extra);
    expect(seen ?? []).toEqual([]);

    await bora.db.from("routine_channels").delete().eq("routine_id", routineId);
    const { data: still } = await serviceClient()
      .from("routine_channels")
      .select("delivery_channel_id")
      .eq("routine_id", routineId);
    expect(still).toHaveLength(1);
  });
});

describe("run totals", () => {
  it("count a shared routine's runs for a colleague, and none of a private one", async () => {
    const service = serviceClient();
    const { error } = await service.from("routine_runs").insert([
      {
        routine_id: routineId,
        status: "ok",
        tokens: 1200,
        model: "gpt-4o-mini",
        prompt_tokens: 1000,
        completion_tokens: 200,
        cached_tokens: 0,
        triggered_by: "test",
        finished_at: new Date().toISOString(),
      },
      { routine_id: routineId, status: "failed", tokens: 0, finished_at: new Date().toISOString() },
    ]);
    expect(error).toBeNull();

    const shared = await bora.db.rpc("routine_run_totals", {
      p_workspace_id: ada.workspaceId,
      p_days: 7,
    });
    expect(shared.error).toBeNull();
    const runs = (shared.data as Array<{ runs: number }>).reduce((n, r) => n + r.runs, 0);
    expect(runs).toBe(2);

    await service.from("routines").update({ visibility: "private" }).eq("id", routineId);
    const hidden = await bora.db.rpc("routine_run_totals", {
      p_workspace_id: ada.workspaceId,
      p_days: 7,
    });
    expect(hidden.data ?? []).toEqual([]);
    const last = await bora.db.rpc("routine_last_runs", { p_routine_ids: [routineId] });
    expect(last.data ?? []).toEqual([]);
  });
});
