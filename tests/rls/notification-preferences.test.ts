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
    const { error } = await alice.db
      .from("notification_preferences")
      .upsert({ user_id: alice.id, quota_warned_for: PERIOD }, { onConflict: "user_id" });

    expect(error).toBeNull();

    const { data } = await alice.db
      .from("notification_preferences")
      .select("quota_warned_for")
      .eq("user_id", alice.id)
      .maybeSingle();

    // Compared as an instant: the column is a timestamptz and PostgREST spells
    // it back as "+00:00" rather than the "Z" it was written with.
    expect(Date.parse(String(data?.quota_warned_for))).toBe(Date.parse(PERIOD));
  });

  /**
   * Asserted on the outcome rather than on the refusal.
   *
   * Whether this comes back as an error or as zero rows affected depends on
   * which half of the upsert Postgres reaches: an insert trips the WITH CHECK,
   * while a conflict turns it into an update whose USING clause matches nothing.
   * Both are correct and the test should not care which happened — what it has
   * to hold down is that Alice's stamp did not move, because a stamp somebody
   * else can write is a warning somebody else can suppress.
   */
  it("does not let one person stamp another's", async () => {
    await alice.db
      .from("notification_preferences")
      .upsert({ user_id: alice.id, quota_warned_for: PERIOD }, { onConflict: "user_id" });

    await bob.db
      .from("notification_preferences")
      .upsert(
        { user_id: alice.id, quota_warned_for: "2027-01-01T00:00:00.000Z" },
        { onConflict: "user_id" },
      );

    const { data } = await alice.db
      .from("notification_preferences")
      .select("quota_warned_for")
      .eq("user_id", alice.id)
      .maybeSingle();

    // Compared as an instant: the column is a timestamptz and PostgREST spells
    // it back as "+00:00" rather than the "Z" it was written with.
    expect(Date.parse(String(data?.quota_warned_for))).toBe(Date.parse(PERIOD));
  });

  // A missing row is the normal state — nobody has one until something writes
  // it — and it has to keep meaning "every notice is on".
  it("has no row until something writes one", async () => {
    const { data, error } = await bob.db
      .from("notification_preferences")
      .select("user_id")
      .eq("user_id", bob.id)
      .maybeSingle();

    expect(error).toBeNull();
    expect(data).toBeNull();
  });
});
