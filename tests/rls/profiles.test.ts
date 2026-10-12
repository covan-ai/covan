import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";

/*
 * Who may write which part of a profile, after 0082.
 *
 * A profile row was editable by its owner in every column, because 0023's
 * blanket grant gave `authenticated` a table-wide UPDATE and `profiles_update_own`
 * only says WHOSE row. That was harmless while `name` was the only field anybody
 * touched. 0082 adds `bio`, `locale` and `timezone`, and hands `email` to a
 * trigger on `auth.users` -- which only holds if a client can no longer write
 * `email` itself, or the team page shows whatever address somebody typed.
 *
 * So this file pins both halves: the new fields are writable by their owner and
 * nobody else, and `email` moves only when the auth record does.
 */

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await createTestUser("profile-alice");
  bob = await createTestUser("profile-bob");

  // Bob joins Alice's workspace the way an accepted invitation does: through
  // the service role, because workspace_members has no INSERT policy.
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: alice.workspaceId, user_id: bob.id, role: "member" });
  if (error) throw new Error(`could not add bob to alice's workspace: ${error.message}`);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

async function ownProfile(user: TestUser) {
  const { data, error } = await user.db
    .from("profiles")
    .select("bio, locale, timezone, email, active_workspace_id")
    .eq("id", user.id)
    .single();
  if (error) throw new Error(`could not read ${user.email}'s profile: ${error.message}`);
  return data;
}

describe("profiles", () => {
  it("lets somebody set their own bio, locale and timezone", async () => {
    const { data, error } = await alice.db
      .from("profiles")
      .update({ bio: "Runs the support desk.", locale: "tr-TR", timezone: "Europe/Istanbul" })
      .eq("id", alice.id)
      .select("bio, locale, timezone");

    expect(error).toBeNull();
    expect(data).toEqual([
      { bio: "Runs the support desk.", locale: "tr-TR", timezone: "Europe/Istanbul" },
    ]);
  });

  // The members list shows a co-member's sentence and clock; that is the
  // point of having them.
  it("shows a co-member's bio and timezone", async () => {
    const { data, error } = await bob.db
      .from("profiles")
      .select("bio, timezone")
      .eq("id", alice.id)
      .single();

    expect(error).toBeNull();
    expect(data).toEqual({ bio: "Runs the support desk.", timezone: "Europe/Istanbul" });
  });

  it("does not let a co-member write somebody else's", async () => {
    const { data } = await bob.db
      .from("profiles")
      .update({ bio: "written by bob" })
      .eq("id", alice.id)
      .select("id");

    expect(data ?? []).toEqual([]);
    expect((await ownProfile(alice)).bio).toBe("Runs the support desk.");
  });

  // The column grant, not a policy: RLS would happily let Alice update her own
  // row, so the only thing that can refuse this is the grant leaving `email`
  // out. 42501 is Postgres saying exactly that.
  it("does not let anybody write their own email", async () => {
    const { error } = await alice.db
      .from("profiles")
      .update({ email: "someone-else@covan.test" })
      .eq("id", alice.id);

    expect(error?.code).toBe("42501");
    expect((await ownProfile(alice)).email).toBe(alice.email);
  });

  it("refuses a bio past 280 characters and a timezone that is a path", async () => {
    const long = await alice.db
      .from("profiles")
      .update({ bio: "x".repeat(281) })
      .eq("id", alice.id);
    expect(long.error?.code).toBe("23514");

    const path = await alice.db.from("profiles").update({ timezone: "../etc" }).eq("id", alice.id);
    expect(path.error?.code).toBe("23514");

    const after = await ownProfile(alice);
    expect(after.bio).toBe("Runs the support desk.");
    expect(after.timezone).toBe("Europe/Istanbul");
  });

  // What GoTrue does when somebody confirms a new address is an UPDATE of
  // `auth.users.email`. The admin API is the same write without the two links.
  it("follows the auth record when the address changes", async () => {
    const next = `rls-profile-alice-new-${crypto.randomUUID()}@covan.test`;
    const { error } = await serviceClient().auth.admin.updateUserById(alice.id, {
      email: next,
      email_confirm: true,
    });
    expect(error).toBeNull();

    expect((await ownProfile(alice)).email).toBe(next);
  });

  // `lib/workspace.ts` and `routes/workspace.ts` write this column through the
  // caller's client on every workspace switch. Narrowing the grant must not
  // take it away.
  it("still lets somebody switch their own active workspace", async () => {
    const { data, error } = await bob.db
      .from("profiles")
      .update({ active_workspace_id: alice.workspaceId })
      .eq("id", bob.id)
      .select("active_workspace_id");

    expect(error).toBeNull();
    expect(data).toEqual([{ active_workspace_id: alice.workspaceId }]);
  });
});
