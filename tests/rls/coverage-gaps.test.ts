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

/**
 * A second plain member of the admin's workspace.
 *
 * Three askers rather than two, which the asker-key tests need: with two, a
 * random per-call ranking agrees with the user-id ordering half the time and no
 * practical number of samples settles it.
 */
let member2: TestUser;

/** The questions the read tests look for, and the sessions they were asked in. */
const LONG_QUESTION = "x".repeat(400);
const MEMBER_QUESTION = "how do I expense a flight?";
const MEMBER2_QUESTION = "who approves a new vendor?";
/** One character: a stray keystroke, and a row the read must not return. */
const STRAY_KEYSTROKE = "Z";
/** Asked in a session its owner has since deleted. Also must not come back. */
const DELETED_QUESTION = "what is the wifi password in the old office?";
/**
 * Asked by the MEMBER, in a SHARED session the ADMIN owns.
 *
 * The case the first draft of 0074 got wrong: it credited the session owner, so
 * this question was attributed to the admin — which took the member's opt-out
 * out of the picture and let one person's questions clear a floor meant to count
 * three people.
 */
const CROSS_ASKER_QUESTION = "am I being moved to a different team?";
/** Answered twice, the first reply superseded. One gap, not two. */
const SUPERSEDED_QUESTION = "how long is the notice period?";
/** Both of these share a `created_at` with their replies, to the microsecond. */
const TIE_QUESTION_A = "do we have a cycle to work scheme?";
const TIE_QUESTION_B = "is there a budget for a standing desk?";

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

/**
 * The same thing, but the question goes in through the ASKER'S OWN CLIENT.
 *
 * Used for the shared-session case, where the whole point is that the write is
 * one an ordinary member may legitimately make: `messages_insert_user_self`
 * (0018) is `sender_id = auth.uid() and role = 'user'` plus a session that is
 * either theirs or `shared` in a workspace they belong to. Seeding it with the
 * service role would prove nothing about whether a member can get a question
 * into somebody else's room — which is exactly the question the attribution bug
 * turned on.
 */
async function askedByAndAnswered(sessionId: string, question: string, asker: TestUser) {
  const { error: asked } = await asker.db
    .from("messages")
    .insert({ session_id: sessionId, sender_id: asker.id, role: "user", content: question });
  if (asked) {
    throw new Error(`${asker.email} could not ask in that session: ${asked.message}`);
  }

  const { error: answered } = await serviceClient().from("messages").insert({
    session_id: sessionId,
    role: "assistant",
    content: "An answer, from whole documents.",
    grounding: "documents",
  });
  if (answered) throw new Error(`seeding a reply failed: ${answered.message}`);
}

/** One row of `workspace_coverage_gaps`, as PostgREST hands it over. */
type GapRow = { question: string; asker_key: number };

/**
 * The gap read, as the only caller that may make it.
 *
 * EXECUTE is granted to `service_role` alone, so this is not a shortcut past
 * row level security — it is the routines engine, which is what
 * `dispatcher.ts` builds for every run. Everything that must NOT get an answer
 * is attempted through a user's own client instead, and there are tests above
 * for each.
 */
function readGaps(days = 7) {
  return serviceClient().rpc("workspace_coverage_gaps", {
    p_workspace_id: admin.workspaceId,
    p_user_id: admin.id,
    p_days: days,
  });
}

/** The same, for the counts the report prints beside the list. */
function readTotals(days = 7) {
  return serviceClient().rpc("workspace_coverage_totals", {
    p_workspace_id: admin.workspaceId,
    p_user_id: admin.id,
    p_days: days,
  });
}

/** Just the question text, for the tests that only care what came back. */
function questionsFrom(data: unknown): string[] {
  return ((data ?? []) as GapRow[]).map((row) => row.question);
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

  member2 = await createTestUser("coverage-member2");
  const { error: member2Error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: admin.workspaceId, user_id: member2.id, role: "member" });
  if (member2Error) throw new Error(`seeding the second member failed: ${member2Error.message}`);

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

  // A second member, so there are three askers rather than two.
  await askedAndAnswered(
    await seedSession(member2, "a second member's question"),
    MEMBER2_QUESTION,
    member2.id,
  );

  // ---- the shared session, and the question somebody else asked in it ------
  //
  // Created through the ADMIN'S own client, so it is a session the app would
  // have made, and `shared` — which is the visibility the chat UI offers and
  // `routine_runs_select_visible` keys off.
  const { data: shared, error: sharedError } = await admin.db
    .from("chat_sessions")
    .insert({
      agent_id: seeded.agentId,
      user_id: admin.id,
      workspace_id: admin.workspaceId,
      visibility: "shared",
      title: "a room the whole team can read",
    })
    .select("id")
    .single();
  if (sharedError) throw new Error(`seeding the shared session failed: ${sharedError.message}`);
  await askedByAndAnswered(shared.id as string, CROSS_ASKER_QUESTION, member);

  // ---- a question answered twice, the first reply superseded ---------------
  const regenerated = await seedSession(admin, "a reply that was regenerated");
  await askedAndAnswered(regenerated, SUPERSEDED_QUESTION, admin.id);
  const service = serviceClient();
  const { data: first } = await service
    .from("messages")
    .select("id")
    .eq("session_id", regenerated)
    .eq("role", "assistant")
    .single();
  // The second attempt at the same question, and then the first is retired —
  // 0050 supersedes rather than deletes, and the retired row keeps its
  // `grounding`.
  const { error: again } = await service.from("messages").insert({
    session_id: regenerated,
    role: "assistant",
    content: "A better answer, also from whole documents.",
    grounding: "documents",
  });
  if (again) throw new Error(`seeding the regenerated reply failed: ${again.message}`);
  const { error: superseded } = await service
    .from("messages")
    .update({ superseded_at: new Date().toISOString() })
    .eq("id", first!.id);
  if (superseded) throw new Error(`superseding the first reply failed: ${superseded.message}`);

  // ---- four rows in ONE statement, so all four share `now()` ---------------
  //
  // `created_at` defaults to `now()`, which is the transaction's timestamp, and
  // one PostgREST request is one transaction. So both questions and both
  // replies below carry the identical value and the lateral has a tie to break.
  const tied = await seedSession(admin, "a tie to the microsecond");
  const { error: tieError } = await service.from("messages").insert([
    { session_id: tied, sender_id: admin.id, role: "user", content: TIE_QUESTION_A },
    {
      session_id: tied,
      role: "assistant",
      content: "An answer.",
      grounding: "documents",
    },
    { session_id: tied, sender_id: admin.id, role: "user", content: TIE_QUESTION_B },
    {
      session_id: tied,
      role: "assistant",
      content: "Another answer.",
      grounding: "documents",
    },
  ]);
  if (tieError) throw new Error(`seeding the tied rows failed: ${tieError.message}`);

  const [{ distinct_timestamps: tieStamps }] = await sql()`
    select count(distinct created_at) as distinct_timestamps
      from public.messages where session_id = ${tied}
  `;
  // The premise, asserted rather than assumed: without the tie there is nothing
  // for the lateral's comparison to get wrong.
  if (Number(tieStamps) !== 1) {
    throw new Error(`the tied rows did not tie: ${tieStamps} distinct timestamps`);
  }
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
 * Observable BOTH through the table and by calling the function, and the table
 * is the stronger of the two.
 *
 * It was not obvious that it would be: `routines_source_kind_check` refuses an
 * unknown `source_kind` with `23514`, so the obvious expectation is that an
 * insert never reaches the policy. It does. **PostgreSQL evaluates a row level
 * security WITH CHECK before the table's own CHECK constraints** — verified
 * directly, with a throwaway table carrying a policy and a constraint that a
 * single row violated at once, which came back `42501`. So an unknown kind
 * inserted by an admin returns `42501` under the allow-list and `23514` under
 * 0073's deny-list, and the error code alone tells the two bodies apart.
 *
 * The function is still called directly as well, because it answers three
 * questions the table cannot ask separately, and because it is callable by
 * anybody — PUBLIC keeps its default EXECUTE on it, which is correct for a
 * helper that is not SECURITY DEFINER and discloses nothing the caller could
 * not ask for directly.
 */
describe("the source-kind allow-list", () => {
  /**
   * Through the table, as the user whose privilege is in question.
   *
   * `42501` is the policy — the allow-list refusing a kind nobody has decided
   * about. `23514` would mean the policy let it through and the vocabulary
   * constraint caught it instead, which is exactly what 0073's deny-list did
   * and what a future `source_kind` would walk past.
   */
  it("refuses a kind nobody has decided about, at the policy", async () => {
    const { error } = await admin.db.from("routines").insert(
      workspaceRoutine(admin, admin.workspaceId, seeded.agentId, seeded.channelId, {
        source_kind: "a_kind_from_0085",
        source_config: { report: "coverage_gaps" },
      }),
    );

    expect(error).not.toBeNull();
    expect(
      error!.code,
      "23514 means the vocabulary constraint refused it and the guard did not",
    ).toBe(RLS_REFUSED);
  });

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
   * No UPDATE, at the grant rather than at a policy, FOR ANY ROLE.
   *
   * There is nothing to update — the row exists or it does not — and a
   * table-level UPDATE with no UPDATE policy to narrow it is the shape 0023
   * left on `workspace_members`, which is the hole this table exists to avoid.
   *
   * `service_role` is asserted too, and it was the gap in the first draft:
   * Supabase's `alter default privileges` gives a new table
   * `service_role=arwdDxtm`, so the migration's claim that its grants are
   * "named rather than inherited" was false of the most privileged of the three
   * roles. Named now, and named as the same three.
   */
  it("grants no UPDATE at all, to anybody", async () => {
    const [row] = await sql()`
      select has_table_privilege('authenticated', 'public.coverage_opt_outs', 'update') as upd,
             has_table_privilege('authenticated', 'public.coverage_opt_outs', 'select') as sel,
             has_table_privilege('authenticated', 'public.coverage_opt_outs', 'insert') as ins,
             has_table_privilege('authenticated', 'public.coverage_opt_outs', 'delete') as del,
             has_table_privilege('anon', 'public.coverage_opt_outs', 'select') as anon_sel,
             has_table_privilege('service_role', 'public.coverage_opt_outs', 'update') as svc_upd,
             has_table_privilege('service_role', 'public.coverage_opt_outs', 'select') as svc_sel
    `;
    expect(row.upd).toBe(false);
    expect(row.svc_upd, "service_role still holds UPDATE by inheritance").toBe(false);
    expect(row.anon_sel).toBe(false);
    expect([row.sel, row.ins, row.del, row.svc_sel]).toEqual([true, true, true, true]);
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
 * The read, and the two layers that decide who gets an answer.
 *
 * `workspace_coverage_gaps` and `workspace_coverage_totals` take the owner's
 * user id explicitly, because the caller that actually runs the report is the
 * service role and `auth.uid()` is null for it — measured, not assumed, and the
 * reason is in 0074's header at length.
 *
 * **EXECUTE IS GRANTED TO `service_role` ONLY**, so every answering test below
 * goes through `serviceClient()`. That is not a convenience, it is the caller
 * the feature has. A grant to `authenticated` — which the plan shipped and
 * which 0053's pair uses — would hand an admin the raw truncated questions
 * straight out of PostgREST: no clustering, no topic label, and no
 * distinct-asker floor, because `askerFloor()` lives in
 * `lib/routines/coverage-cluster.ts` and is not a boundary for a caller that
 * never goes through the worker. 0074's header claims "no question ever reaches
 * an admin"; the grant is what makes that true.
 *
 * So the refusals come in two layers and both are tested: the GRANT, which
 * refuses every signed-in caller and the public internet, and the GUARDS INSIDE
 * the function, which refuse the service role when the named owner is not an
 * admin or the workspace has the report switched off.
 */
describe("the read", () => {
  // ---- layer one: who may call it at all ----------------------------------

  /**
   * An admin is refused, and that is the point rather than a side effect.
   *
   * Asserted on the message as well as the code, because the body raises
   * `42501` too and the two are not the same refusal: this has to be the
   * privilege check Postgres makes BEFORE the function runs, or an admin is
   * reading unclustered, unfloored questions and the header's promise is false.
   */
  it("refuses every signed-in caller, admin included", async () => {
    for (const caller of [admin, member, member2]) {
      for (const fn of ["workspace_coverage_gaps", "workspace_coverage_totals"]) {
        const { data, error } = await caller.db.rpc(fn, {
          p_workspace_id: admin.workspaceId,
          p_user_id: caller.id,
          p_days: 7,
        });

        expect(data ?? [], `${fn} answered ${caller.email}`).toEqual([]);
        expect(error, `${fn} answered ${caller.email}`).not.toBeNull();
        expect(error!.code).toBe(RLS_REFUSED);
        expect(error!.message, `${fn} refused ${caller.email} for the wrong reason`).toMatch(
          /permission denied for function/,
        );
      }
    }
  });

  /**
   * THE WAY ROUND THE ESCALATION GUARD, AND THE REASON THE GRANT IS TWO ROLES
   * NARROWER THAN THE PLAN'S.
   *
   * The guard inside lets a caller with no `auth.uid()` name anybody, because
   * that caller is supposed to be the service role. `anon` also has no
   * `auth.uid()`. The plan's grant block — 0053's, copied — revoked PUBLIC and
   * granted `authenticated, service_role`, and on this stack that left `anon`
   * holding EXECUTE: Supabase ships
   * `alter default privileges ... grant execute on functions to anon, ...`, so
   * the grant is held BY NAME and `revoke ... from public` does not reach it.
   *
   * Reproduced against the first draft of 0074 with nothing but the anon key, a
   * workspace id and an admin's user id — all three of which any plain member
   * has, since `workspace_members_select_fellow_members` hands over `user_id`
   * and `role`. It answered with a result. So this is not a hygiene test: it is
   * the escalation guard being walked around by dropping the Authorization
   * header.
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
   * The grant itself, read out of the catalog.
   *
   * The two tests above would also pass with the grant wide open, because the
   * body's own guards would refuse `anon` and would refuse an admin naming
   * somebody else. This is the half that fails if somebody widens EXECUTE and
   * trusts the body — which is the configuration the plan shipped, and the one
   * where an admin gets 150 unfloored questions by asking about themselves.
   */
  it("grants the two reads to the routine runner and nobody else", async () => {
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
      expect(row.authenticated, `${row.proname} is reachable by any signed-in user`).toBe(false);
      expect(row.service_role).toBe(true);
      // A definer function without a pinned search_path is resolvable against
      // whatever the caller put on theirs.
      expect(row.prosecdef).toBe(true);
      expect(row.proconfig).toEqual(["search_path=pg_catalog, public"]);
    }
  });

  /**
   * The dead branch, proved not to be broken.
   *
   * `if auth.uid() is not null and p_user_id is distinct from auth.uid()` is
   * unreachable while EXECUTE is `service_role` only, and it stays in the
   * function because the grant on these two has already been wrong once. A
   * comment claiming it would still hold is worth less than a test, so this
   * test puts the plan's grant back for the length of one call and checks that
   * the impersonation is refused by the BODY rather than by the grant.
   *
   * The grant is restored in a `finally`, and the assertion on the message is
   * what tells the two refusals apart: `permission denied for function` is the
   * grant, `may only ask about yourself` is the branch under test.
   */
  it("still refuses an impersonation if the grant is ever widened again", async () => {
    await sql()`grant execute on function
      public.workspace_coverage_gaps(uuid, uuid, int) to authenticated`;
    try {
      const { data, error } = await member.db.rpc("workspace_coverage_gaps", {
        p_workspace_id: admin.workspaceId,
        p_user_id: admin.id,
        p_days: 7,
      });

      expect(data ?? [], "a member read the admin's gap list").toEqual([]);
      expect(error).not.toBeNull();
      expect(error!.code).toBe(RLS_REFUSED);
      expect(error!.message).toMatch(/may only ask about yourself/);
    } finally {
      await sql()`revoke execute on function
        public.workspace_coverage_gaps(uuid, uuid, int) from authenticated`;
    }
  });

  // ---- layer two: the guards inside ---------------------------------------

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
    expect(error!.message).toMatch(/not an admin of this workspace/);
  });

  it("refuses the same of the totals", async () => {
    const { error } = await serviceClient().rpc("workspace_coverage_totals", {
      p_workspace_id: admin.workspaceId,
      p_user_id: member.id,
      p_days: 7,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  it("refuses the service role naming nobody at all", async () => {
    const { error } = await serviceClient().rpc("workspace_coverage_gaps", {
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
  it("refuses a workspace that has not turned it on", async () => {
    const { error } = await serviceClient().rpc("workspace_coverage_gaps", {
      p_workspace_id: stranger.workspaceId,
      p_user_id: stranger.id,
      p_days: 7,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
    expect(error!.message).toMatch(/not enabled for this workspace/);
  });

  it("refuses the totals for a workspace that has not turned it on", async () => {
    const { error } = await serviceClient().rpc("workspace_coverage_totals", {
      p_workspace_id: stranger.workspaceId,
      p_user_id: stranger.id,
      p_days: 7,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
  });

  // ---- what it answers ----------------------------------------------------

  it("answers the routine runner, and never with a user id", async () => {
    const { data, error } = await readGaps();

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
   * the member's question lives in a private session nobody else can read a
   * row of. The premise is asserted first, so a failure cannot be read as the
   * seeding being wrong.
   */
  it("finds a question no admin can read directly", async () => {
    const direct = await admin.db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("content", MEMBER_QUESTION);
    expect(direct.count, "the admin could read the member's question directly").toBe(0);

    const { data } = await readGaps();
    expect(questionsFrom(data)).toContain(MEMBER_QUESTION);
  });

  /**
   * THE ATTRIBUTION BUG, FIRST HALF. A member may legitimately post a question
   * into a colleague's SHARED session — `messages_insert_user_self` (0018) says
   * so, and the seeding above does it through the member's own client rather
   * than the service role precisely to prove it.
   *
   * The first draft of this read selected `s.user_id` — the session OWNER — as
   * the asker, so this question was credited to the admin. Two harms followed,
   * and this test binds the one that breaks the floor: one person asking the
   * same thing in three colleagues' rooms would have produced three distinct
   * asker keys and cleared `askerFloor()`'s three, reporting a topic ONE
   * identifiable person raised as if three had.
   *
   * Asserted as an identity rather than against a constant, which is what makes
   * it a test of attribution and not of ranking: the member's question in their
   * OWN session and the member's question in the ADMIN'S session must carry the
   * SAME key, and the admin's own question must carry a different one.
   */
  it("credits the member who asked in a colleague's shared session", async () => {
    const { data } = await readGaps();
    const rows = (data ?? []) as GapRow[];

    const inTheirOwn = rows.find((r) => r.question === MEMBER_QUESTION);
    const inTheAdmins = rows.find((r) => r.question === CROSS_ASKER_QUESTION);
    const theAdmins = rows.find((r) => r.question.startsWith("x"));

    expect(inTheirOwn, "the member's own question went missing").toBeDefined();
    expect(inTheAdmins, "the question asked in the shared session went missing").toBeDefined();
    expect(theAdmins, "the admin's own question went missing").toBeDefined();

    expect(
      inTheAdmins!.asker_key,
      "a question is credited to whoever owns the room rather than whoever asked",
    ).toBe(inTheirOwn!.asker_key);
    expect(inTheAdmins!.asker_key).not.toBe(theAdmins!.asker_key);
  });

  it("gives the three askers three different keys, and none is a user id", async () => {
    const { data } = await readGaps();

    const keys = new Set(((data ?? []) as GapRow[]).map((r) => r.asker_key));
    expect(keys.size).toBe(3);
    for (const key of keys) {
      expect(Number.isInteger(key)).toBe(true);
      for (const user of [admin, member, member2]) expect(String(key)).not.toBe(user.id);
    }
  });

  /**
   * The key is opaque on its own terms, not merely because of a grant.
   *
   * `dense_rank() over (order by sub.asker)` is monotone in `user_id`, and
   * `workspace_members_select_fellow_members` lets any member read every
   * member's `user_id` — so key 1 was the lowest-uuid asker present, which was
   * probed and confirmed. A per-call salt fixes it.
   *
   * Necessarily a statistical test, because what is being asserted is that a
   * value is random. With three askers the ranking is one of six permutations,
   * so twelve calls agreeing by chance has probability 6 ** -11, about 3e-9 —
   * lower than the odds of any other flake in this suite. The unsalted version
   * produces the SAME mapping every time, so it fails on the second call.
   *
   * Two assertions, because each catches something the other does not: that the
   * mapping varies at all, and that at least one call disagrees with the
   * user-id ordering an attacker would use.
   */
  it("does not rank the asker keys by user id", async () => {
    // The ranking an unsalted `order by sub.asker` produces: key N goes to the
    // asker holding the Nth-lowest uuid. This is the string an attacker with
    // the member list would compare against.
    const byUuid = [admin.id, member.id, member2.id].sort();
    const namesThem = [admin.id, member.id, member2.id]
      .map((id) => byUuid.indexOf(id) + 1)
      .join(",");

    const mappings = new Set<string>();

    for (let call = 0; call < 12; call += 1) {
      const { data, error } = await readGaps();
      expect(error, error?.message).toBeNull();
      const rows = (data ?? []) as GapRow[];

      // One marker question per asker, in a fixed order, so the three keys read
      // as a permutation that can be compared between calls.
      const seen = [
        rows.find((r) => r.question.startsWith("x"))?.asker_key,
        rows.find((r) => r.question === MEMBER_QUESTION)?.asker_key,
        rows.find((r) => r.question === MEMBER2_QUESTION)?.asker_key,
      ];
      expect(seen.every((key) => typeof key === "number")).toBe(true);
      mappings.add(seen.join(","));
    }

    expect(
      mappings.size,
      "the asker key is the same integer for the same person on every call — it is not salted",
    ).toBeGreaterThan(1);
    expect(
      [...mappings].some((m) => m !== namesThem),
      "every call ranked the askers in user-id order, so the key names them",
    ).toBe(true);
  });

  it("truncates a question to 120 characters", async () => {
    const { data } = await readGaps();

    const row = ((data ?? []) as GapRow[]).find((r) => r.question.startsWith("x"));
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
    const questions = questionsFrom((await readGaps()).data);
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
   * here is the TEXT of a question.
   */
  it("drops a question from a session its owner deleted", async () => {
    const questions = questionsFrom((await readGaps()).data);
    expect(questions).not.toContain(DELETED_QUESTION);
    expect(questions).toContain(MEMBER_QUESTION);
  });

  /**
   * One question, answered twice, is one gap.
   *
   * 0050 supersedes a regenerated reply rather than deleting it, and the
   * retired row keeps its `grounding` — so without the filter the same question
   * arrives twice, consumes two of the 150 rows, and counts twice in the
   * report's `questions` figure once the worker's dedupe adds up `copies`.
   */
  it("drops a regenerated reply's duplicate of the same question", async () => {
    const questions = questionsFrom((await readGaps()).data);
    expect(questions.filter((q) => q === SUPERSEDED_QUESTION).length).toBe(1);
  });

  /**
   * A timestamp tie attaches nothing, not the wrong question.
   *
   * `created_at` defaults to `now()`, which is the transaction's timestamp, so
   * a user row and an assistant row written in ONE statement carry the
   * identical value. With `m2.created_at <= m.created_at` and
   * `order by created_at desc limit 1` the tie was broken arbitrarily:
   * measured, both of this session's replies came back attached to the FIRST
   * question, duplicating it and losing the second entirely. `<` answers
   * nothing instead, which is the same ruling the one-character filter makes —
   * an older question the reply did not answer is worse than no row.
   *
   * The seeding asserts the tie actually tied before this runs, so a failure
   * here cannot be the fixture.
   */
  it("attaches nothing rather than the wrong question on a timestamp tie", async () => {
    const questions = questionsFrom((await readGaps()).data);
    expect(questions).not.toContain(TIE_QUESTION_A);
    expect(questions).not.toContain(TIE_QUESTION_B);
  });

  /**
   * The window is clamped, and the clamp is asserted rather than the absence of
   * an error. An API key is a caller too (0033), and 0053's rule is that a
   * function reading across every private session does not take an unbounded
   * integer from any of them — `greatest(1, least(coalesce(p_days, 7), 365))`.
   */
  it("clamps an absurd window to the same rows as the maximum", async () => {
    const absurd = await readGaps(10_000_000);
    const maximum = await readGaps(365);
    const negative = await readGaps(-40);
    const one = await readGaps(1);

    expect(absurd.error, absurd.error?.message).toBeNull();
    expect(negative.error, negative.error?.message).toBeNull();

    // Compared as SETS, not as sequences, and the reason is worth recording:
    // the function's final `select ... from sub` carries no ORDER BY, so the
    // row order it returns is whatever the plan produced and genuinely varies
    // between two calls on identical data — this test caught it doing so. That
    // is a cost rather than a defect, and a small one: the worker dedupes
    // before the model call, `enforceFloor` sorts its own output, and
    // `coverage-render.ts` renders from that — so the delivered report is
    // byte-stable either way. What varies is the prompt's member numbering,
    // which costs a prompt-cache hit on a weekly job whose cache has long
    // since expired.
    expect(questionsFrom(absurd.data).sort()).toEqual(questionsFrom(maximum.data).sort());
    // And the bottom of the clamp, which is the other half of `greatest`.
    expect(questionsFrom(negative.data).sort()).toEqual(questionsFrom(one.data).sort());
    // Not vacuous: a window that excludes everything would make both sides
    // equal and empty.
    expect(questionsFrom(absurd.data).length).toBeGreaterThan(0);
  });

  /**
   * THE ATTRIBUTION BUG, SECOND HALF, and the harm that made it Critical.
   *
   * The opt-out is the only consent control in a feature that deliberately
   * ships without a consent step. Filtering it on the session owner meant a
   * member who excluded themselves was still reported for anything they had
   * asked in somebody else's room — and a member cannot delete a session they
   * do not own either, so NEITHER of their two redaction routes reached it.
   *
   * Retroactive as well, which is the other half of the point: both questions
   * are already in the window and already in the list above. A control that
   * only applied going forward would ask somebody to have decided before they
   * knew the feature existed.
   *
   * Last in this describe, because it changes what every test above reads.
   */
  it("drops an opted-out member's questions wherever they were asked", async () => {
    const { error: optedOut } = await member.db
      .from("coverage_opt_outs")
      .insert({ workspace_id: admin.workspaceId, user_id: member.id });
    expect(optedOut, optedOut?.message).toBeNull();

    const questions = questionsFrom((await readGaps()).data);

    expect(questions, "the opt-out did not reach their own session").not.toContain(MEMBER_QUESTION);
    expect(
      questions,
      "the opt-out did not reach a question they asked in somebody else's shared session",
    ).not.toContain(CROSS_ASKER_QUESTION);

    // The other two askers are untouched, so this is an exclusion and not an
    // empty read.
    expect(questions.some((q) => q.startsWith("x"))).toBe(true);
    expect(questions).toContain(MEMBER2_QUESTION);
  });
});

/**
 * The totals the report prints beside the gap list.
 *
 * 0053's `workspace_coverage` could not be reused: it has the same `auth.uid()`
 * problem, and fixing it would mean replacing a shipped function the live
 * coverage screen calls on every load, inside the migration that adds a
 * privacy-sensitive read. So the aggregation is duplicated — and the last two
 * tests here are what keep the duplicate honest.
 */
describe("the totals, in step with 0053", () => {
  /**
   * Nine fallback replies in sessions that still exist.
   *
   * Counted one by one, because every number in this file should be traceable
   * to a row somebody seeded: the admin's long question, their superseded pair
   * (TWO — the totals do not filter `superseded_at`, only the gap read does),
   * their two tied replies, the member's own question, their stray keystroke,
   * their question in the shared session, and the second member's. The deleted
   * session's reply is the tenth and is excluded.
   */
  it("returns 0053's five buckets to the routine runner", async () => {
    const { data, error } = await readTotals();

    expect(error, error?.message).toBeNull();
    const row = (data ?? [])[0];
    expect(Object.keys(row).sort()).toEqual([
      "answers",
      "covered",
      "fallback",
      "ungrounded",
      "unrecorded",
    ]);
    expect(Number(row.fallback)).toBe(9);
    expect(Number(row.answers)).toBe(
      Number(row.covered) + Number(row.fallback) + Number(row.ungrounded),
    );
  });

  /**
   * The gap list is shorter than the totals, and the reasons are named.
   *
   * Four of them, and only one is the opt-out: a one-character question, a
   * session its owner deleted, a superseded duplicate, and two replies whose
   * question tied with them to the microsecond. A count cannot identify
   * anybody, which is 0053's own argument for shipping these ungated; the
   * sentence somebody typed can, which is why the other function filters
   * harder. If somebody later makes the two agree row for row, they should have
   * to change this test and say why.
   */
  it("counts what the gap read deliberately will not return", async () => {
    const totals = await readTotals();
    const gaps = await readGaps();

    expect(Number((totals.data ?? [])[0].fallback)).toBe(9);
    // Three questions survive by this point: the admin's long one, their
    // superseded one, and the second member's. The member opted out above.
    expect((gaps.data ?? []).length).toBe(3);
  });

  it("refuses a signed-in caller the same way the gap read does", async () => {
    const { error } = await admin.db.rpc("workspace_coverage_totals", {
      p_workspace_id: admin.workspaceId,
      p_user_id: admin.id,
      p_days: 7,
    });

    expect(error).not.toBeNull();
    expect(error!.code).toBe(RLS_REFUSED);
    expect(error!.message).toMatch(/permission denied for function/);
  });

  /**
   * The duplication, checked rather than promised — and checked in the one
   * shape that is actually true.
   *
   * 0074 says the two functions' BUCKET DEFINITIONS must stay in step, which is
   * narrower than "identical" and is the whole claim: the five
   * `count(*) filter (...)` expressions, the denominator and the window are the
   * same, and the WHERE clause deliberately is not. So this asserts equality on
   * four buckets and the one known delta on the other two — the soft-deleted
   * session's single `documents` reply, which 0053 counts and this does not.
   *
   * 0053's missing filter is a defect in 0053 and is recorded as a follow-up
   * beyond this phase. It is deliberately NOT fixed here: that function is what
   * the live coverage screen calls, and this migration is not the place to
   * change what that screen reports.
   */
  it("agrees with public.workspace_coverage but for the deleted session", async () => {
    const mine = await readTotals();
    // 0053's function still checks `is_workspace_admin(auth.uid())`, so it has
    // to be asked as the admin rather than as the service role.
    const theirs = await admin.db.rpc("workspace_coverage", {
      p_workspace_id: admin.workspaceId,
      p_days: 7,
    });

    expect(mine.error, mine.error?.message).toBeNull();
    expect(theirs.error, theirs.error?.message).toBeNull();

    const ours = (mine.data ?? [])[0];
    const theirRow = (theirs.data ?? [])[0];

    // One `documents` reply lives in the soft-deleted session, so it is in both
    // the denominator and the fallback bucket over there and in neither here.
    expect(Number(theirRow.answers) - Number(ours.answers)).toBe(1);
    expect(Number(theirRow.fallback) - Number(ours.fallback)).toBe(1);
    // And nothing else may differ. If a bucket definition drifts, this fails.
    expect(Number(ours.covered)).toBe(Number(theirRow.covered));
    expect(Number(ours.ungrounded)).toBe(Number(theirRow.ungrounded));
    expect(Number(ours.unrecorded)).toBe(Number(theirRow.unrecorded));
  });
});

/**
 * Who may turn the report on.
 *
 * `beforeAll` flips `gap_report_enabled` with the service role, so without this
 * the WRITE side of what 0074's header calls "the whole of its safety" is never
 * exercised by an unprivileged caller. It does hold — `workspaces_update_admin`
 * (0001) is admin-only on both its USING and its WITH CHECK — but it holds by a
 * policy this migration does not own, on a column this migration adds, to a
 * table whose row-level UPDATE cannot tell one column from another. That is the
 * exact trap 0074 spends a paragraph on for `workspace_members`; here it lands
 * on the right side, and nothing was checking that it had.
 */
describe("who may turn the report on", () => {
  it("refuses a plain member of the workspace", async () => {
    // Turning it OFF is the assertable direction here, because `beforeAll`
    // already turned it on — and the same policy decides both.
    await member.db
      .from("workspaces")
      .update({ gap_report_enabled: false })
      .eq("id", admin.workspaceId);

    const { data } = await serviceClient()
      .from("workspaces")
      .select("gap_report_enabled")
      .eq("id", admin.workspaceId)
      .single();
    expect(data!.gap_report_enabled, "a plain member switched the report off").toBe(true);
  });

  it("refuses somebody who is not in the workspace at all", async () => {
    await admin.db
      .from("workspaces")
      .update({ gap_report_enabled: true })
      .eq("id", stranger.workspaceId);

    const { data } = await serviceClient()
      .from("workspaces")
      .select("gap_report_enabled")
      .eq("id", stranger.workspaceId)
      .single();
    expect(data!.gap_report_enabled, "an outsider turned on somebody else's report").toBe(false);
  });

  it("lets an admin of the workspace turn it on", async () => {
    // The admit path, so the two refusals above are not passing because nobody
    // can write this column at all.
    const { error } = await stranger.db
      .from("workspaces")
      .update({ gap_report_enabled: true })
      .eq("id", stranger.workspaceId);
    expect(error, error?.message).toBeNull();

    const { data } = await serviceClient()
      .from("workspaces")
      .select("gap_report_enabled")
      .eq("id", stranger.workspaceId)
      .single();
    expect(data!.gap_report_enabled).toBe(true);

    // Put it back, so nothing after this file depends on the order it ran in.
    await serviceClient()
      .from("workspaces")
      .update({ gap_report_enabled: false })
      .eq("id", stranger.workspaceId);
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
