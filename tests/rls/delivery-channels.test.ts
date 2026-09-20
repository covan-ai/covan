/**
 * What the database says about delivery channels, now that there are three
 * kinds of them.
 *
 * Migration 0054 widened one CHECK constraint and touched nothing else, and
 * both halves of that are worth proving against a real database rather than
 * asserting in prose.
 *
 * The widening is written as 0047's find-and-drop loop, because 0012 wrote the
 * constraint inline and its generated name is not something a later migration
 * should guess at. A loop that matches too loosely drops a constraint it did
 * not mean to; one that matches nothing leaves the old constraint in place
 * beside the new one and every webhook channel is refused by a constraint
 * nobody is looking at. Neither failure is visible from TypeScript, and the
 * second is not visible from a successful migration either.
 *
 * The "touched nothing else" half matters more. A webhook channel's signing
 * secret lives inside `secret_ciphertext` — the same column the URL is in, as
 * one JSON object — which is what lets 0023's column-list grant keep being the
 * whole answer to what a client may read. If that grant had drifted, a
 * workspace member could read the secret that signs their colleague's
 * deliveries, or write a new one over it.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";

let owner: TestUser;

/** The way the route does it: service role, because the row holds a secret. */
async function seedChannel(user: TestUser, kind: string, secret = "not-a-real-ciphertext") {
  return serviceClient()
    .from("delivery_channels")
    .insert({
      workspace_id: user.workspaceId,
      user_id: user.id,
      kind,
      label: `seeded-${kind}`,
      secret_ciphertext: secret,
    })
    .select("id")
    .single();
}

beforeAll(async () => {
  owner = await createTestUser("channel-owner");
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("delivery_channels.kind", () => {
  it.each(["slack_webhook", "email", "webhook"])("accepts %s", async (kind) => {
    const { data, error } = await seedChannel(owner, kind);
    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
  });

  // The constraint has to still be there after the widening. If 0054's loop
  // dropped it and the `add constraint` had been forgotten — or if it dropped
  // a constraint it did not mean to — this is the assertion that notices.
  it("still refuses a kind nobody implemented", async () => {
    const { error } = await seedChannel(owner, "carrier_pigeon");
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/kind/i);
  });

  // And there must be exactly one constraint deciding it. Two — the old one
  // left in place beside the new — would refuse every webhook row while the
  // migration reported success.
  //
  // The pattern is the RENDERED shape rather than the wording. `kind in (a, b)`
  // is not stored; Postgres parses it and `pg_get_constraintdef` prints back
  // `kind = ANY (ARRAY['a'::text, ...])`. Looking for the source text finds
  // nothing and passes for the wrong reason — which is the same mistake 0054
  // itself made, and the reason this assertion is here at all.
  it("is decided by exactly one constraint", async () => {
    const { sql } = await import("./harness");
    const rows = await sql()`
      select con.conname, pg_get_constraintdef(con.oid) as def
      from pg_constraint con
      where con.conrelid = 'public.delivery_channels'::regclass
        and con.contype = 'c'
        and pg_get_constraintdef(con.oid) like '%kind = ANY%'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].def).toContain("webhook");
  });
});

describe("a webhook channel's secret", () => {
  let channelId: string;

  beforeAll(async () => {
    const { data } = await seedChannel(
      owner,
      "webhook",
      '{"v":1,"url":"https://receiver.example.com/covan","signingSecret":"whsec_SEEDED"}',
    );
    channelId = data!.id as string;
  });

  // 0023's grant is a column list, and this is the claim 0054 rests on: adding
  // a kind added no column, so the list is still exactly right.
  it("is not selectable by its own owner", async () => {
    const { error } = await owner.db
      .from("delivery_channels")
      .select("id, secret_ciphertext")
      .eq("id", channelId);

    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  // Nor does `select *` quietly come back without it: the whole read is
  // refused. PostgREST expands `*` to every column the table has, including the
  // one 0023 withheld, so Postgres answers 42501 for the row rather than
  // handing back the part you were allowed. Stricter than "the column is
  // absent", and the reason `lib/export/tables.ts` names this table's columns
  // instead of asking for everything.
  it("is not reachable by asking for everything either", async () => {
    const { error } = await owner.db
      .from("delivery_channels")
      .select("*")
      .eq("id", channelId)
      .single();

    expect(error?.code).toBe("42501");
  });

  it("leaves the six columns the grant does name readable", async () => {
    const { data, error } = await owner.db
      .from("delivery_channels")
      .select("id, workspace_id, user_id, kind, label, created_at")
      .eq("id", channelId)
      .single();

    expect(error).toBeNull();
    expect(data).not.toHaveProperty("secret_ciphertext");
    expect(data).toMatchObject({ id: channelId, kind: "webhook" });
  });

  // The update grant is `update (label)`. Without that, a row's own owner could
  // PATCH their signing secret to a value of their choosing straight through
  // PostgREST — or repoint the channel at a host the create-time guard would
  // have refused, since the URL is in the same column.
  it("cannot be rewritten by its owner", async () => {
    const { error } = await owner.db
      .from("delivery_channels")
      .update({ secret_ciphertext: '{"v":1,"url":"http://169.254.169.254/","signingSecret":"x"}' })
      .eq("id", channelId);

    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("still lets its owner rename the row", async () => {
    const { error } = await owner.db
      .from("delivery_channels")
      .update({ label: "renamed" })
      .eq("id", channelId);

    expect(error).toBeNull();
  });
});
