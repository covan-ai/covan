/**
 * Who may put an answer aside, and who may bring one back.
 *
 * `original_message_id` and `superseded_at` (0050) are what make regenerating
 * a reply non-destructive: the old answer stops showing instead of being
 * deleted, and the version picker brings it back. Both columns describe a
 * *reply*, and replies are server-authoritative — 0009 and 0031 pin a member's
 * insert and update to `role = 'user'`, so nothing a client sends can write an
 * assistant row at all.
 *
 * Which leaves the one row a member *is* allowed to write: their own question.
 * Without the role half of `messages_version_valid` they could mark it
 * superseded and quietly take their own turn out of a transcript a colleague
 * is reading, or point it at an answer and put a question inside a version
 * chain. The constraint is the security half; this is the file that says so.
 *
 * `show_message_version` is the other half. It is SECURITY DEFINER because the
 * write crosses rows no client may write, so the permission check lives inside
 * it — and a function that bypasses RLS is exactly the kind of thing that has
 * to be proved against a real database rather than read.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

let owner: TestUser;
let stranger: TestUser;
let seeded: Seeded;
let sessionId: string;

async function seedSession(): Promise<string> {
  const { data, error } = await owner.db
    .from("chat_sessions")
    .insert({
      agent_id: seeded.agentId,
      user_id: owner.id,
      workspace_id: owner.workspaceId,
      visibility: "private",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`could not seed a session: ${error?.message}`);
  return data.id as string;
}

/** A reply, written the only way a reply is ever written. */
async function seedReply(content: string, root?: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from("messages")
    .insert({
      session_id: sessionId,
      role: "assistant",
      content,
      ...(root ? { original_message_id: root } : {}),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`could not seed a reply: ${error?.message}`);
  return data.id as string;
}

const supersededAt = async (id: string): Promise<string | null> => {
  const { data } = await serviceClient()
    .from("messages")
    .select("superseded_at")
    .eq("id", id)
    .single();
  return (data?.superseded_at as string | null) ?? null;
};

beforeAll(async () => {
  owner = await createTestUser("versions-owner");
  stranger = await createTestUser("versions-stranger");
  seeded = await seedWorkspace(owner);
  sessionId = await seedSession();
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("the constraint, which is the security half", () => {
  it("refuses a question that claims to be superseded", async () => {
    // The one row a member can write. Without the role half of
    // `messages_version_valid` they could take their own turn out of a
    // transcript a colleague is reading.
    const { error } = await owner.db.from("messages").insert({
      session_id: sessionId,
      role: "user",
      content: "How many vacation days?",
      superseded_at: new Date().toISOString(),
    });

    expect(error?.message ?? "").toMatch(/messages_version_valid/);
  });

  it("refuses a question that claims to be a version of an answer", async () => {
    const reply = await seedReply("Twenty days.");

    const { error } = await owner.db.from("messages").insert({
      session_id: sessionId,
      role: "user",
      content: "How many vacation days?",
      original_message_id: reply,
    });

    expect(error?.message ?? "").toMatch(/messages_version_valid/);
  });

  it("accepts a plain question, which is every question", async () => {
    const { error } = await owner.db.from("messages").insert({
      session_id: sessionId,
      role: "user",
      content: "And carry-over?",
    });

    expect(error).toBeNull();
  });
});

describe("a member cannot put an answer aside by hand", () => {
  it("matches no rows when a member tries to supersede a reply", async () => {
    // Not an error — `messages_update_owner` has no branch for an assistant
    // row, and RLS answers an update it has no policy for by updating nothing.
    // The evidence is the row, not the response.
    const reply = await seedReply("Twenty days.");

    await owner.db
      .from("messages")
      .update({ superseded_at: new Date().toISOString() })
      .eq("id", reply);

    expect(await supersededAt(reply)).toBeNull();
  });
});

describe("show_message_version", () => {
  it("brings back the version asked for and puts the rest aside, in one step", async () => {
    const first = await seedReply("Twenty days, I think.");
    const second = await seedReply("Twenty days.", first);
    await serviceClient()
      .from("messages")
      .update({ superseded_at: new Date().toISOString() })
      .eq("id", first);

    const { error } = await owner.db.rpc("show_message_version", { p_message_id: first });

    expect(error).toBeNull();
    expect(await supersededAt(first)).toBeNull();
    expect(await supersededAt(second)).not.toBeNull();
  });

  it("leaves a conversation somebody else owns exactly as it was", async () => {
    // SECURITY DEFINER, so the check is inside the function. A caller who does
    // not own the conversation matches nothing and is told nothing — which is
    // why `routes/messages.ts` checks ownership first and answers 403.
    const first = await seedReply("Twenty days, I think.");
    const second = await seedReply("Twenty days.", first);
    await serviceClient()
      .from("messages")
      .update({ superseded_at: new Date().toISOString() })
      .eq("id", first);

    await stranger.db.rpc("show_message_version", { p_message_id: first });

    expect(await supersededAt(first)).not.toBeNull();
    expect(await supersededAt(second)).toBeNull();
  });

  it("does nothing to a question", async () => {
    const { data } = await owner.db
      .from("messages")
      .insert({ session_id: sessionId, role: "user", content: "Anything else?" })
      .select("id")
      .single();

    const { error } = await owner.db.rpc("show_message_version", { p_message_id: data!.id });

    expect(error).toBeNull();
    expect(await supersededAt(data!.id as string)).toBeNull();
  });
});
