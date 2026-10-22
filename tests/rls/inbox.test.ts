/**
 * The Inbox, read through the policies a browser goes through (0121, 0122).
 *
 * `inbox_rows` and its two siblings are security invoker: they add arithmetic
 * — unread, waiting on you, running — over rows the caller can already read,
 * and must never widen what that is. `session_reads` is one person's reading
 * position and nobody else's, and only for a thread they can open.
 * `active_turns` is the worker's to write and anybody's to read who can see
 * the thread.
 *
 * The cast: ada owns the workspace and two threads in it (one private, one
 * shared); bora is a member with a private thread of his own; cem is outside.
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
let privateThread: string;
let sharedThread: string;
let borasThread: string;

async function thread(user: TestUser, visibility: "private" | "shared", title: string) {
  const { data, error } = await user.db
    .from("chat_sessions")
    .insert({
      agent_id: agentId,
      user_id: user.id,
      workspace_id: ada.workspaceId,
      visibility,
      title,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`could not make a thread: ${error?.message}`);
  return data.id as string;
}

async function reply(sessionId: string, content: string, ask: unknown = null) {
  const { error } = await serviceClient()
    .from("messages")
    .insert({ session_id: sessionId, role: "assistant", content, ask });
  if (error) throw new Error(`could not write a reply: ${error.message}`);
}

type InboxRow = {
  session_id: string;
  unread_count: number;
  needs_kind: string | null;
  needs_replies: unknown;
  running_steps: number | null;
};

async function inbox(user: TestUser, filter = "all"): Promise<InboxRow[]> {
  const { data, error } = await user.db.rpc("inbox_rows", {
    p_workspace_id: ada.workspaceId,
    p_filter: filter,
  });
  if (error) throw new Error(`inbox_rows failed for ${user.email}: ${error.message}`);
  return data as InboxRow[];
}

beforeAll(async () => {
  ada = await createTestUser("inbox-ada");
  bora = await createTestUser("inbox-bora");
  cem = await createTestUser("inbox-cem");

  const { error: joinError } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: ada.workspaceId, user_id: bora.id, role: "member" });
  if (joinError) throw new Error(`could not add bora: ${joinError.message}`);

  const { data, error } = await ada.db
    .from("agents")
    .insert({
      workspace_id: ada.workspaceId,
      name: "Support",
      created_by: ada.id,
      workspace_access: "use",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`could not make the agent: ${error?.message}`);
  agentId = data.id as string;

  privateThread = await thread(ada, "private", "Refund policy");
  sharedThread = await thread(ada, "shared", "Pipeline");
  borasThread = await thread(bora, "private", "Bora's own");

  await reply(privateThread, "Yes, with one condition.");
  await reply(sharedThread, "Ready.", {
    question: "Draft the reply, or is the summary enough?",
    replies: ["Draft the reply", "Summary is enough"],
  });
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("inbox_rows", () => {
  it("lists the threads the caller can see and no others", async () => {
    expect((await inbox(ada)).map((r) => r.session_id).sort()).toEqual(
      [privateThread, sharedThread].sort(),
    );
    expect((await inbox(bora)).map((r) => r.session_id).sort()).toEqual(
      [sharedThread, borasThread].sort(),
    );
    expect(await inbox(cem)).toEqual([]);
  });

  it("marks the owner's unread replies, and the question that waits on them", async () => {
    const rows = await inbox(ada);
    const mine = rows.find((r) => r.session_id === privateThread)!;
    const asked = rows.find((r) => r.session_id === sharedThread)!;
    expect(mine.unread_count).toBe(1);
    expect(asked.needs_kind).toBe("question");
    expect(asked.needs_replies).toEqual(["Draft the reply", "Summary is enough"]);
  });

  it("does not make somebody else's shared thread unread, or wait on them", async () => {
    const shared = (await inbox(bora)).find((r) => r.session_id === sharedThread)!;
    expect(shared.unread_count).toBe(0);
    expect(shared.needs_kind).toBeNull();
  });
});

describe("session_reads", () => {
  it("lets the owner mark a thread read, which clears it", async () => {
    const { error } = await ada.db
      .from("session_reads")
      .upsert(
        { session_id: privateThread, user_id: ada.id, workspace_id: ada.workspaceId },
        { onConflict: "session_id,user_id" },
      );
    expect(error).toBeNull();
    const mine = (await inbox(ada)).find((r) => r.session_id === privateThread)!;
    expect(mine.unread_count).toBe(0);
  });

  it("refuses a read of a thread the caller cannot open, and a row in somebody else's name", async () => {
    const hidden = await bora.db
      .from("session_reads")
      .insert({ session_id: privateThread, user_id: bora.id, workspace_id: ada.workspaceId });
    expect(hidden.error).not.toBeNull();

    const forged = await bora.db
      .from("session_reads")
      .insert({ session_id: sharedThread, user_id: ada.id, workspace_id: ada.workspaceId });
    expect(forged.error).not.toBeNull();
  });

  it("marks everything the caller can see at once, and nothing for an outsider", async () => {
    const { data, error } = await bora.db.rpc("mark_all_sessions_read", {
      p_workspace_id: ada.workspaceId,
    });
    expect(error).toBeNull();
    expect(data).toBe(2);

    const outside = await cem.db.rpc("mark_all_sessions_read", {
      p_workspace_id: ada.workspaceId,
    });
    expect(outside.error?.code).toBe("42501");
  });
});

describe("active_turns", () => {
  it("is written by the worker and read by whoever can see the thread", async () => {
    const { error } = await serviceClient().from("active_turns").insert({
      session_id: privateThread,
      workspace_id: ada.workspaceId,
      agent_id: agentId,
      user_id: ada.id,
      steps_done: 3,
      note: "Reading 6 pages",
    });
    expect(error).toBeNull();

    const running = await inbox(ada, "running");
    expect(running.map((r) => [r.session_id, r.running_steps])).toEqual([[privateThread, 3]]);

    const { data: seenByBora } = await bora.db.from("active_turns").select("session_id");
    expect(seenByBora ?? []).toEqual([]);

    const forged = await ada.db.from("active_turns").insert({
      session_id: sharedThread,
      workspace_id: ada.workspaceId,
      agent_id: agentId,
    });
    expect(forged.error).not.toBeNull();
  });
});
