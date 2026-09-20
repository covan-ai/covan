/**
 * What the coverage report is allowed to see, and who is allowed to ask.
 *
 * `workspace_coverage` and `workspace_coverage_agents` (0053) are SECURITY
 * DEFINER for the reason 0032's `workspace_usage_all` is: the question is how
 * this workspace's answers were grounded, and a workspace's answers live mostly
 * in sessions the caller cannot see. Chats are private by default, so an
 * admin's own RLS view of `messages` excludes exactly the traffic being asked
 * about.
 *
 * A definer function that reads past RLS is only as safe as the check it makes
 * for itself, and that check cannot be tested against a fake — it needs a real
 * Postgres with real policies and a real `auth.uid()`. That is what this file
 * is for. The three things worth failing over: an admin sees replies they could
 * not read directly, a member is refused rather than quietly given less, and
 * neither function can name the person who asked.
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
let colleague: TestUser;
let seeded: Seeded;
/** An agent nobody asks anything, to hold the LEFT JOIN honest. */
let quietAgentId: string;

/**
 * Assistant rows carry no sender and cannot be written by any client since
 * 0018 — the worker writes them with the service role, and so does this.
 * `grounding` is the column the whole report reads.
 */
async function replyIn(sessionId: string, grounding: string | null) {
  const { error } = await serviceClient().from("messages").insert({
    session_id: sessionId,
    role: "assistant",
    content: "An answer.",
    grounding,
  });
  if (error) throw new Error(`could not seed an assistant reply: ${error.message}`);
}

beforeAll(async () => {
  owner = await createTestUser("coverage-owner");
  colleague = await createTestUser("coverage-colleague");

  // Private, which is the default and the case that makes the definer function
  // necessary: the owner's own view of `messages` will not include the
  // colleague's session below.
  seeded = await seedWorkspace(owner, "private");

  const { error: memberError } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: owner.workspaceId, user_id: colleague.id, role: "member" });
  if (memberError) throw new Error(`could not add the colleague: ${memberError.message}`);

  const { data: quiet, error: agentError } = await owner.db
    .from("agents")
    .insert({
      workspace_id: owner.workspaceId,
      name: "An agent nobody asked",
      created_by: owner.id,
    })
    .select("id")
    .single();
  if (agentError) throw new Error(`could not seed the quiet agent: ${agentError.message}`);
  quietAgentId = quiet.id;

  // The owner's own replies: one grounded on a passage, one that fell back to
  // whole documents, one with nothing to stand on.
  await replyIn(seeded.sessionId, "chunks");
  await replyIn(seeded.sessionId, "documents");
  await replyIn(seeded.sessionId, "none");

  // A reply from before 0039 existed, which has no grounding at all. It must be
  // counted apart rather than folded into the denominator.
  await replyIn(seeded.sessionId, null);

  // And the colleague's own PRIVATE session. The owner cannot read a row of
  // this through their own client; the report still has to count it.
  const { data: theirs, error: sessionError } = await colleague.db
    .from("chat_sessions")
    .insert({
      agent_id: seeded.agentId,
      user_id: colleague.id,
      workspace_id: owner.workspaceId,
      visibility: "private",
      title: "A colleague's private session",
    })
    .select("id")
    .single();
  if (sessionError) throw new Error(`could not seed the private session: ${sessionError.message}`);

  await replyIn(theirs.id, "documents");
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("the workspace coverage figures", () => {
  it("count replies in sessions the admin cannot read directly", async () => {
    // The premise first, so a failure below cannot be read as the seeding being
    // wrong: the owner genuinely cannot see the colleague's private replies.
    const direct = await owner.db
      .from("messages")
      .select("id", { count: "exact", head: true })
      .eq("grounding", "documents");
    expect(direct.count, "the owner could read a private reply directly").toBe(1);

    const { data, error } = await owner.db.rpc("workspace_coverage", {
      p_workspace_id: owner.workspaceId,
    });
    expect(error, error?.message).toBeNull();

    const row = (data ?? [])[0];
    // Four with a grounding from the owner's session plus one from the
    // colleague's, minus the one that has none: `answers` counts the recorded.
    expect(Number(row.answers)).toBe(4);
    expect(Number(row.covered)).toBe(1);
    // Both `documents` replies, and the second one is only reachable past RLS.
    expect(Number(row.fallback)).toBe(2);
    expect(Number(row.ungrounded)).toBe(1);
  });

  it("keep the replies from before the column existed out of the denominator", async () => {
    const { data } = await owner.db.rpc("workspace_coverage", {
      p_workspace_id: owner.workspaceId,
    });
    const row = (data ?? [])[0];

    // Reported, not dropped: a workspace older than 0039 would otherwise read
    // its first report as a census when it is a sample.
    expect(Number(row.unrecorded)).toBe(1);
    expect(Number(row.answers)).toBe(
      Number(row.covered) + Number(row.fallback) + Number(row.ungrounded),
    );
  });

  it("refuse a member outright rather than quietly returning less", async () => {
    const { error } = await colleague.db.rpc("workspace_coverage", {
      p_workspace_id: owner.workspaceId,
    });

    // A silent empty result is indistinguishable from a workspace nobody has
    // asked anything in, and the route has to tell 403 from "nothing yet".
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("say nothing about who asked", async () => {
    const { data } = await owner.db.rpc("workspace_coverage", {
      p_workspace_id: owner.workspaceId,
    });

    // Not a rule the interface is asked to follow: there is no user_id in the
    // return type, so no screen can break this by choosing to. A count cannot
    // identify anybody; the sentence somebody typed can, and neither function
    // returns a word of content.
    const keys = Object.keys((data ?? [])[0] ?? {});
    expect(keys).not.toContain("user_id");
    expect(keys).not.toContain("content");
  });
});

describe("the per-agent coverage figures", () => {
  it("keep an agent nobody asked, at zero", async () => {
    const { data, error } = await owner.db.rpc("workspace_coverage_agents", {
      p_workspace_id: owner.workspaceId,
    });
    expect(error, error?.message).toBeNull();

    // The LEFT JOIN discipline 0032 set. "Nobody used this one" is also an
    // answer, and a list that silently omits it cannot give it.
    const quiet = (data ?? []).find((r: { agent_id: string }) => r.agent_id === quietAgentId);
    expect(quiet, "an agent vanished because nobody had asked it anything").toBeDefined();
    expect(Number(quiet.answers)).toBe(0);
  });

  it("attribute the colleague's private replies to the agent that answered them", async () => {
    const { data } = await owner.db.rpc("workspace_coverage_agents", {
      p_workspace_id: owner.workspaceId,
    });
    const row = (data ?? []).find((r: { agent_id: string }) => r.agent_id === seeded.agentId);

    expect(Number(row.answers)).toBe(4);
    expect(Number(row.fallback)).toBe(2);
  });

  it("refuse a member the same way the workspace figure does", async () => {
    const { error } = await colleague.db.rpc("workspace_coverage_agents", {
      p_workspace_id: owner.workspaceId,
    });
    expect(error?.code).toBe("42501");
  });
});
