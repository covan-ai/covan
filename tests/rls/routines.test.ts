/**
 * A routine's source url is validated exactly once, by assertFetchableUrl in
 * POST /routines. The route's updateSchema has no sourceUrl field, so the API
 * offers no way to move a routine's target afterwards — that was meant to be
 * the whole of the boundary. But routines_update_own only constrains user_id,
 * workspace_id, agent_id and delivery_channel_id, and 0023 granted
 * `authenticated` a table-level UPDATE. The anon key ships in the browser
 * bundle, so nothing stopped a direct PostgREST PATCH from repointing
 * source_config to anywhere at all, after Task 10/11's guard had already
 * passed once at creation.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSql, createTestUser, destroyTestUsers, serviceClient, type TestUser } from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

let owner: TestUser;
let seeded: Seeded;

beforeAll(async () => {
  owner = await createTestUser("routines-owner");
  seeded = await seedWorkspace(owner);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("a routine's source cannot be repointed after creation", () => {
  it("refuses to repoint a routine's source_config", async () => {
    const { error } = await owner.db
      .from("routines")
      .update({ source_config: { url: "http://169.254.169.254/latest/meta-data/" } })
      .eq("id", seeded.routineId);

    expect(error).not.toBeNull();

    const { data } = await serviceClient()
      .from("routines")
      .select("source_config")
      .eq("id", seeded.routineId)
      .single();
    expect(data!.source_config).toEqual({ url: "https://example.com/feed" });
  });

  it("still allows the fields the edit dialog actually changes", async () => {
    const { error } = await owner.db
      .from("routines")
      .update({ name: "renamed", instruction: "summarise briefly" })
      .eq("id", seeded.routineId);

    expect(error).toBeNull();
  });
});
