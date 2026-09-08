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
let stranger: TestUser;
let strangerSeeded: Seeded;
/** A connection in the owner's own workspace, and one in a workspace they are not in. */
let ownConnectionId: string;
let foreignConnectionId: string;

/**
 * `connections` grants `authenticated` no INSERT at all — the worker creates
 * them with the service role after the OAuth exchange, because the row holds an
 * encrypted token. So these are seeded the way `delivery_channels` is.
 */
async function seedConnection(user: TestUser, bundleId: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from("connections")
    .insert({
      workspace_id: user.workspaceId,
      bundle_id: bundleId,
      user_id: user.id,
      provider: "notion",
      account_label: "Seeded Notion",
      secret_ciphertext: "not-a-real-ciphertext",
    })
    .select("id")
    .single();
  if (error) throw new Error(`seeding connections failed: ${error.message}`);
  return data.id as string;
}

beforeAll(async () => {
  owner = await createTestUser("routines-owner");
  seeded = await seedWorkspace(owner);
  stranger = await createTestUser("routines-stranger");
  strangerSeeded = await seedWorkspace(stranger);
  ownConnectionId = await seedConnection(owner, seeded.bundleId);
  foreignConnectionId = await seedConnection(stranger, strangerSeeded.bundleId);
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

/**
 * 0047's guard, and the reason it needs one.
 *
 * A `connection` routine names its source by id in `source_config`, and the
 * scheduled executor then reads that connection's documents with the
 * service-role client — row level security is not filtering it. `authenticated`
 * holds a table-level INSERT on `routines` and the anon key ships in the
 * browser bundle, so without a policy a crafted PostgREST insert could point a
 * routine in this workspace at a connection in another one, and the engine
 * would mail that workspace's document titles and excerpts to a channel here.
 * Nothing else in the stack would have refused it: the routine never touches
 * Notion, so no provider token and no OAuth scope is involved.
 */
describe("a routine cannot watch another workspace's connection", () => {
  const routineFor = (user: TestUser, s: Seeded, connectionId: string) => ({
    workspace_id: user.workspaceId,
    agent_id: s.agentId,
    user_id: user.id,
    name: "Watch the handbook",
    source_kind: "connection",
    source_config: { connectionId },
    instruction: "summarise what changed",
    delivery_channel_id: s.channelId,
    schedule_cron: "0 9 * * *",
  });

  it("refuses a connection in a workspace the caller is not in", async () => {
    const { error } = await owner.db
      .from("routines")
      .insert(routineFor(owner, seeded, foreignConnectionId));

    expect(error).not.toBeNull();
  });

  it("allows a connection in the caller's own workspace", async () => {
    const { data, error } = await owner.db
      .from("routines")
      .insert(routineFor(owner, seeded, ownConnectionId))
      .select("id")
      .single();

    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
  });

  it("refuses a connection routine that names no connection at all", async () => {
    const { error } = await owner.db.from("routines").insert({
      ...routineFor(owner, seeded, ownConnectionId),
      source_config: {},
    });

    expect(error).not.toBeNull();
  });

  // A malformed id has to be refused, not raise. `routine_source_is_visible`
  // compares the connection's id as text rather than casting the input to uuid,
  // because an exception raised inside a policy reaches the client as a server
  // error — which would answer a crafted write with "something broke" instead
  // of "no".
  it("refuses a malformed connection id without erroring out", async () => {
    const { error } = await owner.db.from("routines").insert({
      ...routineFor(owner, seeded, ownConnectionId),
      source_config: { connectionId: "not-a-uuid" },
    });

    expect(error).not.toBeNull();
    expect(error!.message).not.toMatch(/invalid input syntax/i);
  });
});
