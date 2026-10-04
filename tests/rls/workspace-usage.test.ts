/**
 * Whose conversations the Usage figures count.
 *
 * `workspace_usage` is `security invoker`, and 0006 relied on that alone for
 * privacy: sessions were per-user, so RLS scoped the aggregate without the
 * query saying anything about whose rows it wanted. 0008 added shared sessions
 * and the select policies widened underneath it, so the totals quietly began
 * including colleagues' conversations — while the screen went on saying "Yours
 * alone". Nothing failed and no test noticed, because no test asked.
 *
 * 0022 puts the scoping in the join. This file is what keeps it there: the
 * assertion is not about a policy but about a number, which is the level the
 * mistake was made at.
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

/** Tokens on an assistant reply, which is the only kind `workspace_usage` sums. */
const OWNERS_TOKENS = 111;
const COLLEAGUES_TOKENS = 999;

async function replyIn(sessionId: string, tokens: number, model?: string | null) {
  // Assistant rows carry no sender and cannot be written by any client since
  // 0018 — the worker writes them with the service role, and so does this.
  const { error } = await serviceClient()
    .from("messages")
    .insert({
      session_id: sessionId,
      role: "assistant",
      content: "An answer.",
      prompt_tokens: tokens,
      completion_tokens: 0,
      // Undefined leaves the column alone, which is the 361 production rows
      // that predate `0065`. `null` and absent are the same thing here on
      // purpose: both mean nobody recorded a model.
      ...(model === undefined ? {} : { model }),
    });
  if (error) throw new Error(`could not seed an assistant reply: ${error.message}`);
}

beforeAll(async () => {
  owner = await createTestUser("usage-owner");
  colleague = await createTestUser("usage-colleague");

  seeded = await seedWorkspace(owner, "private");

  const { error } = await serviceClient()
    .from("workspace_members")
    .insert({ workspace_id: owner.workspaceId, user_id: colleague.id, role: "member" });
  if (error) throw new Error(`could not add the colleague: ${error.message}`);

  await replyIn(seeded.sessionId, OWNERS_TOKENS);

  // The colleague's session is SHARED, which is the case that broke it —
  // brainstorms are created shared by default, so this is the common one, not
  // an exotic configuration.
  const { data: theirs, error: sessionError } = await colleague.db
    .from("chat_sessions")
    .insert({
      agent_id: seeded.agentId,
      user_id: colleague.id,
      workspace_id: owner.workspaceId,
      visibility: "shared",
      title: "A colleague's shared session",
    })
    .select("id")
    .single();
  if (sessionError) throw new Error(`could not seed the shared session: ${sessionError.message}`);

  await replyIn(theirs.id, COLLEAGUES_TOKENS);
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

async function tokensFor(user: TestUser): Promise<number> {
  const { data, error } = await user.db.rpc("workspace_usage", {
    p_workspace_id: owner.workspaceId,
  });
  if (error) throw new Error(`workspace_usage failed: ${error.message}`);
  const row = (data ?? []).find((r: { agent_id: string }) => r.agent_id === seeded.agentId);
  return Number(row?.prompt_tokens ?? 0);
}

describe("the usage figures", () => {
  it("count the caller's own conversations and nobody else's", async () => {
    // The owner CAN read the colleague's shared session — membership.test.ts
    // asserts that, and it is correct. Being able to read it is not a reason to
    // bill it to them.
    expect(await tokensFor(owner)).toBe(OWNERS_TOKENS);
  });

  it("do not become the workspace's total for the person who can see the most", async () => {
    // The other direction, and the one that shows the bug was symmetrical:
    // before 0022 both people saw the same inflated number, so neither could
    // tell whose spending they were looking at.
    expect(await tokensFor(colleague)).toBe(COLLEAGUES_TOKENS);
  });

  it("still lists every agent in the workspace, at zero when unused", async () => {
    // The join stayed a LEFT JOIN with the condition in ON rather than WHERE.
    // Moving it would drop agents nobody has chatted with, and the Usage
    // section would silently stop showing the agents most worth noticing.
    const stranger = await createTestUser("usage-stranger");
    const { error } = await serviceClient()
      .from("workspace_members")
      .insert({ workspace_id: owner.workspaceId, user_id: stranger.id, role: "member" });
    if (error) throw new Error(error.message);

    const { data } = await stranger.db.rpc("workspace_usage", {
      p_workspace_id: owner.workspaceId,
    });
    const row = (data ?? []).find((r: { agent_id: string }) => r.agent_id === seeded.agentId);
    expect(row, "an agent vanished for someone who has not used it").toBeDefined();
    expect(Number(row.prompt_tokens)).toBe(0);
  });
});

/**
 * The other direction, added with `0032`: an admin asking what the whole
 * workspace costs.
 *
 * `workspace_usage_all` is SECURITY DEFINER because it has to be — an admin's
 * own view of `chat_sessions` deliberately excludes their colleagues' private
 * sessions, which is exactly the traffic being asked about. A definer function
 * that reads past RLS is only as safe as the check it makes for itself, and
 * that check is the thing worth a live database rather than a fake one.
 */
describe("the workspace-wide figures", () => {
  const bothPeople = OWNERS_TOKENS + COLLEAGUES_TOKENS;

  async function allFor(user: TestUser) {
    return user.db.rpc("workspace_usage_all", { p_workspace_id: owner.workspaceId });
  }

  it("count everybody's conversations for an admin, private ones included", async () => {
    const { data, error } = await allFor(owner);
    expect(error, error?.message).toBeNull();

    const row = (data ?? []).find((r: { agent_id: string }) => r.agent_id === seeded.agentId);
    // The colleague's session is shared and the owner's is private. The point
    // of the definer function is that neither of those facts changes the total.
    expect(Number(row.prompt_tokens)).toBe(bothPeople);
  });

  it("refuse a member outright rather than quietly returning their own", async () => {
    const { error } = await allFor(colleague);

    // A silent empty result is indistinguishable from a workspace that has
    // never sent a message, and the route has to tell 403 from "nothing yet".
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("say nothing about who spent it", async () => {
    const { data } = await allFor(owner);

    // Not a rule the interface is asked to follow: there is no user_id in the
    // function's return type, so no screen can break this by choosing to.
    expect(Object.keys((data ?? [])[0] ?? {})).not.toContain("user_id");
  });

  it("bucket the same total by month for an admin, and refuse a member the same way", async () => {
    const { data, error } = await owner.db.rpc("workspace_usage_monthly", {
      p_workspace_id: owner.workspaceId,
      p_months: 6,
    });
    expect(error, error?.message).toBeNull();

    // Six buckets whether or not anybody used them — a month that closes up
    // silently makes a fall in spend look like a flat line.
    expect(data).toHaveLength(6);
    const total = (data ?? []).reduce(
      (n: number, m: { prompt_tokens: number }) => n + Number(m.prompt_tokens),
      0,
    );
    expect(total).toBe(bothPeople);

    const refused = await colleague.db.rpc("workspace_usage_monthly", {
      p_workspace_id: owner.workspaceId,
      p_months: 6,
    });
    expect(refused.error?.code).toBe("42501");
  });
});

/**
 * Which model's price list a reply belongs on.
 *
 * covan#208: `0065` recorded the model on every reply and nothing read it, so
 * `/usage` priced the lot at whatever the agent is set to today. `0071` adds the
 * dimension, and the thing worth asserting against a real database is not the
 * money — that is `routes/usage.test.ts` — but that the two aggregations in one
 * row cannot drift: `by_model` has to add up to the scalar sums beside it, or
 * the screen shows one total and charges another.
 */
describe("the model each reply was priced at", () => {
  const SONNET_TOKENS = 1_234;
  const OPUS_TOKENS = 5_678;

  type Share = {
    model: string | null;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
  };
  type Row = { agent_id: string; prompt_tokens: number; by_model: Share[] | null };

  let priced: Row | undefined;

  beforeAll(async () => {
    // The agent needs a model of its own for the fallback to have anything to
    // fall back TO — `seedWorkspace` leaves it null, which is a real state and
    // the reason `estimateCostUsd` takes an unknown id to a default price.
    const setModel = await serviceClient()
      .from("agents")
      .update({ model: "gpt-4.1" })
      .eq("id", seeded.agentId);
    if (setModel.error) {
      throw new Error(`could not set the agent's model: ${setModel.error.message}`);
    }

    // One agent, three replies: two models that recorded themselves and the
    // pre-0065 shape that did not.
    await replyIn(seeded.sessionId, SONNET_TOKENS, "claude-sonnet-5");
    await replyIn(seeded.sessionId, OPUS_TOKENS, "claude-opus-5");

    const { data, error } = await owner.db.rpc("workspace_usage", {
      p_workspace_id: owner.workspaceId,
    });
    if (error) throw new Error(`workspace_usage failed: ${error.message}`);
    priced = ((data ?? []) as Row[]).find((r) => r.agent_id === seeded.agentId);
  });

  it("splits one agent's replies by the model that answered each", () => {
    const byModel = priced?.by_model ?? [];
    const sonnet = byModel.find((m) => m.model === "claude-sonnet-5");
    const opus = byModel.find((m) => m.model === "claude-opus-5");

    expect(sonnet?.promptTokens).toBe(SONNET_TOKENS);
    expect(opus?.promptTokens).toBe(OPUS_TOKENS);
  });

  it("prices a reply that recorded no model at the agent's own", () => {
    // `OWNERS_TOKENS` was seeded with the column left alone — the shape of every
    // row written before 2026-09-27T19:12Z. The fallback is in SQL so that one
    // rule has one definition, and `seedWorkspace`'s agent is what it falls back
    // to.
    const byModel = priced?.by_model ?? [];
    const named = new Set(["claude-sonnet-5", "claude-opus-5"]);
    const fallback = byModel.filter((m) => !named.has(m.model ?? ""));

    expect(fallback).toHaveLength(1);
    expect(fallback[0].promptTokens).toBe(OWNERS_TOKENS);
    // The agent's own, resolved in SQL — not a null handed to the caller to
    // work out for itself.
    expect(fallback[0].model).toBe("gpt-4.1");
  });

  it("adds up to the row it sits beside, which is what stops the two drifting", () => {
    const byModel = priced?.by_model ?? [];
    const summed = byModel.reduce((n, m) => n + Number(m.promptTokens), 0);

    expect(summed).toBe(Number(priced?.prompt_tokens));
    expect(summed).toBe(OWNERS_TOKENS + SONNET_TOKENS + OPUS_TOKENS);
  });

  it("hands the caller an array, which is how it knows the schema has the column", () => {
    // The caller reads "not an array" as "this database has not had `0071`
    // applied yet" and falls back to the old pricing — CI never applies
    // migrations, so that window is real. One entry per model that answered.
    expect(Array.isArray(priced?.by_model)).toBe(true);
    expect(priced?.by_model).toHaveLength(3);
  });
});
