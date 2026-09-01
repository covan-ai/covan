import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { closeSql, createTestUser, destroyTestUsers, type TestUser } from "./harness";

/*
 * Who may write the row that decides which notices somebody gets.
 *
 * `0015` created this table with three own-row policies and no test, which was
 * survivable while every column on it was a switch the person themselves flipped
 * on a settings screen. `0036` changes that: `quota_warned_for` is written by
 * the API on the caller's behalf, in the middle of a chat request, to record
 * that a warning has already gone out.
 *
 * That makes two things worth holding down. The column has to be writable at all
 * — a column nothing may write is the failure `0023` exists to explain, and it
 * would show up here as a warning that fires once per reply forever, because the
 * stamp that suppresses it never lands. And it has to stay writable by its owner
 * only, or one person could suppress another's warning by stamping a period they
 * are not in.
 *
 * The suite drives a real Postgres through PostgREST, so what passes here is
 * what the Worker's request-scoped client actually gets.
 */

const PERIOD = "2026-10-01T00:00:00.000Z";

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await createTestUser("prefs-alice");
  bob = await createTestUser("prefs-bob");
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("notification_preferences", () => {
  it("lets somebody stamp their own quota warning", async () => {
    const { error } = await alice.client
      .from("notification_preferences")
      .upsert({ user_id: alice.id, quota_warned_for: PERIOD }, { onConflict: "user_id" });

    expect(error).toBeNull();

    const { data } = await alice.client
      .from("notification_preferences")
      .select("quota_warned_for")
      .eq("user_id", alice.id)
      .maybeSingle();

    expect(data?.quota_warned_for).toBe(PERIOD);
  });

  // The row is keyed by user_id and the insert policy checks it against
  // auth.uid(), so this is refused rather than silently written — if it were
  // not, suppressing somebody else's warning would be one request away.
  it("refuses to stamp somebody else's", async () => {
    const { error } = await bob.client
      .from("notification_preferences")
      .upsert({ user_id: alice.id, quota_warned_for: PERIOD }, { onConflict: "user_id" });

    expect(error).not.toBeNull();
  });

  // A missing row is the normal state — nobody has one until something writes
  // it — and it has to keep meaning "every notice is on".
  it("has no row until something writes one", async () => {
    const { data, error } = await bob.client
      .from("notification_preferences")
      .select("user_id")
      .eq("user_id", bob.id)
      .maybeSingle();

    expect(error).toBeNull();
    expect(data).toBeNull();
  });
});
