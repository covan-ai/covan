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
 *
 * 0074 then adds the data side of the feature and three corrections to 0073,
 * all of which are exercised here too:
 *
 *   - `coverage_opt_outs`, whose SELECT is self-only INCLUDING FOR ADMINS;
 *   - `workspace_coverage_gaps` and `workspace_coverage_totals`, which take the
 *     owner's user id explicitly because the caller that runs the report is the
 *     service role and `auth.uid()` is null for it — and the escalation that
 *     shape would open if a signed-in caller could name somebody else;
 *   - two CHECK constraints on 0073's row (the report name, and that such a
 *     routine may never be `shared`), and 0073's guard inverted to an
 *     allow-list.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  anonClient,
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  sql,
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

/**
 * `check_violation` — what a table CHECK refusal arrives as.
 *
 * 0074's two additions to 0073's row are CHECK constraints rather than policy
 * clauses, which is the point of them: a CHECK needs no policy rewrite and it
 * binds the service role, which a policy does not. So they refuse with a
 * different code, and asserting it is what distinguishes "the constraint
 * refused" from "something else objected".
 */
const CHECK_REFUSED = "23514";

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

/**
 * The workspace-source routine the UPDATE half edits.
 *
 * Created in `beforeAll` rather than assigned by the first test, which is how
 * it used to arrive. A failure in that test left this `undefined`, and the two
 * tests below that read it then reported `22P02` — "invalid input syntax for
 * type uuid" from PostgREST being handed the string `undefined` — instead of
 * their own result. Three red tests, one of them real, and the other two
 * pointing at a parse error rather than at the policy. The admit-path test
 * still inserts one of its own and still proves the policy allows it.
 */
let workspaceRoutineId: string;

/** The questions the read tests look for, and the sessions they were asked in. */
const LONG_QUESTION = "x".repeat(400);
const MEMBER_QUESTION = "how do I expense a flight?";
/** One character: a stray keystroke, and a row the read must not return. */
const STRAY_KEYSTROKE = "Z";
/** Asked in a session its owner has since deleted. Also must not come back. */
const DELETED_QUESTION = "what is the wifi password in the old office?";

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

/**
 * A private session in the admin's workspace, owned by whoever asked.
 *
 * Private is the default and the case that makes the definer read necessary:
 * the admin's own view of `messages` does not include the member's session, so
 * a read that only saw what the caller can see would see almost nothing.
 */
async function seedSession(user: TestUser, title: string): Promise<string> {
  const { data, error } = await serviceClient()
    .from("chat_sessions")
    .insert({
      agent_id: seeded.agentId,
      user_id: user.id,
      workspace_id: admin.workspaceId,
      visibility: "private",
      title,
    })
    .select("id")
    .single();
  if (error) throw new Error(`seeding a session failed: ${error.message}`);
  return data.id as string;
}

/**
 * One exchange that the gap read is supposed to find: a question, and a reply
 * that fell back to whole documents because nothing the team wrote was close.
 *
 * Both rows go in with the service role. `messages.grounding` is written by the
 * chat path and no client may write an assistant row at all since 0018, so
 * there is no user-client way to seed this; and two separate statements rather
 * than one multi-row insert, so the reply's `created_at` is strictly after the
 * question's and the lateral in the function has an unambiguous row to pick.
 */
async function askedAndAnswered(sessionId: string, question: string, askerId: string) {
  const service = serviceClient();
  const { error: asked } = await service
    .from("messages")
    .insert({ session_id: sessionId, sender_id: askerId, role: "user", content: question });
  if (asked) throw new Error(`seeding a question failed: ${asked.message}`);

  const { error: answered } = await service.from("messages").insert({
    session_id: sessionId,
    role: "assistant",
    content: "An answer, from whole documents.",
    grounding: "documents",
  });
  if (answered) throw new Error(`seeding a reply failed: ${answered.message}`);
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

  // See the declaration: created here so that a failure in the admit-path test
  // cannot leave the UPDATE tests reporting a uuid parse error instead of their
  // own verdict.
  const { data: routine, error: routineError } = await admin.db
    .from("routines")
    .insert(
      workspaceRoutine(admin, admin.workspaceId, seeded.agentId, seeded.channelId, {
        name: "Coverage gaps, for the UPDATE half",
      }),
    )
    .select("id")
    .single();
  if (routineError) {
    throw new Error(`seeding the workspace-source routine failed: ${routineError.message}`);
  }
  workspaceRoutineId = routine.id as string;

  // ---- what the read reads -------------------------------------------------
  //
  // The switch is turned on here rather than by a test, so that no read test
  // depends on having run after another one. The workspace that is never
  // turned on is the stranger's, which is what the refusal test uses.
  const { error: switched } = await serviceClient()
    .from("workspaces")
    .update({ gap_report_enabled: true })
    .eq("id", admin.workspaceId);
  if (switched) throw new Error(`turning the report on failed: ${switched.message}`);

  // The admin's own very long question, for the truncation test.
  await askedAndAnswered(await seedSession(admin, "a long question"), LONG_QUESTION, admin.id);
  // The member's, in a session the admin cannot read a row of — the whole
  // reason the read is SECURITY DEFINER.
  await askedAndAnswered(await seedSession(member, "a real question"), MEMBER_QUESTION, member.id);
  // And a stray keystroke, which must not be reported and must not occupy one
  // of the 150 rows.
  await askedAndAnswered(await seedSession(member, "a slip"), STRAY_KEYSTROKE, member.id);

  // A question in a session its owner has since deleted. Soft-deleted rows are
  // invisible to EVERYONE through RLS (0040), so a definer read has to carry
  // that clause itself or the deletion is cosmetic for the one thing this
  // feature is careful about: the text of what somebody asked.
  const doomed = await seedSession(member, "a session the member deleted");
  await askedAndAnswered(doomed, DELETED_QUESTION, member.id);
  const { error: deleted } = await serviceClient()
    .from("chat_sessions")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", doomed);
  if (deleted) throw new Error(`soft-deleting the session failed: ${deleted.message}`);
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

  /**
   * CLAUSE 2 CANNOT BE ISOLATED ON THIS SCHEMA, AND THE REASON IS WORTH
   * RECORDING RATHER THAN PAPERING OVER WITH A TEST THAT PRETENDS TO.
   *
   * The attempt: a workspace the caller is not in, whose agent and channel are
   * otherwise valid — so that clause 3 (the agent lives in the routine's
   * workspace) and clause 4 (the channel is the caller's own) both pass and
   * only membership is left to refuse it. The test above does not manage that:
   * it moves the workspace and leaves `agent_id` in the old one, so clause 3
   * fails alongside clause 2.
   *
   * This one uses the stranger's own agent, which is in the stranger's own
   * workspace, so clause 3 is satisfied ON PAPER. It is not satisfied in fact.
   * **A subquery inside a policy respects the referenced table's own RLS**, and
   * `agents_select_workspace_member` is `deleted_at is null and
   * is_workspace_member(workspace_id)` — the same predicate as clause 2. So the
   * stranger's agent is not a visible row for the admin, clause 3's `exists`
   * answers false, and clause 3 can only ever pass when clause 2 would have:
   *
   *     clause 3  ⇒  is_workspace_member(routines.workspace_id)  =  clause 2
   *
   * Clause 2 is therefore redundant given clause 3 as the schema stands, and no
   * insert can distinguish them. Measured, not reasoned: with clause 3 neutered
   * and clause 2 left in, this test still refuses — clause 2 doing the work on
   * its own. With both neutered, it goes red. So the pair is jointly binding and
   * clause 2 is live; what cannot be built is a row that separates them.
   *
   * Clause 2 stays, and the test below is the tripwire that says when it stops
   * being redundant: the day `agents` admits a row to a non-member — a public
   * agent, a shared template, a directory — clause 3 stops implying clause 2
   * and this test becomes the real isolation it is written as.
   *
   * (Clause 4 genuinely is satisfied here, and that part is worth knowing: a
   * channel belongs to a PERSON and not to a workspace since 0019, so the
   * admin's own channel passes whatever workspace the routine claims to be in.
   * No clause compares `delivery_channels.workspace_id` to the routine's.)
   */
  it("2 with 3. refuses it even when the agent and channel are otherwise valid", async () => {
    const { error } = await admin.db
      .from("routines")
      .insert(
        ordinaryRoutine(admin, stranger.workspaceId, strangerSeeded.agentId, seeded.channelId),
      );

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  /**
   * The tripwire for the entanglement above.
   *
   * It asserts the premise that makes clause 2 unisolatable: an agent in a
   * workspace the caller is not a member of is not a row the caller can see, so
   * clause 3's subquery cannot be satisfied for a foreign workspace. If this
   * ever goes green-to-red — `agents` gains a branch admitting a non-member —
   * then clause 3 stops implying clause 2 and the test above needs to be
   * re-examined as a genuine isolation, with clause 2 the only thing left
   * standing between a crafted insert and somebody else's workspace.
   */
  it("2 and 3 are entangled: a foreign workspace's agent is not a visible row", async () => {
    const { data } = await admin.db.from("agents").select("id").eq("id", strangerSeeded.agentId);

    expect(
      data,
      "agents now admits a non-member, so clause 2 is no longer implied by clause 3",
    ).toEqual([]);
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

  /**
   * The same attempt on this policy, and the same entanglement — see the long
   * note on the INSERT case. Moving the agent in the same statement makes
   * clause 3 pass on paper, and `agents`' own RLS makes it fail in fact for the
   * same reason. Measured the same way: with clause 3 neutered and clause 2 left
   * in, this still refuses; with both neutered, it goes red.
   */
  it("2 with 3. refuses the move even when the agent moves with it", async () => {
    const { error } = await admin.db
      .from("routines")
      .update({ workspace_id: stranger.workspaceId, agent_id: strangerSeeded.agentId })
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
 * The two shape guards 0074 adds to 0073's row.
 *
 * Both are CHECK constraints rather than policy clauses, so both bind the
 * service role as well — which is why they arrive as `23514` and not `42501`.
 * Asserted by code for the reason `RLS_REFUSED` is: a test that only asked for
 * *some* error would pass against a database where the constraint is absent and
 * something else happened to object.
 */
describe("what a workspace-source routine must say and must not be", () => {
  it("refuses one whose source_config does not say which report", async () => {
    // The column default. 0073's header says `source_config` names the report
    // and nothing refused `{}` — and 0027's immutability trigger means such a
    // routine can never be repaired, only deleted and made again.
    const { error } = await admin.db.from("routines").insert(
      workspaceRoutine(admin, admin.workspaceId, seeded.agentId, seeded.channelId, {
        source_config: {},
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe(CHECK_REFUSED);
  });

  it("refuses a report name that is not one", async () => {
    const { error } = await admin.db.from("routines").insert(
      workspaceRoutine(admin, admin.workspaceId, seeded.agentId, seeded.channelId, {
        source_config: { report: "../../etc/passwd" },
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe(CHECK_REFUSED);
  });

  /**
   * 0073 promises the second report needs no constraint change. A pattern
   * rather than an enumeration is what keeps that promise, and this is the test
   * that would go red the day somebody replaced it with `in ('coverage_gaps')`.
   */
  it("accepts the second report nobody has written yet", async () => {
    const { error } = await admin.db.from("routines").insert(
      workspaceRoutine(admin, admin.workspaceId, seeded.agentId, seeded.channelId, {
        name: "Stale documents",
        source_config: { report: "stale_documents" },
      }),
    );

    expect(error).toBeNull();
  });

  /**
   * The one that matters most, because the report's whole audience rule rests
   * on it: `routine_runs.summary` holds the delivered report, and
   * `routine_runs_select_visible` (0012) admits every workspace member to the
   * runs of a `shared` routine. An admin flipping this switch would publish the
   * coverage report to exactly the population the design keeps it from.
   */
  it("refuses a shared one, so no plain member can read the delivered report", async () => {
    const { error } = await admin.db.from("routines").insert(
      workspaceRoutine(admin, admin.workspaceId, seeded.agentId, seeded.channelId, {
        visibility: "shared",
      }),
    );

    expect(error).not.toBeNull();
    expect(error!.code).toBe(CHECK_REFUSED);
  });

  it("refuses flipping an existing one to shared", async () => {
    const { error } = await admin.db
      .from("routines")
      .update({ visibility: "shared" })
      .eq("id", workspaceRoutineId);

    expect(error).not.toBeNull();
    expect(error!.code).toBe(CHECK_REFUSED);

    const { data } = await serviceClient()
      .from("routines")
      .select("visibility")
      .eq("id", workspaceRoutineId)
      .single();
    expect(data!.visibility).toBe("private");
  });

  it("still lets an ordinary routine be shared, which is 0012's feature", async () => {
    const { error } = await admin.db
      .from("routines")
      .update({ visibility: "shared" })
      .eq("id", seeded.routineId);

    expect(error).toBeNull();
    await admin.db.from("routines").update({ visibility: "private" }).eq("id", seeded.routineId);
  });
});

/**
 * 0073's guard as an allow-list, which is 0074's third correction to it.
 *
 * The body was `p_source_kind <> 'workspace' or (...)`, so an undefined future
 * kind answered TRUE — the same default-open shape 0073's own header criticises
 * in 0047's `routine_source_is_visible`, three paragraphs before repeating it.
 *
 * Tested by calling the function rather than through the table, and that is not
 * a shortcut: `routines_source_kind_check` refuses an unknown `source_kind`
 * outright with `23514`, so an insert can never reach the policy with one. The
 * function is the only place the behaviour is observable, and it is callable by
 * anybody — PUBLIC keeps its default EXECUTE on it, because it is not SECURITY
 * DEFINER and discloses nothing the caller could not ask for directly.
 */
describe("the source-kind allow-list", () => {
  it("refuses a kind nobody has decided about yet", async () => {
    const { data, error } = await admin.db.rpc("routine_workspace_source_is_permitted", {
      p_source_kind: "a_kind_from_0085",
      p_workspace_id: admin.workspaceId,
      p_output_bundle_id: null,
    });

    expect(error, error?.message).toBeNull();
    expect(data).toBe(false);
  });

  it("still permits the four kinds that need no privilege", async () => {
    for (const kind of ["rss", "web", "none", "connection"]) {
      const { data, error } = await member.db.rpc("routine_workspace_source_is_permitted", {
        p_source_kind: kind,
        p_workspace_id: admin.workspaceId,
        p_output_bundle_id: null,
      });
      expect(error, error?.message).toBeNull();
      expect(data, `${kind} stopped being permitted`).toBe(true);
    }
  });

  it("still answers the question it was written for", async () => {
    const asAdmin = await admin.db.rpc("routine_workspace_source_is_permitted", {
      p_source_kind: "workspace",
      p_workspace_id: admin.workspaceId,
      p_output_bundle_id: null,
    });
    expect(asAdmin.data).toBe(true);

    const asMember = await member.db.rpc("routine_workspace_source_is_permitted", {
      p_source_kind: "workspace",
      p_workspace_id: admin.workspaceId,
      p_output_bundle_id: null,
    });
    expect(asMember.data).toBe(false);

    const filing = await admin.db.rpc("routine_workspace_source_is_permitted", {
      p_source_kind: "workspace",
      p_workspace_id: admin.workspaceId,
      p_output_bundle_id: seeded.bundleId,
    });
    expect(filing.data).toBe(false);
  });
});

/**
 * The opt-out, and the property that makes it worth having.
 *
 * Runs before the read tests below because the last of those excludes the
 * member for good; these need the table empty of their own rows to start.
 */
describe("the opt-out nobody can read", () => {
  it("lets a member exclude themselves", async () => {
    const { error } = await member.db
      .from("coverage_opt_outs")
      .insert({ workspace_id: admin.workspaceId, user_id: member.id });

    expect(error, error?.message).toBeNull();
  });

  it("refuses excluding somebody else", async () => {
    const { error } = await member.db
      .from("coverage_opt_outs")
      .insert({ workspace_id: admin.workspaceId, user_id: admin.id });

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("refuses excluding yourself from a workspace you are not in", async () => {
    const { error } = await stranger.db
      .from("coverage_opt_outs")
      .insert({ workspace_id: admin.workspaceId, user_id: stranger.id });

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  /**
   * The property that makes the control worth having. An admin who could list
   * these would learn which individuals chose to hide something — a sharper
   * signal about a person than the report itself carries, and one nobody opted
   * into by declining to opt in.
   *
   * The member's row exists at this point, inserted by the first test, so this
   * is an empty answer where there is something to answer about.
   */
  it("hides the list from an admin", async () => {
    const { data, error } = await admin.db.from("coverage_opt_outs").select("user_id");

    expect(error, error?.message).toBeNull();
    expect(data).toEqual([]);

    const { count } = await serviceClient()
      .from("coverage_opt_outs")
      .select("user_id", { count: "exact", head: true })
      .eq("workspace_id", admin.workspaceId);
    expect(count, "nothing was there to be hidden").toBe(1);
  });

  it("shows a member their own row and nothing else", async () => {
    const { data } = await member.db.from("coverage_opt_outs").select("user_id, workspace_id");
    expect(data).toEqual([{ user_id: member.id, workspace_id: admin.workspaceId }]);
  });

  /**
   * No UPDATE, at the grant rather than at a policy. There is nothing to
   * update — the row exists or it does not — and a table-level UPDATE with no
   * UPDATE policy to narrow it is the shape 0023 left on `workspace_members`,
   * which is the hole this table exists to avoid.
   */
  it("grants no UPDATE at all", async () => {
    const [row] = await sql()`
      select has_table_privilege('authenticated', 'public.coverage_opt_outs', 'update') as upd,
             has_table_privilege('authenticated', 'public.coverage_opt_outs', 'select') as sel,
             has_table_privilege('authenticated', 'public.coverage_opt_outs', 'insert') as ins,
             has_table_privilege('authenticated', 'public.coverage_opt_outs', 'delete') as del,
             has_table_privilege('anon', 'public.coverage_opt_outs', 'select') as anon_sel
    `;
    expect(row.upd).toBe(false);
    expect(row.anon_sel).toBe(false);
    expect([row.sel, row.ins, row.del]).toEqual([true, true, true]);
  });

  it("refuses deleting somebody else's exclusion", async () => {
    const service = serviceClient();
    const { error: seeding } = await service
      .from("coverage_opt_outs")
      .insert({ workspace_id: admin.workspaceId, user_id: admin.id });
    if (seeding) throw new Error(`seeding the admin's opt-out failed: ${seeding.message}`);

    // No error is the correct outcome: the USING clause filters the row out, so
    // the statement matches nothing rather than being refused. The proof is the
    // row, read back with the service role.
    await member.db
      .from("coverage_opt_outs")
      .delete()
      .eq("workspace_id", admin.workspaceId)
      .eq("user_id", admin.id);

    const { count } = await service
      .from("coverage_opt_outs")
      .select("user_id", { count: "exact", head: true })
      .eq("workspace_id", admin.workspaceId)
      .eq("user_id", admin.id);
    expect(count, "a member deleted somebody else's exclusion").toBe(1);

    await service
      .from("coverage_opt_outs")
      .delete()
      .eq("workspace_id", admin.workspaceId)
      .eq("user_id", admin.id);
  });

  it("lets a member take it back", async () => {
    const { error } = await member.db
      .from("coverage_opt_outs")
      .delete()
      .eq("workspace_id", admin.workspaceId)
      .eq("user_id", member.id);
    expect(error, error?.message).toBeNull();

    const { count } = await serviceClient()
      .from("coverage_opt_outs")
      .select("user_id", { count: "exact", head: true })
      .eq("workspace_id", admin.workspaceId);
    expect(count).toBe(0);
  });

  /**
   * A regression test for the trap 0074's header describes, so that a later
   * "simplification" onto `workspace_members` is a red test rather than a quiet
   * privilege escalation.
   */
  it("still refuses a member promoting themselves", async () => {
    await member.db
      .from("workspace_members")
      .update({ role: "admin" })
      .eq("workspace_id", admin.workspaceId)
      .eq("user_id", member.id);

    const { data } = await serviceClient()
      .from("workspace_members")
      .select("role")
      .eq("workspace_id", admin.workspaceId)
      .eq("user_id", member.id)
      .single();
    expect(data!.role).toBe("member");
  });
});

/**
 * The read, and the escalation its shape makes possible.
 *
 * `workspace_coverage_gaps` and `workspace_coverage_totals` take the owner's
 * user id explicitly, because the caller that actually runs the report is the
 * service role and `auth.uid()` is null for it — measured, not assumed, and the
 * reason is in 0074's header at length. That makes them an impersonation
 * primitive unless something stops a signed-in caller naming somebody else, and
 * the tests that matter most here are the ones that prove it does.
 */
describe("the read", () => {
  it("refuses a member of the workspace who is not an admin", async () => {
    const { error } = await member.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: member.id,
      p_days: 7,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  /**
   * THE ESCALATION. A plain member, signed in, naming the admin's id — which
   * is the whole capability the explicit `p_user_id` argument would hand out if
   * the function did not refuse it. `authenticated` holds EXECUTE, and
   * `authenticated` is the anon key from the browser bundle plus any password.
   *
   * Refused on `auth.uid()` rather than on the role: a caller with a session
   * may only ever name themselves, so the argument is a restatement of who they
   * already are.
   */
  it("refuses a signed-in non-admin naming an admin's id", async () => {
    const { data, error } = await member.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });

    expect(data ?? [], "a member read the admin's gap list").toEqual([]);
    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("refuses the same impersonation of the totals", async () => {
    const { data, error } = await member.db.rpc("workspace_coverage_totals", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });

    expect(data ?? []).toEqual([]);
    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  // Not only the unprivileged direction: an admin naming somebody else is
  // refused too, so the guard is about the session and not about the role.
  it("refuses even an admin naming somebody else's id", async () => {
    const { error } = await admin.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: member.id,
      p_days: 7,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("refuses a signed-in caller naming nobody at all", async () => {
    const { error } = await admin.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: null,
      p_days: 7,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  /**
   * The switch, and the whole of its safety: the stranger is an admin of their
   * own workspace and has never turned the report on, which is the state every
   * workspace that existed before 0074 is in after the deploy.
   */
  it("refuses an admin of a workspace that has not turned it on", async () => {
    const { error } = await stranger.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: stranger.workspaceId,
      p_user_id: stranger.id,
      p_days: 7,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("refuses the totals for a workspace that has not turned it on", async () => {
    const { error } = await stranger.db.rpc("workspace_coverage_totals", {
      p_workspace_id: stranger.workspaceId,
      p_user_id: stranger.id,
      p_days: 7,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  /**
   * THE WAY ROUND THE ESCALATION GUARD, AND THE REASON IT IS TWO LINES AND NOT
   * ONE.
   *
   * The guard above lets a caller with no `auth.uid()` name anybody, because
   * that caller is supposed to be the service role. `anon` also has no
   * `auth.uid()`. The plan's grant block — 0053's, copied — revokes PUBLIC and
   * grants `authenticated, service_role`, and on this stack that leaves `anon`
   * holding EXECUTE: Supabase ships
   * `alter default privileges ... grant execute on functions to anon, ...`, so
   * the grant is held BY NAME and `revoke ... from public` does not reach it.
   *
   * Reproduced against the first draft of 0074 with nothing but the anon key,
   * a workspace id and an admin's user id — all three of which any plain member
   * of the workspace has, since `workspace_members_select_fellow_members`
   * hands over `user_id` and `role`. It answered with a result. So this is not
   * a hygiene test: it is the escalation guard being walked around by dropping
   * the Authorization header.
   *
   * Closed twice — `revoke ... from anon` by name, and a second condition in
   * the body requiring the JWT's `role` claim to be `service_role` when there
   * is no `auth.uid()` — so this test goes red if either is removed.
   */
  it("refuses the public internet outright", async () => {
    const anon = anonClient();
    for (const fn of ["workspace_coverage_gaps", "workspace_coverage_totals"]) {
      const { data, error } = await anon.rpc(fn, {
        p_workspace_id: admin.workspaceId,
        p_user_id: admin.id,
        p_days: 7,
      });
      expect(data ?? [], `${fn} answered an anonymous caller`).toEqual([]);
      expect(error, `${fn} answered an anonymous caller`).not.toBeNull();
      expect(error!.code, `${fn} refused for the wrong reason`).toBe(RLS_REFUSED);
    }
  });

  /**
   * And the grant itself, read out of the catalog.
   *
   * The test above would also pass with `anon` holding EXECUTE, because the
   * body's second condition would refuse it. This is the half that fails if
   * somebody deletes `revoke ... from anon` and trusts the body alone — the
   * boundary Postgres checks before any of this function runs.
   */
  it("grants the two reads to nobody who should not have them", async () => {
    const rows = await sql()`
      select p.proname,
             has_function_privilege('anon', p.oid, 'execute') as anon,
             has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
             has_function_privilege('service_role', p.oid, 'execute') as service_role,
             p.prosecdef,
             p.proconfig
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname in ('workspace_coverage_gaps', 'workspace_coverage_totals')
       order by p.proname
    `;

    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.anon, `${row.proname} is reachable by anon`).toBe(false);
      expect(row.authenticated).toBe(true);
      expect(row.service_role).toBe(true);
      // A definer function without a pinned search_path is resolvable against
      // whatever the caller put on theirs.
      expect(row.prosecdef).toBe(true);
      expect(row.proconfig).toEqual(["search_path=pg_catalog, public"]);
    }
  });

  it("answers an admin, and never with a user id", async () => {
    const { data, error } = await admin.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });

    expect(error, error?.message).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);

    // Not a rule the interface is asked to follow: there is no user_id in the
    // return type, so no screen can break this by choosing to.
    for (const row of data ?? []) {
      expect(Object.keys(row).sort()).toEqual(["asker_key", "question"]);
      expect(typeof row.asker_key).toBe("number");
    }
  });

  /**
   * It reads past the caller's own RLS, which is why it is SECURITY DEFINER:
   * the member's question lives in a private session the admin cannot read a
   * row of. The premise is asserted first, so a failure cannot be read as the
   * seeding being wrong.
   */
  it("finds a question the admin cannot read directly", async () => {
    const direct = await admin.db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("content", MEMBER_QUESTION);
    expect(direct.count, "the admin could read the member's question directly").toBe(0);

    const { data } = await admin.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });
    expect((data ?? []).map((r: { question: string }) => r.question)).toContain(MEMBER_QUESTION);
  });

  it("gives the two askers two different keys, and neither is a user id", async () => {
    const { data } = await admin.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });

    const keys = new Set((data ?? []).map((r: { asker_key: number }) => r.asker_key));
    expect(keys.size).toBe(2);
    for (const key of keys) {
      expect(Number.isInteger(key)).toBe(true);
      expect(String(key)).not.toBe(admin.id);
      expect(String(key)).not.toBe(member.id);
    }
  });

  it("truncates a question to 120 characters", async () => {
    const { data } = await admin.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });

    const row = (data ?? []).find((r: { question: string }) => r.question.startsWith("x"));
    expect(row, "the long question was not returned at all").toBeDefined();
    expect(row!.question.length).toBe(120);
  });

  /**
   * A one-character question is a stray keystroke, and dropping it is
   * load-bearing rather than tidy. `isQuotation`'s Direction B in
   * `coverage-cluster.ts` is unconditional and has no length floor on the
   * needle — deliberately, since fix round 6 — so a single character matches as
   * a raw substring of almost every topic label the model could write. The
   * measurement behind the rule: a single vowel in the gap list unnames 8 to 11
   * of the 13 realistic label/question pairs that file's comments cite.
   *
   * Filtered in SQL, so it also does not occupy one of the 150 rows.
   */
  it("drops a one-character question", async () => {
    const { data } = await admin.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });

    const questions = (data ?? []).map((r: { question: string }) => r.question);
    expect(questions).not.toContain(STRAY_KEYSTROKE);
    // And it is not merely absent because the whole read is empty.
    expect(questions).toContain(MEMBER_QUESTION);
  });

  /**
   * A question in a session its owner deleted.
   *
   * `chat_sessions_select_owner_or_shared` is `deleted_at is null` with no
   * branch admitting an admin, and 0040's header says the clause is for
   * everyone in as many words. A SECURITY DEFINER function reads past that, so
   * it has to carry the clause itself — and what it would otherwise resurrect
   * here is the TEXT of a question, which is the one thing this feature exists
   * to keep away from an admin.
   *
   * 0053's pair does not carry it, and `workspace_coverage_totals` deliberately
   * does not either: they return counts, where the stake is a number being one
   * too high. The test below this one is where that divergence is visible.
   */
  it("drops a question from a session its owner deleted", async () => {
    const { data } = await admin.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });

    const questions = (data ?? []).map((r: { question: string }) => r.question);
    expect(questions).not.toContain(DELETED_QUESTION);
    expect(questions).toContain(MEMBER_QUESTION);
  });

  /**
   * The caller the feature actually has.
   *
   * The only test in this file that uses the service role as the SUBJECT
   * rather than as a fixture, and the reason is the defect 0074 exists to fix:
   * `worker/src/lib/routines/dispatcher.ts` builds the executor's client as
   * `serviceClient(env)` on all three entry points, a service-role JWT carries
   * no `sub`, and so `auth.uid()` is null and the plan's
   * `is_workspace_admin(p_workspace_id)` would have raised 42501 on every
   * scheduled run. If this test goes red, the weekly report does not run.
   */
  it("answers the service role about the routine's owner", async () => {
    const { data, error } = await serviceClient().rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });

    expect(error, error?.message).toBeNull();
    expect((data ?? []).length).toBeGreaterThan(0);
  });

  it("refuses the service role about somebody who is not an admin", async () => {
    // The admin check is not vacuous for the caller that has no session: a
    // routine owned by a demoted admin stops being readable, which is what
    // pauses it rather than letting it keep sending.
    const { error } = await serviceClient().rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: member.id,
      p_days: 7,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("clamps an absurd window rather than trusting it", async () => {
    // An API key is a caller too (0033), and 0053's rule is that a function
    // reading across every private session does not take an unbounded integer
    // from any of them.
    const { error } = await admin.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 10_000_000,
    });
    expect(error, error?.message).toBeNull();
  });

  /**
   * Retroactive, which is the point. The member's question is already in the
   * window and already in the list above; excluding them now removes it. A
   * control that only applied going forward would ask somebody to have decided
   * before they knew the feature existed.
   *
   * Last in this describe, because it changes what every test above reads.
   */
  it("drops an opted-out member's questions, including ones already asked", async () => {
    const { error: optedOut } = await member.db
      .from("coverage_opt_outs")
      .insert({ workspace_id: admin.workspaceId, user_id: member.id });
    expect(optedOut, optedOut?.message).toBeNull();

    const { data } = await admin.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });

    const questions = (data ?? []).map((r: { question: string }) => r.question);
    expect(questions).not.toContain(MEMBER_QUESTION);
    // The admin's own is still there, so this is an exclusion and not an
    // empty read.
    expect(questions.some((q: string) => q.startsWith("x"))).toBe(true);
  });
});

/**
 * The totals the report prints beside the gap list.
 *
 * 0053's `workspace_coverage` could not be reused: it has the same `auth.uid()`
 * problem, and fixing it would mean replacing a shipped function the live
 * coverage screen calls on every load, inside the migration that adds a
 * privacy-sensitive read. So the aggregation is duplicated — and the last test
 * here is what keeps the duplicate honest.
 */
describe("the totals, in step with 0053", () => {
  it("returns 0053's five buckets to an admin", async () => {
    const { data, error } = await admin.db.rpc("workspace_coverage_totals", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });

    expect(error, error?.message).toBeNull();
    const row = (data ?? [])[0];
    expect(Object.keys(row).sort()).toEqual([
      "answers",
      "covered",
      "fallback",
      "ungrounded",
      "unrecorded",
    ]);
    // Four `documents` replies were seeded; the denominator excludes nothing
    // but the unrecorded.
    expect(Number(row.fallback)).toBe(4);
    expect(Number(row.answers)).toBe(
      Number(row.covered) + Number(row.fallback) + Number(row.ungrounded),
    );
  });

  /**
   * The divergence between the two reads, stated as a test rather than left to
   * be discovered.
   *
   * Four fallback replies are counted here. The gap read returns two questions:
   * it drops the stray keystroke and the deleted session, and by then the
   * member is excluded as well. A count cannot identify anybody, which is
   * 0053's own argument for shipping these ungated; the sentence somebody typed
   * can, which is why the other function filters harder. If somebody later
   * makes the two agree row for row, they should have to change this test and
   * say why.
   */
  it("counts what the gap read deliberately will not return", async () => {
    const totals = await admin.db.rpc("workspace_coverage_totals", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });
    const gaps = await admin.db.rpc("workspace_coverage_gaps", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });

    expect(Number((totals.data ?? [])[0].fallback)).toBe(4);
    expect((gaps.data ?? []).length).toBeLessThan(4);
  });

  it("refuses a member who is not an admin", async () => {
    const { error } = await member.db.rpc("workspace_coverage_totals", {
      p_workspace_id: admin.workspaceId,
      p_user_id: member.id,
      p_days: 7,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("answers the service role about the routine's owner too", async () => {
    const { data, error } = await serviceClient().rpc("workspace_coverage_totals", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });

    expect(error, error?.message).toBeNull();
    expect(Number((data ?? [])[0].fallback)).toBe(4);
  });

  /**
   * The duplication, checked rather than promised.
   *
   * 0074's header says the two functions must stay in step and the comment on
   * each says so again, which is worth exactly as much as whoever next edits
   * one reads. This asks the database. If somebody changes a bucket, a
   * denominator or the window in either one, this goes red.
   *
   * The opt-out above does not affect it: the totals deliberately do not filter
   * `coverage_opt_outs`, because these are the counts 0053 ships with no gate
   * at all, and "in step" has to mean identical to be checkable.
   */
  it("agrees with public.workspace_coverage over the same window", async () => {
    const mine = await admin.db.rpc("workspace_coverage_totals", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });
    const theirs = await admin.db.rpc("workspace_coverage", {
      p_workspace_id: admin.workspaceId,
      p_days: 7,
    });

    expect(mine.error, mine.error?.message).toBeNull();
    expect(theirs.error, theirs.error?.message).toBeNull();
    expect((mine.data ?? [])[0]).toEqual((theirs.data ?? [])[0]);
  });
});

/**
 * 0073 on UPDATE, which is where it is most reachable.
 *
 * `source_kind` cannot be changed after creation, so the interesting updates
 * are the two that leave it alone: adding an output bundle to a routine that
 * already reads the workspace, and continuing to own one after losing the role
 * that was allowed to make it.
 *
 * LAST IN THE FILE ON PURPOSE, and it has to stay last: its nested `beforeAll`
 * promotes the member and demotes the admin, so everything above it that says
 * "the admin" would be talking about a plain member.
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
