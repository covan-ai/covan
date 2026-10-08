import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  closeSql,
  createTestUser,
  destroyTestUsers,
  serviceClient,
  sql,
  type TestUser,
} from "./harness";
import { seedWorkspace, type Seeded } from "./fixtures";

/**
 * `browser_tasks` spends one person's allowance at a third party, and holds
 * the id of a running browser at that third party. Three claims:
 *
 *  - The row is the OWNER's, not the room's. A shared session shows the
 *    answer to everybody (it becomes an ordinary assistant message); the task
 *    that produced it is visible only to whoever paid for it.
 *  - `provider_task_id` is withheld from every client role, for 0063's
 *    reason: one deployment-wide key means that id is the tenant boundary.
 *  - The claim is exclusive. Both Workers tick against one database, so two
 *    simultaneous claims of the same row would mean two model calls and two
 *    messages for one task. `for update skip locked` is not something a mock
 *    can be wrong about safely.
 */

let owner: TestUser;
let colleague: TestUser;
let outsider: TestUser;
let seeded: Seeded;
let taskId: string;

beforeAll(async () => {
  owner = await createTestUser("browser-owner");
  colleague = await createTestUser("browser-colleague");
  outsider = await createTestUser("browser-outsider");

  const service = serviceClient();
  const { error: memberError } = await service.from("workspace_members").insert({
    workspace_id: owner.workspaceId,
    user_id: colleague.id,
    role: "member",
  });
  if (memberError) throw new Error(`seeding the colleague failed: ${memberError.message}`);

  seeded = await seedWorkspace(owner, "shared");

  const { data, error } = await service
    .from("browser_tasks")
    .insert({
      workspace_id: owner.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      session_id: seeded.sessionId,
      provider_task_id: "bu-task-secret",
      task: "read the pricing table on example.com and list the tiers",
    })
    .select("id")
    .single();
  if (error) throw new Error(`seeding the browser task failed: ${error.message}`);
  taskId = data.id as string;
});

afterAll(async () => {
  await destroyTestUsers([owner, colleague, outsider]);
  await closeSql();
});

describe("browser_tasks", () => {
  it("is visible to the person whose allowance paid for it", async () => {
    const { data, error } = await owner.db.from("browser_tasks").select("id, task, status");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.status).toBe("queued");
  });

  /**
   * The difference from `paused_turns`, stated as a test. A colleague can see
   * the conversation and will see the ANSWER when it arrives, because that is
   * an ordinary assistant message. The task row is not theirs.
   */
  it("is invisible to a colleague in the same shared session", async () => {
    const { data } = await colleague.db.from("browser_tasks").select("id");
    expect(data).toEqual([]);
  });

  it("is invisible to somebody outside the workspace", async () => {
    const { data } = await outsider.db.from("browser_tasks").select("id");
    expect(data).toEqual([]);
  });

  it("does not hand the provider's task id to any client", async () => {
    const { error } = await owner.db.from("browser_tasks").select("provider_task_id");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("refuses a wildcard select, so the withheld column cannot be read sideways", async () => {
    const { error } = await owner.db.from("browser_tasks").select("*");
    expect(error).not.toBeNull();
  });

  it("cannot be marked finished from the browser", async () => {
    const { data } = await owner.db
      .from("browser_tasks")
      .update({ status: "finished", output: "trust me" })
      .eq("id", taskId)
      .select("id");
    expect(data ?? []).toEqual([]);
    const { data: after } = await serviceClient()
      .from("browser_tasks")
      .select("status, output")
      .eq("id", taskId)
      .single();
    expect(after?.status).toBe("queued");
    expect(after?.output).toBeNull();
  });

  it("cannot be invented by a client", async () => {
    const { error } = await owner.db.from("browser_tasks").insert({
      workspace_id: owner.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      session_id: seeded.sessionId,
      provider_task_id: "made-up",
      task: "pretend this finished",
    });
    expect(error).not.toBeNull();
  });

  it("refuses a status nothing in the code writes", async () => {
    const { error } = await serviceClient()
      .from("browser_tasks")
      .update({ status: "waiting_browser" })
      .eq("id", taskId);
    expect(error?.code).toBe("23514");
  });
});

describe("claim_due_browser_tasks", () => {
  /** Make a task due, the way a tick would find it. */
  async function makeDue(id: string) {
    await sql()`
      update public.browser_tasks
      set status = 'running',
          claimed_at = null,
          next_poll_at = now() - interval '1 minute'
      where id = ${id}
    `;
  }

  async function claimedIds(limit = 50): Promise<string[]> {
    const { data, error } = await serviceClient().rpc("claim_due_browser_tasks", {
      p_limit: limit,
    });
    if (error) throw new Error(error.message);
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  }

  it("hands out a task that is due", async () => {
    await makeDue(taskId);
    expect(await claimedIds()).toContain(taskId);
  });

  it("does not hand out the same task twice", async () => {
    await makeDue(taskId);
    expect(await claimedIds()).toContain(taskId);
    // Second claim, same row, no stale window elapsed.
    expect(await claimedIds()).not.toContain(taskId);
  });

  it("does not hand out a task that has already finished", async () => {
    await sql()`
      update public.browser_tasks
      set status = 'finished', claimed_at = null, next_poll_at = now() - interval '1 minute'
      where id = ${taskId}
    `;
    expect(await claimedIds()).not.toContain(taskId);
  });

  it("does not hand out a task whose next poll is in the future", async () => {
    await sql()`
      update public.browser_tasks
      set status = 'running', claimed_at = null, next_poll_at = now() + interval '10 minutes'
      where id = ${taskId}
    `;
    expect(await claimedIds()).not.toContain(taskId);
  });

  it("hands a stale claim back out, because that worker died mid-poll", async () => {
    await sql()`
      update public.browser_tasks
      set status = 'running',
          claimed_at = now() - interval '30 minutes',
          next_poll_at = now() - interval '1 minute'
      where id = ${taskId}
    `;
    expect(await claimedIds()).toContain(taskId);
  });

  /**
   * The one that cannot be mocked. Two concurrent claims against the real
   * database, and exactly one of them may see the row.
   */
  it("gives one task to exactly one of two concurrent ticks", async () => {
    await makeDue(taskId);
    const [first, second] = await Promise.all([claimedIds(), claimedIds()]);
    const winners = [first, second].filter((ids) => ids.includes(taskId));
    expect(winners).toHaveLength(1);
  });

  it("is not callable by a client role", async () => {
    const { error } = await owner.db.rpc("claim_due_browser_tasks", { p_limit: 1 });
    expect(error).not.toBeNull();
  });
});
