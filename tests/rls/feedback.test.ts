import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { closeSql, createTestUser, destroyTestUsers, type TestUser } from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

/*
 * Who may write feedback, and who may read it.
 *
 * `0040` adds the one table in this schema that is addressed to the operator
 * rather than to the workspace, and that inverts the usual question. Everywhere
 * else, "can a fellow member see this?" is the thing to get right and the
 * answer is usually yes. Here the answer has to be no — including for an admin.
 * A box that invites somebody to say what is broken, in a room where the person
 * who broke it can read the reply, is not a feedback box.
 *
 * The other half is the forgery the anon key makes reachable: PostgREST takes a
 * hand-written insert naming any column, so both `user_id` and `workspace_id`
 * have to be pinned by policy rather than by the route that normally fills them.
 *
 * The suite drives a real Postgres through PostgREST, so what passes here is
 * what the Worker's request-scoped client actually gets.
 */

let alice: TestUser;
let bob: TestUser;
let aliceContent: Seeded;
let bobContent: Seeded;

beforeAll(async () => {
  alice = await createTestUser("feedback-alice");
  bob = await createTestUser("feedback-bob");
  aliceContent = await seedWorkspace(alice);
  bobContent = await seedWorkspace(bob);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("feedback", () => {
  it("lets somebody send feedback about the workspace they are in", async () => {
    const { data, error } = await alice.db
      .from("feedback")
      .insert({
        workspace_id: alice.workspaceId,
        kind: "problem",
        message: "the sidebar forgets me",
        path: "/app",
      })
      .select("id, user_id")
      .single();

    expect(error).toBeNull();
    expect(data?.user_id).toBe(alice.id);
  });

  // Somebody between workspaces still has something to say.
  it("takes feedback with no workspace at all", async () => {
    const { error } = await alice.db.from("feedback").insert({ message: "no workspace here" });

    expect(error).toBeNull();
  });

  it("refuses feedback signed with somebody else's name", async () => {
    const { error } = await alice.db
      .from("feedback")
      .insert({ user_id: bob.id, message: "not mine to send" });

    expect(error).not.toBeNull();
  });

  /**
   * Not a leak — Alice learns nothing about Bob's workspace by doing this. It
   * is the other direction that matters: without the check, anybody could put
   * words in a stranger's room and have the operator read them as coming from
   * inside it.
   */
  it("refuses feedback filed against a workspace you are not in", async () => {
    const { error } = await alice.db
      .from("feedback")
      .insert({ workspace_id: bob.workspaceId, message: "not my room" });

    expect(error).not.toBeNull();
  });

  it("refuses a message that is only whitespace", async () => {
    const { error } = await alice.db.from("feedback").insert({ message: "   " });

    expect(error).not.toBeNull();
  });

  it("shows somebody their own feedback and nobody else's", async () => {
    await alice.db.from("feedback").insert({ message: "alice wrote this" });
    await bob.db.from("feedback").insert({ message: "bob wrote this" });

    const { data, error } = await alice.db.from("feedback").select("message");

    expect(error).toBeNull();
    const messages = (data ?? []).map((row) => row.message);
    expect(messages).toContain("alice wrote this");
    expect(messages).not.toContain("bob wrote this");
  });

  /**
   * Asserted on the outcome rather than on the refusal, the way
   * notification-preferences.test.ts is: with no update policy at all, the row
   * is simply not visible to the UPDATE, so PostgREST reports zero rows changed
   * rather than an error. What has to hold is that the words did not move.
   */
  it("keeps what was sent as it was sent", async () => {
    const { data: written } = await alice.db
      .from("feedback")
      .insert({ message: "as written" })
      .select("id")
      .single();

    await alice.db.from("feedback").update({ message: "rewritten" }).eq("id", written!.id);

    const { data } = await alice.db
      .from("feedback")
      .select("message")
      .eq("id", written!.id)
      .maybeSingle();

    expect(data?.message).toBe("as written");
  });

  /**
   * `0041` lets a note point at the reply it is about, which is what the chat's
   * thumbs send. The operator reads that column as "the answer they were
   * looking at", so an id the sender could not have seen would make the
   * sentence false.
   */
  it("lets a note point at an answer the sender can see", async () => {
    const { error } = await alice.db
      .from("feedback")
      .insert({ message: "this answer was wrong", message_id: aliceContent.messageId });

    expect(error).toBeNull();
  });

  it("refuses a note pointing at an answer in somebody else's conversation", async () => {
    const { error } = await alice.db
      .from("feedback")
      .insert({ message: "about a reply I cannot read", message_id: bobContent.messageId });

    expect(error).not.toBeNull();
  });

  it("offers no way to delete it from the app", async () => {
    const { data: written } = await alice.db
      .from("feedback")
      .insert({ message: "keep me" })
      .select("id")
      .single();

    await alice.db.from("feedback").delete().eq("id", written!.id);

    const { data } = await alice.db
      .from("feedback")
      .select("id")
      .eq("id", written!.id)
      .maybeSingle();

    expect(data).not.toBeNull();
  });
});
