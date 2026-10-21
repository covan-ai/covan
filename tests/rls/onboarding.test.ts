/**
 * The first run that introduces itself (0119).
 *
 * Two promises are made in Postgres and nowhere else. `finish_onboarding()`
 * makes one agent and one conversation however many times it is called — the
 * old flow made a second agent on a reload, and the function is the fix. And
 * `onboarding_events` is each person's own: written by them, read by them,
 * never changed, never seen by anyone else.
 *
 * The function is security invoker on purpose, so the second half of what is
 * checked here is that the policies still apply through it: a person with no
 * named assistant gets nothing, a person in no workspace cannot put an agent
 * in somebody else's, and nobody can reach another account's row.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient,
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";

let ada: TestUser;
let grace: TestUser;

beforeAll(async () => {
  ada = await createTestUser("ada");
  grace = await createTestUser("grace");
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

type Finished = {
  agent_id: string;
  session_id: string;
  created: boolean;
  was_completed: boolean;
};

async function finish(
  user: TestUser,
  workspaceId = user.workspaceId,
  persona: string | null = null,
) {
  const { data, error } = await user.db.rpc("finish_onboarding", {
    p_workspace_id: workspaceId,
    p_persona: persona,
    p_model: null,
  });
  const rows = (data ?? []) as Finished[];
  return { row: rows[0] ?? null, error };
}

/** Asked as the service role, so RLS cannot mask the answer. */
async function agentsIn(workspaceId: string) {
  const { data } = await serviceClient()
    .from("agents")
    .select("id, name, emoji, persona, mode, web_search, workspace_access, created_by")
    .eq("workspace_id", workspaceId);
  return (data ?? []) as Array<Record<string, unknown>>;
}

async function eventsOf(userId: string) {
  const { data } = await serviceClient()
    .from("onboarding_events")
    .select("step, event")
    .eq("user_id", userId);
  return (data ?? []) as Array<{ step: string; event: string }>;
}

describe("finish_onboarding makes the assistant once", () => {
  let first: Finished;

  beforeAll(async () => {
    const { error } = await ada.db.from("user_onboarding").upsert(
      {
        user_id: ada.id,
        assistant_name: "Desk",
        assistant_emoji: "🧭",
        tools: ["gmail", "notion"],
        purpose: "operations",
        mode: "team",
        last_step: "team",
      },
      { onConflict: "user_id" },
    );
    expect(error).toBeNull();
  });

  it("makes one agent and one private conversation, as the caller", async () => {
    const { row, error } = await finish(ada, ada.workspaceId, "You keep the answers in one place.");
    expect(error).toBeNull();
    expect(row).not.toBeNull();
    first = row!;
    expect(first.created).toBe(true);
    expect(first.was_completed).toBe(false);

    const agents = await agentsIn(ada.workspaceId);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: first.agent_id,
      name: "Desk",
      emoji: "🧭",
      persona: "You keep the answers in one place.",
      mode: "normal",
      web_search: false,
      // "Everyone trains it together": team mode shares at `edit`.
      workspace_access: "edit",
      created_by: ada.id,
    });

    const { data: session } = await serviceClient()
      .from("chat_sessions")
      .select("id, agent_id, user_id, workspace_id, title, kind, visibility")
      .eq("id", first.session_id)
      .maybeSingle();
    expect(session).toMatchObject({
      agent_id: first.agent_id,
      user_id: ada.id,
      workspace_id: ada.workspaceId,
      title: null,
      kind: "chat",
      visibility: "private",
    });
  });

  it("stamps the row and remembers what it made", async () => {
    const { data } = await ada.db
      .from("user_onboarding")
      .select("completed_at, last_step, agent_id, session_id")
      .eq("user_id", ada.id)
      .single();
    expect(data?.completed_at).not.toBeNull();
    expect(data).toMatchObject({
      last_step: "done",
      agent_id: first.agent_id,
      session_id: first.session_id,
    });
  });

  it("records the arrival once", async () => {
    expect(await eventsOf(ada.id)).toEqual([{ step: "finish", event: "completed" }]);
  });

  // The reload of the last screen, and the double tap.
  it("hands back the same two ids the second time, and makes nothing", async () => {
    const { row, error } = await finish(ada);
    expect(error).toBeNull();
    expect(row).toMatchObject({
      agent_id: first.agent_id,
      session_id: first.session_id,
      created: false,
      was_completed: true,
    });

    expect(await agentsIn(ada.workspaceId)).toHaveLength(1);
    expect(await eventsOf(ada.id)).toHaveLength(1);
  });

  // Two taps that land together wait on the row lock, and the second finds
  // what the first made.
  it("survives two calls at once", async () => {
    const [a, b] = await Promise.all([finish(ada), finish(ada)]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(a.row?.agent_id).toBe(first.agent_id);
    expect(b.row?.agent_id).toBe(first.agent_id);
    expect(await agentsIn(ada.workspaceId)).toHaveLength(1);
  });

  // An agent in the trash is invisible to the select policy, so the row's
  // pointer finds nothing and a fresh one is made — without a second welcome.
  it("replaces an agent that went to the trash, and does not count it as a second arrival", async () => {
    const { error: trashError } = await ada.db.rpc("soft_delete_agent", {
      p_agent_id: first.agent_id,
    });
    expect(trashError).toBeNull();

    const { row, error } = await finish(ada);
    expect(error).toBeNull();
    expect(row?.created).toBe(true);
    expect(row?.was_completed).toBe(true);
    expect(row?.agent_id).not.toBe(first.agent_id);
    expect(row?.session_id).not.toBe(first.session_id);

    expect(await eventsOf(ada.id)).toHaveLength(1);
  });
});

describe("finish_onboarding keeps to the policies", () => {
  it("refuses a run that has not named its assistant", async () => {
    const { row, error } = await finish(grace);
    expect(row).toBeNull();
    expect(error?.code).toBe("P0002");
    expect(await agentsIn(grace.workspaceId)).toHaveLength(0);
  });

  it("cannot put the agent in a workspace the caller is not in", async () => {
    const { error: upsertError } = await grace.db
      .from("user_onboarding")
      .upsert(
        { user_id: grace.id, assistant_name: "Scout", mode: "solo" },
        { onConflict: "user_id" },
      );
    expect(upsertError).toBeNull();

    const { row, error } = await finish(grace, ada.workspaceId);
    expect(row).toBeNull();
    expect(error).not.toBeNull();
    // Nothing landed on either side, and grace's row was not stamped.
    expect((await agentsIn(ada.workspaceId)).map((a) => a.created_by)).not.toContain(grace.id);
    const { data } = await grace.db
      .from("user_onboarding")
      .select("completed_at, agent_id")
      .eq("user_id", grace.id)
      .single();
    expect(data).toMatchObject({ completed_at: null, agent_id: null });
  });

  it("keeps a solo assistant private", async () => {
    const { row, error } = await finish(grace);
    expect(error).toBeNull();
    const agents = await agentsIn(grace.workspaceId);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: row?.agent_id, workspace_access: null });
  });

  it("is nobody else's row to change", async () => {
    const { data, error } = await grace.db
      .from("user_onboarding")
      .update({ assistant_name: "Hijacked" })
      .eq("user_id", ada.id)
      .select("user_id");
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);

    const { data: adaRow } = await serviceClient()
      .from("user_onboarding")
      .select("assistant_name")
      .eq("user_id", ada.id)
      .single();
    expect(adaRow?.assistant_name).toBe("Desk");
  });

  it("is not callable by the public internet", async () => {
    const { error } = await anonClient().rpc("finish_onboarding", {
      p_workspace_id: ada.workspaceId,
      p_persona: null,
      p_model: null,
    });
    expect(error).not.toBeNull();
  });
});

describe("onboarding_events are each person's own", () => {
  const at = new Date().toISOString();

  it("takes a person's own events and reads them back", async () => {
    const { error } = await ada.db.from("onboarding_events").insert([
      { user_id: ada.id, step: "intro:documents", event: "viewed", at },
      { user_id: ada.id, step: "intro:documents", event: "completed", at, elapsed_ms: 3200 },
    ]);
    expect(error).toBeNull();

    const { data } = await ada.db
      .from("onboarding_events")
      .select("step, event, elapsed_ms")
      .eq("step", "intro:documents");
    expect(data).toHaveLength(2);
  });

  it("refuses an event written under somebody else's id", async () => {
    const { error } = await ada.db
      .from("onboarding_events")
      .insert({ user_id: grace.id, step: "tools", event: "skipped", at });
    expect(error).not.toBeNull();
    expect(await eventsOf(grace.id)).toEqual([]);
  });

  it("shows nobody else's", async () => {
    const { data } = await grace.db.from("onboarding_events").select("id").eq("user_id", ada.id);
    expect(data ?? []).toHaveLength(0);
  });

  it("cannot be changed or removed, even by their owner", async () => {
    const before = (await eventsOf(ada.id)).length;

    const { data: updated } = await ada.db
      .from("onboarding_events")
      .update({ event: "skipped" })
      .eq("user_id", ada.id)
      .select("id");
    expect(updated ?? []).toHaveLength(0);

    const { data: deleted } = await ada.db
      .from("onboarding_events")
      .delete()
      .eq("user_id", ada.id)
      .select("id");
    expect(deleted ?? []).toHaveLength(0);

    expect((await eventsOf(ada.id)).length).toBe(before);
  });

  // The same batch sent twice — a retry after a dropped connection — lands once.
  it("counts a retried batch once", async () => {
    const clientId = crypto.randomUUID();
    const row = { user_id: ada.id, client_id: clientId, step: "mode", event: "viewed", at };

    for (let i = 0; i < 2; i++) {
      const { error } = await ada.db
        .from("onboarding_events")
        .upsert(row, { onConflict: "user_id,client_id", ignoreDuplicates: true });
      expect(error).toBeNull();
    }

    const { data } = await ada.db.from("onboarding_events").select("id").eq("client_id", clientId);
    expect(data).toHaveLength(1);
  });

  it("is closed to the public internet", async () => {
    const { data } = await anonClient().from("onboarding_events").select("id");
    expect(data ?? []).toHaveLength(0);
    const { error } = await anonClient()
      .from("onboarding_events")
      .insert({ user_id: ada.id, step: "mode", event: "viewed", at });
    expect(error).not.toBeNull();
  });
});
