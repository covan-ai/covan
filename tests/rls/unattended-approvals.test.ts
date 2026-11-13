/**
 * Who may see and answer what an agent asked while nobody was watching (0143).
 *
 * A routine's request is the team's: its owner answers it, and so may an
 * admin of the workspace, because the owner may be asleep when the mail that
 * set it off arrives. Nothing else widens. A conversation's question and a
 * woken conversation's are somebody's own conversation, so an admin neither
 * sees nor answers them; a plain member and a viewer see and answer none of
 * it; another workspace's admin, and an API key, see nothing at all.
 *
 * The answer is `answer_approval`, a definer function, and these tests are
 * what make that function the boundary rather than the route in front of it.
 * The cron's three functions are the service role's alone.
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

/** Created the workspace, so its admin. */
let admin: TestUser;
/** A member, whose routine asked. */
let owner: TestUser;
let member: TestUser;
let viewer: TestUser;
/** The admin of a workspace of their own. */
let outsider: TestUser;
let seeded: Seeded;

let conversationId: string;
let replyId: string;
let routineId: string;
let runId: string;
const pauses: Record<string, string> = {};

const service = () => serviceClient();

async function seedPause(name: string, over: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await service()
    .from("paused_turns")
    .insert({
      session_id: conversationId,
      message_id: replyId,
      workspace_id: admin.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      tool: "http_request",
      tool_call: { id: `call_${name}`, name: "http_request", arguments: "{}" },
      summary: `POST to Box office (${name})?`,
      proposal: { method: "POST", path: "/seats/14/close" },
      messages: [{ role: "system", content: "the whole prompt, which no client reads" }],
      model: "gpt-4.1",
      origin: "routine",
      routine_run_id: runId,
      expires_at: new Date(Date.now() + 24 * 3_600_000).toISOString(),
      ...over,
    })
    .select("id")
    .single();
  if (error) throw new Error(`seeding paused turn ${name} failed: ${error.message}`);
  pauses[name] = data.id as string;
  return data.id as string;
}

beforeAll(async () => {
  admin = await createTestUser("approvals-admin");
  owner = await createTestUser("approvals-owner");
  member = await createTestUser("approvals-member");
  viewer = await createTestUser("approvals-viewer");
  outsider = await createTestUser("approvals-outsider");

  const { error: joinError } = await service()
    .from("workspace_members")
    .insert([
      { workspace_id: admin.workspaceId, user_id: owner.id, role: "member" },
      { workspace_id: admin.workspaceId, user_id: member.id, role: "member" },
      { workspace_id: admin.workspaceId, user_id: viewer.id, role: "viewer" },
    ]);
  if (joinError) throw new Error(`seeding members failed: ${joinError.message}`);

  seeded = await seedWorkspace(admin, "shared");

  // The routine's own conversation (`openRoutineConversation`): the owner's,
  // private, opened by the engine with the service role.
  const { data: conversation, error: conversationError } = await service()
    .from("chat_sessions")
    .insert({
      agent_id: seeded.agentId,
      user_id: owner.id,
      workspace_id: admin.workspaceId,
      title: "Routine: Seat requests",
      kind: "chat",
      visibility: "private",
    })
    .select("id")
    .single();
  if (conversationError) throw new Error(`seeding conversation: ${conversationError.message}`);
  conversationId = conversation.id as string;

  const { data: reply, error: replyError } = await service()
    .from("messages")
    .insert({ session_id: conversationId, role: "assistant", content: "A mail asked for seat 14." })
    .select("id")
    .single();
  if (replyError) throw new Error(`seeding reply: ${replyError.message}`);
  replyId = reply.id as string;

  const { data: channel, error: channelError } = await service()
    .from("delivery_channels")
    .insert({
      workspace_id: admin.workspaceId,
      user_id: owner.id,
      kind: "email",
      label: "o••••r@covan.test",
      secret_ciphertext: "not-a-real-ciphertext",
    })
    .select("id")
    .single();
  if (channelError) throw new Error(`seeding channel: ${channelError.message}`);

  const { data: routine, error: routineError } = await service()
    .from("routines")
    .insert({
      workspace_id: admin.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      name: "Seat requests",
      visibility: "private",
      source_kind: "none",
      source_config: {},
      instruction: "Close the seat a mail asks about",
      delivery_channel_id: channel.id,
      schedule_cron: "0 9 * * 1",
      timezone: "UTC",
      next_run_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (routineError) throw new Error(`seeding routine: ${routineError.message}`);
  routineId = routine.id as string;

  const { data: run, error: runError } = await service()
    .from("routine_runs")
    .insert({ routine_id: routineId, status: "waiting", waiting_for: "approval" })
    .select("id")
    .single();
  if (runError) throw new Error(`seeding run: ${runError.message}`);
  runId = run.id as string;

  await seedPause("routine");
  await seedPause("own");
  await seedPause("chat", { origin: "chat", routine_run_id: null });
  await seedPause("wake", { origin: "wake", routine_run_id: null });
  await seedPause("expired", { expires_at: new Date(Date.now() - 60_000).toISOString() });
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

const visible = async (who: TestUser) => {
  const { data, error } = await who.db
    .from("paused_turns")
    .select("id, summary, proposal")
    .in("id", Object.values(pauses));
  expect(error, who.email).toBeNull();
  return new Set((data ?? []).map((row) => row.id as string));
};

describe("seeing a request", () => {
  it("shows the owner every request of theirs", async () => {
    const seen = await visible(owner);
    for (const name of ["routine", "own", "chat", "wake", "expired"]) {
      expect(seen.has(pauses[name]), name).toBe(true);
    }
  });

  it("shows an admin a routine's request, and nobody's conversation", async () => {
    const seen = await visible(admin);
    expect(seen.has(pauses.routine)).toBe(true);
    expect(seen.has(pauses.chat)).toBe(false);
    expect(seen.has(pauses.wake)).toBe(false);
  });

  it("shows a plain member, a viewer and another workspace's admin nothing", async () => {
    for (const who of [member, viewer, outsider]) {
      expect((await visible(who)).size, who.email).toBe(0);
    }
  });

  /** The admin agrees to the sentence and the arguments, never the prompt. */
  it("hands an admin neither the prompt nor the raw call", async () => {
    for (const column of ["messages", "tool_call"]) {
      const { error } = await admin.db.from("paused_turns").select(column).eq("id", pauses.routine);
      expect(error, column).not.toBeNull();
    }
  });

  it("does not let an admin into the routine's conversation", async () => {
    const { data } = await admin.db.from("messages").select("id").eq("session_id", conversationId);
    expect(data ?? []).toEqual([]);
  });
});

describe("answer_approval", () => {
  const answer = (who: TestUser, name: string, approve = true) =>
    who.db.rpc("answer_approval", { p_id: pauses[name], p_approve: approve });

  it("refuses a plain member and a viewer, and tells an outsider there is nothing", async () => {
    expect((await answer(member, "routine")).error?.code).toBe("42501");
    expect((await answer(viewer, "routine")).error?.code).toBe("42501");
    expect((await answer(outsider, "routine")).error?.code).toBe("P0002");
  });

  it("refuses an admin a conversation's question and a woken conversation's", async () => {
    expect((await answer(admin, "chat")).error?.code).toBe("42501");
    expect((await answer(admin, "wake")).error?.code).toBe("42501");
  });

  it("sends a conversation's question back to its conversation", async () => {
    expect((await answer(owner, "chat")).error?.code).toBe("22023");
  });

  it("lets an admin answer a routine's request, once, and records who", async () => {
    const first = await answer(admin, "routine");
    expect(first.error).toBeNull();
    expect(first.data).toBe("approved");

    // The second answer, from the owner in another tab, changes nothing.
    const second = await answer(owner, "routine", false);
    expect(second.error).toBeNull();
    expect(second.data).toBe("already");

    const { data: row } = await service()
      .from("paused_turns")
      .select("status, resolved_by, resolved_via, resolved_at")
      .eq("id", pauses.routine)
      .single();
    expect(row).toMatchObject({ status: "approved", resolved_by: admin.id, resolved_via: "app" });
    expect(row?.resolved_at).not.toBeNull();
  });

  it("lets the owner answer their own", async () => {
    const { data, error } = await answer(owner, "own", false);
    expect(error).toBeNull();
    expect(data).toBe("declined");
  });

  it("refuses an answer that came after the day was over", async () => {
    const { data, error } = await answer(owner, "expired");
    expect(error).toBeNull();
    expect(data).toBe("expired");
  });

  /** A key's token carries its workspace as `covan_ws`; a yes is a person's. */
  it("refuses an API key, even the owner's own", async () => {
    const claims = JSON.stringify({
      sub: owner.id,
      role: "authenticated",
      covan_ws: admin.workspaceId,
    });
    const id = await seedPause("by-key");
    let code: string | undefined;
    try {
      await sql().begin(async (tx) => {
        await tx`select set_config('request.jwt.claims', ${claims}, true)`;
        await tx`set local role authenticated`;
        await tx`select public.answer_approval(${id}::uuid, true)`;
      });
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).toBe("42501");
  });
});

describe("the cron's functions", () => {
  it("are callable by no client role", async () => {
    for (const who of [owner, admin]) {
      const claim = await who.db.rpc("claim_answered_approvals", { p_limit: 1 });
      expect(claim.error, `claim as ${who.email}`).not.toBeNull();
      const expire = await who.db.rpc("expire_unattended_approvals", { p_limit: 1 });
      expect(expire.error, `expire as ${who.email}`).not.toBeNull();
      const asOwner = await who.db.rpc("answer_approval_as", {
        p_id: pauses.wake,
        p_user_id: owner.id,
        p_approve: true,
      });
      expect(asOwner.error, `answer_approval_as as ${who.email}`).not.toBeNull();
      const internal = await who.db.rpc("answer_approval_for", {
        p_id: pauses.wake,
        p_user_id: owner.id,
        p_approve: true,
        p_via: "app",
      });
      expect(internal.error, `answer_approval_for as ${who.email}`).not.toBeNull();
    }
  });

  it("hand an answered request to the cron once, and never again", async () => {
    const first = await service().rpc("claim_answered_approvals", { p_limit: 10 });
    expect(first.error).toBeNull();
    const ids = (first.data as Array<{ id: string }>).map((row) => row.id);
    expect(ids).toEqual(expect.arrayContaining([pauses.routine, pauses.own]));

    const again = await service().rpc("claim_answered_approvals", { p_limit: 10 });
    const twice = (again.data as Array<{ id: string }>).map((row) => row.id);
    expect(twice).not.toContain(pauses.routine);
    expect(twice).not.toContain(pauses.own);
  });

  it("end a request nobody answered, and report a resume that never came back", async () => {
    // The yes the cron claimed above, as if its resume died twenty minutes ago.
    await service()
      .from("paused_turns")
      .update({ resume_attempted_at: new Date(Date.now() - 20 * 60_000).toISOString() })
      .eq("id", pauses.routine);

    const { data, error } = await service().rpc("expire_unattended_approvals", { p_limit: 20 });
    expect(error).toBeNull();
    const rows = data as Array<{ id: string; reason: string; routine_run_id: string | null }>;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: pauses.expired, reason: "expired", routine_run_id: runId }),
        expect.objectContaining({ id: pauses.routine, reason: "interrupted" }),
      ]),
    );

    const { data: after } = await service()
      .from("paused_turns")
      .select("id, status, resumed_at")
      .in("id", [pauses.expired, pauses.routine]);
    for (const row of after ?? []) expect(row.resumed_at, row.id as string).not.toBeNull();
    expect((after ?? []).find((row) => row.id === pauses.expired)?.status).toBe("expired");

    // Each is reported once.
    const again = await service().rpc("expire_unattended_approvals", { p_limit: 20 });
    const ids = (again.data as Array<{ id: string }>).map((row) => row.id);
    expect(ids).not.toContain(pauses.expired);
    expect(ids).not.toContain(pauses.routine);
  });

  it("let the email's door answer as the owner, and only the service role open it", async () => {
    const { data, error } = await service().rpc("answer_approval_as", {
      p_id: pauses.wake,
      p_user_id: owner.id,
      p_approve: true,
    });
    expect(error).toBeNull();
    expect(data).toBe("approved");
    const { data: row } = await service()
      .from("paused_turns")
      .select("resolved_via, resolved_by")
      .eq("id", pauses.wake)
      .single();
    expect(row).toMatchObject({ resolved_via: "reply", resolved_by: owner.id });
  });
});

/**
 * What puts a routine's request in front of an admin (0146): the list, with
 * whose routine and which, and the count beside the Inbox.
 */
describe("delegated_approvals", () => {
  let delegatedId: string;
  beforeAll(async () => {
    delegatedId = await seedPause("delegated");
  });

  const list = async (who: TestUser) => {
    const { data, error } = await who.db.rpc("delegated_approvals", {
      p_workspace_id: admin.workspaceId,
    });
    expect(error, who.email).toBeNull();
    return (data ?? []) as Array<Record<string, unknown>>;
  };

  it("shows an admin somebody else's routine request, with the names around it", async () => {
    const rows = await list(admin);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: delegatedId,
          owner_id: owner.id,
          routine_name: "Seat requests",
          summary: "POST to Box office (delegated)?",
        }),
      ]),
    );
    // Nothing of the conversation, the prompt or the call.
    for (const row of rows) {
      expect(row).not.toHaveProperty("messages");
      expect(row).not.toHaveProperty("tool_call");
      expect(row).not.toHaveProperty("session_id");
    }
    // Answered, expired and conversation questions are not listed.
    const ids = rows.map((row) => row.id);
    for (const name of ["routine", "expired", "chat", "wake"]) {
      expect(ids, name).not.toContain(pauses[name]);
    }
  });

  it("is empty for the owner, a plain member, a viewer and another workspace's admin", async () => {
    for (const who of [owner, member, viewer, outsider]) {
      expect(await list(who), who.email).toEqual([]);
    }
  });

  it("counts towards an admin's Needs you", async () => {
    const { data, error } = await admin.db.rpc("inbox_counts", {
      p_workspace_id: admin.workspaceId,
    });
    expect(error).toBeNull();
    const forAgent = (data as Array<{ agent_id: string; needs_you: number }>).find(
      (row) => row.agent_id === seeded.agentId,
    );
    expect(forAgent?.needs_you).toBeGreaterThanOrEqual(1);

    const plain = await member.db.rpc("inbox_counts", { p_workspace_id: admin.workspaceId });
    const theirs = (plain.data as Array<{ agent_id: string; needs_you: number }>).find(
      (row) => row.agent_id === seeded.agentId,
    );
    expect(theirs?.needs_you ?? 0).toBe(0);
  });
});

describe("routine_runs", () => {
  it("say what a waiting run waits for", async () => {
    const { data } = await service()
      .from("routine_runs")
      .select("waiting_for, held_until")
      .eq("id", runId)
      .single();
    expect(data?.waiting_for).toBe("approval");
  });

  it("refuse a run kept on a conversation's question", async () => {
    const { error } = await service()
      .from("paused_turns")
      .insert({
        session_id: conversationId,
        workspace_id: admin.workspaceId,
        agent_id: seeded.agentId,
        user_id: owner.id,
        tool: "http_request",
        tool_call: { id: "x", name: "http_request", arguments: "{}" },
        summary: "?",
        messages: [],
        origin: "chat",
        routine_run_id: runId,
      });
    expect(error).not.toBeNull();
  });
});
