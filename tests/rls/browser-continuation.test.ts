import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  anonClient,
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  type TestUser,
} from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

/**
 * `claim_browser_continuation` (0117): the step after a browser task, claimed
 * once, by the person who started it, when its answer is in the conversation
 * and nothing else is still to come in the browser's line.
 *
 * Each claim here is a claim about Postgres: the function is `security
 * definer`, so the narrowing to `auth.uid()` is the only thing between a
 * colleague in the same workspace and somebody else's conversation carrying
 * on — and "once" is one statement's update, which two tabs race.
 */

let owner: TestUser;
let colleague: TestUser;
let seeded: Seeded;

beforeAll(async () => {
  owner = await createTestUser("continuation-owner");
  colleague = await createTestUser("continuation-colleague");
  const { error } = await serviceClient().from("workspace_members").insert({
    workspace_id: owner.workspaceId,
    user_id: colleague.id,
    role: "member",
  });
  if (error) throw new Error(`seeding the colleague failed: ${error.message}`);
  seeded = await seedWorkspace(owner, "shared");
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

beforeEach(async () => {
  await serviceClient().from("browser_tasks").delete().eq("session_id", seeded.sessionId);
});

async function task(over: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await serviceClient()
    .from("browser_tasks")
    .insert({
      workspace_id: owner.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      session_id: seeded.sessionId,
      provider_task_id: `bu-${crypto.randomUUID()}`,
      task: "find twenty leads on LinkedIn",
      status: "finished",
      finished_at: new Date().toISOString(),
      delivered_at: new Date().toISOString(),
      then_step: "write the leads to a page in Qrucial",
      ...over,
    })
    .select("id")
    .single();
  if (error) throw new Error(`seeding a browser task failed: ${error.message}`);
  return data.id as string;
}

const claim = (user: TestUser) =>
  user.db.rpc("claim_browser_continuation", { p_session_id: seeded.sessionId });

describe("claim_browser_continuation", () => {
  it("hands the owner the step once, and marks it", async () => {
    const id = await task();

    const first = await claim(owner);
    expect(first.error).toBeNull();
    expect(first.data).toEqual(["write the leads to a page in Qrucial"]);

    const second = await claim(owner);
    expect(second.data).toEqual([]);

    const { data } = await owner.db
      .from("browser_tasks")
      .select("continued_at")
      .eq("id", id)
      .single();
    expect(data?.continued_at).not.toBeNull();
  });

  it("hands two racing tabs the step once between them", async () => {
    await task();
    const [a, b] = await Promise.all([claim(owner), claim(owner)]);
    const steps = [...(a.data ?? []), ...(b.data ?? [])];
    expect(steps).toEqual(["write the leads to a page in Qrucial"]);
  });

  it("does not hand a colleague the owner's step, and leaves it for the owner", async () => {
    await task();
    const theirs = await claim(colleague);
    expect(theirs.data).toEqual([]);
    expect((await claim(owner)).data).toEqual(["write the leads to a page in Qrucial"]);
  });

  it("waits for the answer to be written", async () => {
    await task({ delivered_at: null });
    expect((await claim(owner)).data).toEqual([]);
  });

  it("waits while anything else is still in the line, then hands every step in order", async () => {
    await task({ then_step: "first, the leads", created_at: "2026-10-19T19:00:00Z" });
    const next = await task({
      status: "running",
      then_step: "then, the page",
      delivered_at: null,
      finished_at: null,
      created_at: "2026-10-19T19:01:00Z",
    });
    expect((await claim(owner)).data).toEqual([]);

    await serviceClient()
      .from("browser_tasks")
      .update({ status: "finished", delivered_at: new Date().toISOString() })
      .eq("id", next);
    expect((await claim(owner)).data).toEqual(["first, the leads", "then, the page"]);
  });

  it("leaves a task that stopped short to the person", async () => {
    await task({ status: "failed", stop_reason: "partial" });
    expect((await claim(owner)).data).toEqual([]);
  });

  it("does not start work by itself long after the answer", async () => {
    await task({ delivered_at: new Date(Date.now() - 31 * 60_000).toISOString() });
    expect((await claim(owner)).data).toEqual([]);
  });

  it("is not callable without signing in", async () => {
    const { error } = await anonClient().rpc("claim_browser_continuation", {
      p_session_id: seeded.sessionId,
    });
    expect(error).not.toBeNull();
  });

  it("is still no write surface: the client cannot set the columns itself", async () => {
    const id = await task({ continued_at: null });
    await owner.db
      .from("browser_tasks")
      .update({ continued_at: new Date().toISOString(), then_step: "something else" })
      .eq("id", id);
    const { data } = await serviceClient()
      .from("browser_tasks")
      .select("continued_at, then_step")
      .eq("id", id)
      .single();
    expect(data).toEqual({ continued_at: null, then_step: "write the leads to a page in Qrucial" });
  });
});
