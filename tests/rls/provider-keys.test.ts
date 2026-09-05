import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";

/*
 * The one table in this schema where a leak hands out a live credential that
 * bills somebody else's card.
 *
 * Every other table answers "who may see this row" with a policy. This one
 * answers it with the absence of a way in: RLS is on and no policy exists for
 * `authenticated`, so PostgREST has nothing to match and the strongest caller
 * in the system — a workspace's own admin — sees nothing. The Worker reads it
 * through `service_role` and checks the admin role itself.
 *
 * Written against a real Postgres through PostgREST, so what passes here is
 * what the Worker's request-scoped client actually gets.
 */

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await createTestUser("keys-alice");
  bob = await createTestUser("keys-bob");
  // Seed through service_role, the only writer there is.
  const { error } = await serviceClient().from("workspace_provider_keys").upsert({
    workspace_id: alice.workspaceId,
    openai_ciphertext: "ZmFrZQ==",
    openai_iv: "MTIzNDU2Nzg5MDEy",
    openai_hint: "sk-…4f2a",
    updated_by: alice.id,
  });
  expect(error).toBeNull();
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("workspace_provider_keys", () => {
  it("refuses SELECT to the workspace's own admin", async () => {
    const { data, error } = await alice.db
      .from("workspace_provider_keys")
      .select("workspace_id, openai_hint");

    // Either a hard refusal or an empty set — never a row. Both are acceptable
    // outcomes of "no policy exists"; what is not acceptable is data.
    expect(error ?? data).not.toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("refuses INSERT to the workspace's own admin", async () => {
    // Targets bob's workspace, not alice's own: alice's workspace_id already
    // has the seeded row (a primary-key collision on its own), and a bare hint
    // would fail the openai_complete check constraint on its own. Neither of
    // those is the wall this test exists to find. bob's workspace has no row
    // yet and this triple is complete, so the only thing left standing between
    // alice and a written row is the missing grant/policy — which is also why
    // the assertion below checks the specific code rather than "some error":
    // a permission-denied code says the wall is what stopped this; any error
    // would also pass if a stray NOT NULL or FK tripped first.
    const { error } = await alice.db.from("workspace_provider_keys").insert({
      workspace_id: bob.workspaceId,
      openai_ciphertext: "ZmFrZQ==",
      openai_iv: "MTIzNDU2Nzg5MDEy",
      openai_hint: "sk-…dead",
    });

    expect(error?.code).toBe("42501");
  });

  it("refuses UPDATE to the workspace's own admin", async () => {
    const { error, data } = await alice.db
      .from("workspace_provider_keys")
      .update({ openai_hint: "sk-…dead" })
      .eq("workspace_id", alice.workspaceId)
      .select("workspace_id");

    expect(error ?? (data ?? []).length === 0).toBeTruthy();
  });

  it("refuses DELETE to the workspace's own admin", async () => {
    const { error, data } = await alice.db
      .from("workspace_provider_keys")
      .delete()
      .eq("workspace_id", alice.workspaceId)
      .select("workspace_id");

    expect(error ?? (data ?? []).length === 0).toBeTruthy();

    // And the row is still there, read back through the only client that may.
    const { data: still } = await serviceClient()
      .from("workspace_provider_keys")
      .select("workspace_id")
      .eq("workspace_id", alice.workspaceId);
    expect(still).toHaveLength(1);
  });

  it("still lets service_role read what it wrote", async () => {
    const { data, error } = await serviceClient()
      .from("workspace_provider_keys")
      .select("openai_hint")
      .eq("workspace_id", alice.workspaceId)
      .maybeSingle();

    expect(error).toBeNull();
    expect(data?.openai_hint).toBe("sk-…4f2a");
  });
});
