/**
 * Who may say how an answer was grounded.
 *
 * `messages.grounding` (0039) exists so covan#44 can report what a team asked
 * that nothing it wrote was close to. That makes it a number-shaped column: it
 * is not read back in the chat screen, it is counted, and a count is only worth
 * printing if the rows behind it were written by the one party that knows.
 *
 * That party is the reply path, which runs as the service role. A member writes
 * their own question and nothing else — 0009 and 0031 pin their insert and
 * their update to `role = 'user'` — so the interesting question is not whether
 * they can rewrite an assistant row (they cannot, and that is tested below for
 * the record) but whether they can stamp a grounding on the one row they *are*
 * allowed to write. Without the role half of the constraint they could, and the
 * report would be counting rows its own subjects had filled in.
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
let seeded: Seeded;
let sessionId: string;

/** A private session of the owner's, in the workspace the agent lives in. */
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

beforeAll(async () => {
  owner = await createTestUser("grounding-owner");
  seeded = await seedWorkspace(owner);
  sessionId = await seedSession();
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("messages.grounding, written by the reply path", () => {
  it.each(["chunks", "documents", "none"] as const)(
    "accepts %s on an assistant reply from the service role",
    async (value) => {
      const { data, error } = await serviceClient()
        .from("messages")
        .insert({
          session_id: sessionId,
          role: "assistant",
          content: `Grounded via ${value}.`,
          grounding: value,
        })
        .select("grounding")
        .single();

      expect(error).toBeNull();
      expect(data?.grounding).toBe(value);
    },
  );

  it("refuses a value the report would not recognise", async () => {
    // A fourth state invented at the call site is worse than a missing one: it
    // would be silently excluded from both halves of every count, and nothing
    // would say so.
    const { error } = await serviceClient().from("messages").insert({
      session_id: sessionId,
      role: "assistant",
      content: "Grounded somehow.",
      grounding: "partial",
    });

    expect(error).not.toBeNull();
  });

  it("allows null, which is what every reply written before 0039 has", async () => {
    const { data, error } = await serviceClient()
      .from("messages")
      .insert({ session_id: sessionId, role: "assistant", content: "An older answer." })
      .select("grounding")
      .single();

    expect(error).toBeNull();
    expect(data?.grounding).toBeNull();
  });
});

describe("messages.grounding, from a member", () => {
  it("lets them write their own question, as always", async () => {
    const { error } = await owner.db.from("messages").insert({
      session_id: sessionId,
      role: "user",
      sender_id: owner.id,
      content: "What is the parental leave policy?",
    });

    expect(error).toBeNull();
  });

  it("refuses a grounding on that question", async () => {
    // The row is theirs and the insert is otherwise allowed, so RLS has no
    // objection — the constraint is the only thing standing here. Take the role
    // half out of 0039 and this insert succeeds, which is how a member becomes
    // an author of the report's inputs.
    const { error } = await owner.db.from("messages").insert({
      session_id: sessionId,
      role: "user",
      sender_id: owner.id,
      content: "What is the parental leave policy?",
      grounding: "chunks",
    });

    expect(error).not.toBeNull();
  });

  it("cannot change the grounding on an assistant reply", async () => {
    const { data: reply, error: insertError } = await serviceClient()
      .from("messages")
      .insert({
        session_id: sessionId,
        role: "assistant",
        content: "Nothing written was close to that.",
        grounding: "none",
      })
      .select("id")
      .single();
    if (insertError || !reply) throw new Error(`could not seed a reply: ${insertError?.message}`);

    // `messages_update_owner` (0031) matches only `role = 'user'` rows, so this
    // update finds nothing rather than failing loudly. Postgres reports no
    // error for an update that matched no rows, which is why the assertion is
    // on the stored value and not on the error.
    await owner.db.from("messages").update({ grounding: "chunks" }).eq("id", reply.id);

    const { data: after } = await serviceClient()
      .from("messages")
      .select("grounding")
      .eq("id", reply.id)
      .single();

    expect(after?.grounding).toBe("none");
  });
});
