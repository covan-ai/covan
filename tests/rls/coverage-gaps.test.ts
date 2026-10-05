/**
 * A routine that reads the workspace's own data is admin-only, and the API is
 * not what makes it so.
 *
 * `authenticated` holds a table-level INSERT and UPDATE on `routines` from 0023
 * with no column list, and the anon key ships in the browser bundle — so
 * `POST /rest/v1/routines` reaches Postgres whatever `routes/routines.ts`
 * accepts. Every write below therefore goes through PostgREST as the user whose
 * privilege is in question, never as the service role, which bypasses row level
 * security entirely and would prove nothing.
 *
 * Two halves, and 0073 is only the first:
 *
 *   - who may create one at all (`is_workspace_admin`), and
 *   - that such a routine may never file its report into a knowledge bundle,
 *     where every agent in the workspace would retrieve a document about what
 *     the team does not know and quote it back at somebody as if it were
 *     knowledge.
 *
 * The second half is the one with no second line of defence: the executor runs
 * under the service role, so if the column is set, the document gets written.
 *
 * The rest of this file is a regression test for the SIX guards 0056's two
 * policies already carried, because 0073 drops and recreates both and a guard
 * that failed to be copied forward fails nothing — the policy still exists,
 * still has its name, and still refuses the obvious things.
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

/**
 * `insufficient_privilege` — what a row level security refusal arrives as.
 *
 * Asserted by code rather than just "an error", because the wrong refusal is
 * the failure mode that matters here. A check constraint rejecting the new
 * source kind outright is `23514`, and a test that only asked for *some* error
 * would pass against a database where `source_kind = 'workspace'` is not a
 * legal value at all.
 */
const RLS_REFUSED = "42501";

let admin: TestUser;
let seeded: Seeded;

/** In the admin's workspace, and emphatically not an admin of it. */
let member: TestUser;
/**
 * A channel of the member's own. Without one, every refusal below would be
 * 0012's channel-ownership guard rather than the guard under test.
 */
let memberChannelId: string;

/** Somebody else entirely, with a workspace of their own. */
let stranger: TestUser;
let strangerSeeded: Seeded;

/** For 0047's guard: one connection the caller can see, one they cannot. */
let foreignConnectionId: string;

/** The workspace-source routine the admin is allowed to create, for the UPDATE half. */
let workspaceRoutineId: string;

/**
 * `delivery_channels` has no INSERT policy at all — the route creates them with
 * the service-role client because the row holds an encrypted secret. So the
 * fixture has to do the same; `tests/rls/fixtures.ts` says so at more length.
 */
async function seedChannel(user: TestUser, workspaceId: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from("delivery_channels")
    .insert({
      workspace_id: workspaceId,
      user_id: user.id,
      kind: "email",
      label: "m••••r@covan.test",
      secret_ciphertext: "not-a-real-ciphertext",
    })
    .select("id")
    .single();
  if (error) throw new Error(`seeding delivery_channels failed: ${error.message}`);
  return data.id as string;
}

/** `connections` grants `authenticated` no INSERT either, for the same reason. */
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

/** A routine that reads the workspace's own data — the thing 0073 is about. */
const workspaceRoutine = (
  user: TestUser,
  workspaceId: string,
  agentId: string,
  channelId: string,
  extra: Record<string, unknown> = {},
) => ({
  workspace_id: workspaceId,
  agent_id: agentId,
  user_id: user.id,
  name: "Coverage gaps",
  source_kind: "workspace",
  source_config: { report: "coverage_gaps" },
  instruction: "report the gaps",
  delivery_channel_id: channelId,
  schedule_cron: "0 9 * * 1",
  timezone: "UTC",
  ...extra,
});

/**
 * An ordinary routine, for the carried-forward guards.
 *
 * Deliberately NOT a workspace-source one: each guard below has to be shown
 * refusing on its own, and a `workspace` kind would let 0073 do the refusing
 * and hide a clause that went missing.
 */
const ordinaryRoutine = (
  user: TestUser,
  workspaceId: string,
  agentId: string,
  channelId: string,
  extra: Record<string, unknown> = {},
) => ({
  workspace_id: workspaceId,
  agent_id: agentId,
  user_id: user.id,
  name: "An ordinary routine",
  source_kind: "web",
  source_config: { url: "https://example.com/changelog" },
  instruction: "summarise",
  delivery_channel_id: channelId,
  schedule_cron: "0 9 * * *",
  timezone: "UTC",
  ...extra,
});

beforeAll(async () => {
  admin = await createTestUser("coverage-admin");
  seeded = await seedWorkspace(admin);

  member = await createTestUser("coverage-member");
  // Joined as a plain member. `accept_invitation()` is the app's path and is a
  // SECURITY DEFINER RPC; seeding the row directly is what the other files here
  // do, and it is the row's content that matters rather than how it arrived.
  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: admin.workspaceId, user_id: member.id, role: "member" });
  if (error) throw new Error(`seeding the member failed: ${error.message}`);
  memberChannelId = await seedChannel(member, admin.workspaceId);

  stranger = await createTestUser("coverage-stranger");
  strangerSeeded = await seedWorkspace(stranger);
  foreignConnectionId = await seedConnection(stranger, strangerSeeded.bundleId);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("who may point a routine at the workspace's own data", () => {
  it("lets an admin create one", async () => {
    const { data, error } = await admin.db
      .from("routines")
      .insert(workspaceRoutine(admin, admin.workspaceId, seeded.agentId, seeded.channelId))
      .select("id")
      .single();

    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
    workspaceRoutineId = data!.id as string;
  });

  it("refuses a member of the workspace who is not an admin", async () => {
    const { error } = await member.db
      .from("routines")
      .insert(workspaceRoutine(member, admin.workspaceId, seeded.agentId, memberChannelId));

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("refuses a member of another workspace pointing one at this workspace", async () => {
    const { error } = await stranger.db
      .from("routines")
      .insert(
        workspaceRoutine(stranger, admin.workspaceId, seeded.agentId, strangerSeeded.channelId),
      );

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  // The second half of 0073, and the half with no run-time backstop: the
  // executor files with the service role, so a set column is a written
  // document. A coverage report is a document about what the team does not
  // know, and 0056's header refuses the identical shape when it refuses to let
  // pause announcements become documents.
  it("refuses even an admin one that would file its report as a document", async () => {
    const { error } = await admin.db.from("routines").insert(
      workspaceRoutine(admin, admin.workspaceId, seeded.agentId, seeded.channelId, {
        output_bundle_id: seeded.bundleId,
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  // The guard did not become a blanket refusal: a plain member may still create
  // an ordinary routine, which is every routine that existed before 0073.
  it("still lets a plain member create an ordinary routine", async () => {
    const { error } = await member.db
      .from("routines")
      .insert(ordinaryRoutine(member, admin.workspaceId, seeded.agentId, memberChannelId));

    expect(error).toBeNull();
  });

  // And an ordinary routine may still file into a bundle, which is 0056's
  // whole feature. Only the workspace-source kind is barred from it.
  it("still lets an admin file an ordinary routine's output into a bundle", async () => {
    const { error } = await admin.db.from("routines").insert(
      ordinaryRoutine(admin, admin.workspaceId, seeded.agentId, seeded.channelId, {
        output_bundle_id: seeded.bundleId,
      }),
    );

    expect(error).toBeNull();
  });
});

/**
 * The six clauses 0056's WITH CHECK carried, each shown still refusing.
 *
 * 0073 drops and recreates both policies, so this is the only thing that proves
 * the rewrite carried them. `worker/src/routine-policy.static.test.ts` catches a
 * clause whose *name* disappeared; this catches one that is present and no
 * longer refuses.
 */
describe("the guards 0056 already carried, on INSERT", () => {
  it("1. refuses a routine owned by somebody else", async () => {
    const { error } = await admin.db.from("routines").insert(
      ordinaryRoutine(admin, admin.workspaceId, seeded.agentId, seeded.channelId, {
        user_id: member.id,
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("2. refuses a routine in a workspace the caller is not in", async () => {
    const { error } = await admin.db
      .from("routines")
      .insert(ordinaryRoutine(admin, stranger.workspaceId, seeded.agentId, seeded.channelId));

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("3. refuses an agent from another workspace", async () => {
    const { error } = await admin.db
      .from("routines")
      .insert(ordinaryRoutine(admin, admin.workspaceId, strangerSeeded.agentId, seeded.channelId));

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  // A channel belongs to a PERSON, not a workspace (0019), so the guard is
  // `dc.user_id = auth.uid()` and the member's own channel in this very
  // workspace is still not the admin's to deliver to.
  it("4. refuses a delivery channel belonging to somebody else", async () => {
    const { error } = await admin.db
      .from("routines")
      .insert(ordinaryRoutine(admin, admin.workspaceId, seeded.agentId, memberChannelId));

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("5. refuses a connection from another workspace (0047)", async () => {
    const { error } = await admin.db.from("routines").insert(
      ordinaryRoutine(admin, admin.workspaceId, seeded.agentId, seeded.channelId, {
        source_kind: "connection",
        source_config: { connectionId: foreignConnectionId },
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("6. refuses an output bundle from another workspace (0056)", async () => {
    const { error } = await admin.db.from("routines").insert(
      ordinaryRoutine(admin, admin.workspaceId, seeded.agentId, seeded.channelId, {
        output_bundle_id: strangerSeeded.bundleId,
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });
});

/**
 * The same six on UPDATE, plus the USING clause.
 *
 * Clause 5 is the exception and cannot be reached through this harness at all:
 * 0027's `trg_routines_source_config_immutable` is a BEFORE UPDATE trigger that
 * raises on any change to `source_kind` or `source_config`, and a BEFORE trigger
 * runs before a WITH CHECK is evaluated. So an attempt arrives as `23514` from
 * the trigger and never reaches the policy. 0047 and 0056 both say in as many
 * words that they wrote the clause anyway, because a trigger is one
 * `drop trigger` away from being removed by somebody solving a different
 * problem — which is exactly why 0073 carries it forward unexercised, and why
 * the static test rather than this file is what keeps it there.
 */
describe("the guards 0056 already carried, on UPDATE", () => {
  it("USING: somebody else cannot update the owner's routine", async () => {
    await stranger.db.from("routines").update({ name: "taken" }).eq("id", seeded.routineId);

    // No error is the correct outcome: the USING clause filters the row out, so
    // the statement matches nothing rather than being refused. The proof is the
    // row, read back with the service role.
    const { data } = await serviceClient()
      .from("routines")
      .select("name")
      .eq("id", seeded.routineId)
      .single();
    expect(data!.name).toBe("Seeded routine");
  });

  it("1. refuses handing the routine to somebody else", async () => {
    const { error } = await admin.db
      .from("routines")
      .update({ user_id: member.id })
      .eq("id", seeded.routineId);

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("2. refuses moving the routine to a workspace the caller is not in", async () => {
    const { error } = await admin.db
      .from("routines")
      .update({ workspace_id: stranger.workspaceId })
      .eq("id", seeded.routineId);

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("3. refuses repointing it at an agent from another workspace", async () => {
    const { error } = await admin.db
      .from("routines")
      .update({ agent_id: strangerSeeded.agentId })
      .eq("id", seeded.routineId);

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("4. refuses repointing it at somebody else's delivery channel", async () => {
    const { error } = await admin.db
      .from("routines")
      .update({ delivery_channel_id: memberChannelId })
      .eq("id", seeded.routineId);

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("6. refuses repointing its output at another workspace's bundle", async () => {
    const { error } = await admin.db
      .from("routines")
      .update({ output_bundle_id: strangerSeeded.bundleId })
      .eq("id", seeded.routineId);

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("still allows the fields the edit dialog actually changes", async () => {
    const { error } = await admin.db
      .from("routines")
      .update({ name: "Seeded routine", instruction: "summarise briefly" })
      .eq("id", seeded.routineId);

    expect(error).toBeNull();
  });
});

/**
 * 0073 on UPDATE, which is where it is most reachable.
 *
 * `source_kind` cannot be changed after creation, so the interesting updates
 * are the two that leave it alone: adding an output bundle to a routine that
 * already reads the workspace, and continuing to own one after losing the role
 * that was allowed to make it.
 */
describe("0073 on UPDATE", () => {
  it("refuses adding an output bundle to a workspace-source routine", async () => {
    const { error } = await admin.db
      .from("routines")
      .update({ output_bundle_id: seeded.bundleId })
      .eq("id", workspaceRoutineId);

    // 0056's clause would allow this: the bundle is in the routine's own
    // workspace and the admin can see it. 0073 is the only thing refusing.
    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  // Runs last on purpose: it changes who is an admin of the workspace, and
  // every test above assumes the roles the fixture set up.
  describe("after the owner is demoted", () => {
    beforeAll(async () => {
      const service = serviceClient();
      // The member is promoted first. `trg_prevent_last_admin` refuses to
      // demote a workspace's only admin, and it is right to.
      const { error: promoted } = await service
        .from("workspace_members")
        .update({ role: "admin" })
        .eq("workspace_id", admin.workspaceId)
        .eq("user_id", member.id);
      if (promoted) throw new Error(`promoting the member failed: ${promoted.message}`);

      const { error: demoted } = await service
        .from("workspace_members")
        .update({ role: "member" })
        .eq("workspace_id", admin.workspaceId)
        .eq("user_id", admin.id);
      if (demoted) throw new Error(`demoting the admin failed: ${demoted.message}`);
    });

    it("refuses any update to the workspace-source routine they still own", async () => {
      const { error } = await admin.db
        .from("routines")
        .update({ name: "renamed by a former admin" })
        .eq("id", workspaceRoutineId);

      // Every other clause passes: they own the row, they are still a member,
      // the agent and channel are unchanged and there is no output bundle. The
      // refusal is 0073's and nothing else's.
      expect(error).not.toBeNull();
      expect(error!.code).toBe(RLS_REFUSED);
    });

    it("still lets them edit an ordinary routine they own", async () => {
      const { error } = await admin.db
        .from("routines")
        .update({ name: "still editable" })
        .eq("id", seeded.routineId);

      expect(error).toBeNull();
    });
  });
});
