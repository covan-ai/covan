/**
 * `profiles.avatar_url` is null or a photo this API stored for that person
 * (0095).
 *
 * The column is its owner's to write (0082), and any `https://` address used to
 * go in. Every co-member's member list then loaded it: an image on somebody
 * else's server, telling that server who looked and when. Sign-up copied the
 * same field out of metadata the person signing up chose.
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

let alice: TestUser;
let bob: TestUser;
const signedUp: string[] = [];

const photo = (userId: string) => `/avatars/${userId}/0123456789abcdef0123456789abcdef.webp`;

beforeAll(async () => {
  alice = await createTestUser("avatar-alice");
  bob = await createTestUser("avatar-bob");
});

afterAll(async () => {
  if (signedUp.length > 0) {
    const db = sql();
    const users = db.array(signedUp);
    await db`delete from public.workspaces where created_by = any(${users}::uuid[])`;
    await db`delete from auth.users where id = any(${users}::uuid[])`;
  }
  await destroyTestUsers();
  await closeSql();
});

async function setAvatar(user: TestUser, url: string | null) {
  return user.db.from("profiles").update({ avatar_url: url }).eq("id", user.id);
}

describe("a profile photo", () => {
  it("can be one the API stored for its owner", async () => {
    expect((await setAvatar(alice, photo(alice.id))).error).toBeNull();
  });

  it("can be cleared", async () => {
    expect((await setAvatar(alice, null)).error).toBeNull();
  });

  it.each([
    ["an address on somebody else's server", () => "https://tracker.example/pixel.png"],
    ["another person's photo", () => photo(bob.id)],
    ["a path that walks out of the photos", () => `/avatars/${alice.id}/../../documents/x`],
  ])("cannot be %s", async (_label, url) => {
    const { error } = await setAvatar(alice, url());
    expect(error?.code).toBe("23514");
  });

  it("is refused to the service role too, which is every writer at once", async () => {
    const { error } = await serviceClient()
      .from("profiles")
      .update({ avatar_url: "https://tracker.example/pixel.png" })
      .eq("id", alice.id);
    expect(error?.code).toBe("23514");
  });

  it("is not taken from what somebody signing up sent", async () => {
    const { data, error } = await serviceClient().auth.admin.createUser({
      email: `rls-avatar-signup-${crypto.randomUUID()}@covan.test`,
      password: crypto.randomUUID(),
      email_confirm: true,
      user_metadata: { name: "signup", avatar_url: "https://tracker.example/pixel.png" },
    });
    expect(error).toBeNull();
    signedUp.push(data.user!.id);

    const [row] = await sql()`select avatar_url from public.profiles where id = ${data.user!.id}`;
    expect(row.avatar_url).toBeNull();
  });
});
