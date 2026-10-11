import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
 * A conversation's browser tasks, one after another (0080).
 *
 * What the database promises, because a mock cannot be wrong about it safely:
 *
 *  - `waiting` is a status, and a row in flight still names its run.
 *  - The claim hands out only the HEAD of a browser's line, only while nothing
 *    of that browser is in flight, and never twice at once — two ticks that
 *    both started one task would be two runs and two charges.
 *  - Each hold the line respects: the person's hands on the browser, a sign-in
 *    the panel is asking for, a browser still being opened, a start already
 *    leased, and a person no longer in the workspace.
 *  - It is the service role's alone.
 */

let owner: TestUser;
let outsider: TestUser;
let seeded: Seeded;
let browserSessionId: string;

const service = () => serviceClient();

beforeAll(async () => {
  owner = await createTestUser("queue-owner");
  outsider = await createTestUser("queue-outsider");
  seeded = await seedWorkspace(owner, "shared");

  const { data, error } = await service()
    .from("browser_sessions")
    .insert({
      workspace_id: owner.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      chat_session_id: seeded.sessionId,
      provider_session_id: "bu-agent-session-queue",
    })
    .select("id")
    .single();
  if (error) throw new Error(`seeding the browser session failed: ${error.message}`);
  browserSessionId = data.id as string;
});

afterAll(async () => {
  await destroyTestUsers([owner, outsider]);
  await closeSql();
});

/** A task in this browser, created `ago` seconds in the past. */
async function task(
  status: string,
  ago: number,
  over: Record<string, unknown> = {},
): Promise<string> {
  const run = status === "waiting" ? null : `bu-run-${Math.random().toString(36).slice(2)}`;
  const { data, error } = await service()
    .from("browser_tasks")
    .insert({
      workspace_id: owner.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      session_id: seeded.sessionId,
      provider_task_id: run,
      provider_run_id: run,
      api_version: "v4",
      browser_session_id: browserSessionId,
      task: `a task created ${ago}s ago`,
      status,
      created_at: new Date(Date.now() - ago * 1000).toISOString(),
      ...over,
    })
    .select("id")
    .single();
  if (error) throw new Error(`seeding a task failed: ${error.message}`);
  return data.id as string;
}

async function claimed(limit = 5, browser: string | null = browserSessionId): Promise<string[]> {
  const { data, error } = await service().rpc("claim_next_browser_tasks", {
    p_browser_session_id: browser,
    p_limit: limit,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as { id: string }[]).map((r) => r.id);
}

beforeEach(async () => {
  await sql()`delete from public.browser_tasks where browser_session_id = ${browserSessionId}`;
  await sql()`
    update public.browser_sessions
    set live_state = 'none', provider_session_id = 'bu-agent-session-queue'
    where id = ${browserSessionId}
  `;
});

describe("browser_tasks, after 0080", () => {
  it("takes `waiting`, with no run named", async () => {
    const id = await task("waiting", 10);
    const { data } = await owner.db.from("browser_tasks").select("status").eq("id", id).single();
    expect(data?.status).toBe("waiting");
  });

  it("refuses a row in flight that names no run", async () => {
    const id = await task("waiting", 10);
    const { error } = await service()
      .from("browser_tasks")
      .update({ status: "queued" })
      .eq("id", id);
    expect(error?.code).toBe("23514");
  });

  it("keeps the site a waiting task needs from every client role", async () => {
    const id = await task("waiting", 10, { login_host: "linkedin.com" });
    const { error } = await owner.db.from("browser_tasks").select("login_host").eq("id", id);
    expect(error?.code).toBe("42501");
  });

  it("refuses a site that is not a bare host", async () => {
    const { error } = await service().from("browser_tasks").insert({
      workspace_id: owner.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      session_id: seeded.sessionId,
      task: "x",
      status: "waiting",
      login_host: "https://LinkedIn.com/login",
    });
    expect(error?.code).toBe("23514");
  });
});

describe("claim_next_browser_tasks", () => {
  it("hands out the head of the line once nothing runs, and leases it", async () => {
    await task("finished", 300);
    const first = await task("waiting", 60);
    await task("waiting", 30);

    expect(await claimed()).toEqual([first]);
    const [row] = await sql()`select claimed_at from public.browser_tasks where id = ${first}`;
    expect(row.claimed_at).not.toBeNull();
  });

  it("hands out nothing while a task of the browser is in flight", async () => {
    await task("running", 120);
    await task("waiting", 60);
    expect(await claimed()).toEqual([]);
  });

  it("does not hand out the next one while the head is leased", async () => {
    await task("waiting", 60);
    await task("waiting", 30);
    expect(await claimed()).toHaveLength(1);
    expect(await claimed()).toEqual([]);
  });

  it("hands a lapsed lease back out, because that start died or is backing off", async () => {
    const id = await task("waiting", 60, {
      claimed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });
    expect(await claimed()).toEqual([id]);
  });

  it("waits while the person has the browser", async () => {
    await task("waiting", 60);
    await sql()`update public.browser_sessions set live_state = 'human' where id = ${browserSessionId}`;
    expect(await claimed()).toEqual([]);
  });

  it("waits behind a sign-in the panel is asking for, and not past the hold", async () => {
    await task("failed", 120, {
      stop_reason: "login_required",
      finished_at: new Date(Date.now() - 60 * 1000).toISOString(),
    });
    const id = await task("waiting", 60);
    expect(await claimed()).toEqual([]);

    await sql()`
      update public.browser_tasks set finished_at = now() - interval '11 minutes'
      where stop_reason = 'login_required' and browser_session_id = ${browserSessionId}
    `;
    expect(await claimed()).toEqual([id]);
  });

  it("is not held by a sign-in an earlier task met, once a later one ran", async () => {
    await task("failed", 300, {
      stop_reason: "login_required",
      finished_at: new Date().toISOString(),
    });
    await task("finished", 120, { finished_at: new Date().toISOString() });
    const id = await task("waiting", 60);
    expect(await claimed()).toEqual([id]);
  });

  it("waits while the browser is being opened", async () => {
    await task("waiting", 60);
    await sql()`
      update public.browser_sessions set provider_session_id = null, created_at = now()
      where id = ${browserSessionId}
    `;
    expect(await claimed()).toEqual([]);
  });

  it("does not start a task for somebody who has left the workspace", async () => {
    // Somebody who is not a member of the workspace the task is in — the
    // state a person who left is in. (Removing the owner themselves is
    // refused: a workspace keeps its last admin.)
    await task("waiting", 60, { user_id: outsider.id });
    expect(await claimed()).toEqual([]);
  });

  it("answers for every browser when asked for none, still one per line", async () => {
    const head = await task("waiting", 60);
    await task("waiting", 30);
    expect(await claimed(5, null)).toContain(head);
  });

  /** The one that cannot be mocked: two ticks at once start one task, once. */
  it("gives the head to exactly one of two concurrent claims, and the next to neither", async () => {
    await task("waiting", 60);
    await task("waiting", 30);
    const [a, b] = await Promise.all([claimed(), claimed()]);
    expect([...a, ...b]).toHaveLength(1);
  });

  it("is not callable by a client role", async () => {
    const { error } = await owner.db.rpc("claim_next_browser_tasks", {
      p_browser_session_id: browserSessionId,
    });
    expect(error).not.toBeNull();
    const { error: outsiderError } = await outsider.db.rpc("claim_next_browser_tasks", {});
    expect(outsiderError).not.toBeNull();
  });
});
