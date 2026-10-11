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
 * `browser_sessions` (0078) is one conversation at browser-use per chat
 * session and person -- the browser that sits beside the conversation and
 * keeps its tabs between `browse` calls. Four claims, each about Postgres
 * rather than the code that calls it:
 *
 *  - The row is the OWNER's, not the room's, for `browser_tasks`'s reason: it
 *    is a browser one person's allowance is driving. A colleague in the same
 *    shared conversation sees the answers as ordinary messages and sees
 *    nothing of the browser.
 *  - `provider_session_id`, `provider_browser_id` and `events_cursor` are
 *    granted to no client role. One deployment-wide `BROWSER_USE_API_KEY`
 *    makes the first two the whole address of a running browser somebody is
 *    paying for.
 *  - No client role has a write surface, counted at the GRANT level the way
 *    `browser-tasks.test.ts` learned to: `live_state` decides whether the
 *    panel hands somebody the controls, and a client that could write it
 *    could put itself in `human` without the run ever being stopped.
 *  - `unique (chat_session_id, user_id)` is what lets the first `browse` in a
 *    conversation insert FIRST and call the provider only if it won, and the
 *    sweep's claim is exclusive -- `for update skip locked` is not something a
 *    mock can be wrong about safely.
 */

let owner: TestUser;
let colleague: TestUser;
let outsider: TestUser;
let seeded: Seeded;
let browserSessionId: string;
let taskId: string;

/** Same three questions as `browser-profiles.test.ts`, for the same reason. */
async function writeSurface(table: string) {
  const [row] = (await sql()`
    select
      (select count(*) from information_schema.table_privileges
        where table_schema = 'public' and table_name = ${table}
          and grantee in ('anon', 'authenticated')
          and privilege_type in ('INSERT', 'UPDATE', 'DELETE'))::int as table_grants,
      (select count(*) from information_schema.column_privileges
        where table_schema = 'public' and table_name = ${table}
          and grantee in ('anon', 'authenticated')
          and privilege_type in ('INSERT', 'UPDATE', 'DELETE'))::int as column_grants,
      (select count(*) from pg_policies
        where schemaname = 'public' and tablename = ${table}
          and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL'))::int as write_policies
  `) as unknown as { table_grants: number; column_grants: number; write_policies: number }[];
  return row;
}

beforeAll(async () => {
  owner = await createTestUser("session-owner");
  colleague = await createTestUser("session-colleague");
  outsider = await createTestUser("session-outsider");

  const service = serviceClient();
  const { error: memberError } = await service.from("workspace_members").insert({
    workspace_id: owner.workspaceId,
    user_id: colleague.id,
    role: "member",
  });
  if (memberError) throw new Error(`seeding the colleague failed: ${memberError.message}`);

  seeded = await seedWorkspace(owner, "shared");

  const { data: session, error: sessionError } = await service
    .from("browser_sessions")
    .insert({
      workspace_id: owner.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      chat_session_id: seeded.sessionId,
      provider_session_id: "bu-agent-session-secret",
      provider_browser_id: "bu-browser-secret",
    })
    .select("id")
    .single();
  if (sessionError) throw new Error(`seeding the browser session failed: ${sessionError.message}`);
  browserSessionId = session.id as string;

  const { data: task, error: taskError } = await service
    .from("browser_tasks")
    .insert({
      workspace_id: owner.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      session_id: seeded.sessionId,
      provider_task_id: "bu-run-secret",
      provider_run_id: "bu-run-secret",
      api_version: "v4",
      browser_session_id: browserSessionId,
      task: "compare the three plans on example.com",
    })
    .select("id")
    .single();
  if (taskError) throw new Error(`seeding the browser task failed: ${taskError.message}`);
  taskId = task.id as string;
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("browser_sessions", () => {
  it("is visible to the person whose browser it is", async () => {
    const { data, error } = await owner.db
      .from("browser_sessions")
      .select(
        "id, user_id, workspace_id, agent_id, chat_session_id, live_state, human_since, last_run_at, created_at",
      );
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.id).toBe(browserSessionId);
    expect(data?.[0]?.chat_session_id).toBe(seeded.sessionId);
    expect(data?.[0]?.live_state).toBe("none");
    expect(data?.[0]?.human_since).toBeNull();
  });

  /**
   * The narrowness, stated as a test. The conversation is shared and the
   * colleague is a member of the workspace, so they can read every message
   * in it -- and still nothing of the browser driving it.
   */
  it("is invisible to a colleague in the same shared conversation", async () => {
    const { data: conversation } = await colleague.db
      .from("chat_sessions")
      .select("id")
      .eq("id", seeded.sessionId);
    expect(conversation).toHaveLength(1);

    const { data } = await colleague.db.from("browser_sessions").select("id");
    expect(data).toEqual([]);
  });

  it("is invisible to somebody outside the workspace", async () => {
    const { data } = await outsider.db.from("browser_sessions").select("id");
    expect(data).toEqual([]);
  });

  it("does not hand the provider's session id to any client", async () => {
    const { error } = await owner.db.from("browser_sessions").select("provider_session_id");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("withholds the rest of the provider bookkeeping too", async () => {
    // `human_started_at` (ruling R21) is the sweep's four-hour clock; the panel
    // draws from `human_since` and needs nothing more.
    for (const column of [
      "provider_browser_id",
      "events_cursor",
      "claimed_at",
      "human_started_at",
    ]) {
      const { error } = await owner.db.from("browser_sessions").select(column);
      expect(error?.code, `${column} should be withheld`).toBe("42501");
    }
  });

  it("refuses a wildcard select, so the withheld columns cannot be read sideways", async () => {
    const { error } = await owner.db.from("browser_sessions").select("*");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("gives no client role a write of any kind, by grant and not only by policy", async () => {
    const surface = await writeSurface("browser_sessions");
    expect(surface.table_grants).toBe(0);
    expect(surface.column_grants).toBe(0);
    expect(surface.write_policies).toBe(0);
  });

  /**
   * `human` is the state in which the panel hands over the controls. Only the
   * take-over route may write it, and only after the provider has reported
   * the run stopped.
   */
  it("cannot be put in the person's hands from the browser", async () => {
    const { data } = await owner.db
      .from("browser_sessions")
      .update({ live_state: "human" })
      .eq("id", browserSessionId)
      .select("id");
    expect(data ?? []).toEqual([]);
    const [row] = (await sql()`
      select live_state from public.browser_sessions where id = ${browserSessionId}
    `) as unknown as { live_state: string }[];
    expect(row.live_state).toBe("none");
  });

  it("refuses a live state nothing in the code writes", async () => {
    const { error } = await serviceClient()
      .from("browser_sessions")
      .update({ live_state: "cancelling" })
      .eq("id", browserSessionId);
    expect(error?.code).toBe("23514");
  });

  /**
   * The index that makes insert-first possible. The first `browse` in a
   * conversation races itself -- two tabs, or a retry before the first
   * response lands -- and without this both would open a conversation at
   * browser-use, one of which nothing here could ever name.
   */
  it("refuses a second browser for the same conversation and person", async () => {
    const { error } = await serviceClient().from("browser_sessions").insert({
      workspace_id: owner.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      chat_session_id: seeded.sessionId,
    });
    expect(error?.code).toBe("23505");
  });

  /**
   * The same guarantee in the form the writer uses it:
   * `on conflict (chat_session_id, user_id) do nothing ... returning`. That
   * clause needs a unique index on exactly those columns to name, or Postgres
   * refuses the statement outright (42P10); an empty `returning` is the loser
   * learning it lost.
   */
  it("lets the loser of the race find out by an empty returning", async () => {
    const { data, error } = await serviceClient()
      .from("browser_sessions")
      .upsert(
        {
          workspace_id: owner.workspaceId,
          agent_id: seeded.agentId,
          user_id: owner.id,
          chat_session_id: seeded.sessionId,
        },
        { onConflict: "chat_session_id,user_id", ignoreDuplicates: true },
      )
      .select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("permits a browser for a different person in the same conversation", async () => {
    const service = serviceClient();
    const { data, error } = await service
      .from("browser_sessions")
      .insert({
        workspace_id: owner.workspaceId,
        agent_id: seeded.agentId,
        user_id: colleague.id,
        chat_session_id: seeded.sessionId,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    await service
      .from("browser_sessions")
      .delete()
      .eq("id", data?.id as string);
  });
});

/**
 * 0078's change to an existing table's client-visible surface. Column grants
 * on a table whose other columns are withheld is the shape that goes wrong
 * quietly, so both halves are pinned.
 */
describe("browser_tasks, after 0078", () => {
  it("lets the owner read which browser, which API, why it stopped and where it wanted a sign-in", async () => {
    const { data, error } = await owner.db
      .from("browser_tasks")
      .select("id, browser_session_id, api_version, stop_reason, signin_host")
      .eq("id", taskId)
      .single();
    expect(error).toBeNull();
    expect(data?.browser_session_id).toBe(browserSessionId);
    expect(data?.api_version).toBe("v4");
    expect(data?.stop_reason).toBeNull();
    expect(data?.signin_host).toBeNull();
  });

  /**
   * The panel's "linkedin.com needs you to sign in" reads this column, and
   * the worker stores only a bare host in it. The check is the backstop for a
   * writer that forgets: a URL, a port, credentials or whitespace in a column
   * a screen renders is refused at the database, not trusted from the model.
   */
  it("keeps signin_host a bare lowercase host, refusing anything else", async () => {
    const service = serviceClient();
    const good = await service
      .from("browser_tasks")
      .update({ signin_host: "linkedin.com" })
      .eq("id", taskId);
    expect(good.error).toBeNull();

    for (const bad of [
      "https://x.com",
      "x.com:443",
      "me@x.com",
      "x.com/login",
      "x .com",
      "X.com",
    ]) {
      const { error } = await service
        .from("browser_tasks")
        .update({ signin_host: bad })
        .eq("id", taskId);
      expect(error?.code, `${bad} should be refused`).toBe("23514");
    }

    const { data } = await service
      .from("browser_tasks")
      .select("signin_host")
      .eq("id", taskId)
      .single();
    expect(data?.signin_host).toBe("linkedin.com");

    await service.from("browser_tasks").update({ signin_host: null }).eq("id", taskId);
  });

  it("does not hand the provider's run id to any client", async () => {
    const { error } = await owner.db.from("browser_tasks").select("provider_run_id");
    expect(error?.code).toBe("42501");
  });

  it("did not open the columns 0073 withholds", async () => {
    for (const column of ["provider_task_id", "next_poll_at", "claimed_at"]) {
      const { error } = await owner.db.from("browser_tasks").select(column);
      expect(error?.code, `${column} should still be withheld`).toBe("42501");
    }
  });

  /** Rows written before 0078 are v2 rows being drained, and say so. */
  it("defaults a task to the v2 API and refuses one that is neither", async () => {
    const service = serviceClient();
    const { data, error } = await service
      .from("browser_tasks")
      .insert({
        workspace_id: owner.workspaceId,
        agent_id: seeded.agentId,
        user_id: owner.id,
        session_id: seeded.sessionId,
        provider_task_id: "bu-v2-task",
        task: "a task from before the browser moved",
      })
      .select("id, api_version")
      .single();
    expect(error).toBeNull();
    expect(data?.api_version).toBe("v2");

    const { error: badError } = await service
      .from("browser_tasks")
      .update({ api_version: "v3" })
      .eq("id", data?.id as string);
    expect(badError?.code).toBe("23514");

    await service
      .from("browser_tasks")
      .delete()
      .eq("id", data?.id as string);
  });
});

describe("claim_due_browser_sessions", () => {
  /** `humanFor` is how long ago `human_since` says the hand-over happened. */
  async function setState(liveState: string, humanFor: string) {
    await sql()`
      update public.browser_sessions
      set live_state = ${liveState},
          human_since = now() - ${humanFor}::interval,
          claimed_at = null
      where id = ${browserSessionId}
    `;
  }

  async function claimedIds(limit = 50): Promise<string[]> {
    const { data, error } = await serviceClient().rpc("claim_due_browser_sessions", {
      p_limit: limit,
    });
    if (error) throw new Error(error.message);
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  }

  /** The tab closed mid-takeover: nobody handed back, so the sweep does. */
  it("takes a browser that has been in a person's hands for ten minutes", async () => {
    await setState("human", "11 minutes");
    expect(await claimedIds()).toContain(browserSessionId);
  });

  it("leaves a browser somebody took over a moment ago", async () => {
    await setState("human", "5 minutes");
    expect(await claimedIds()).not.toContain(browserSessionId);
  });

  it("leaves a browser the agent is driving, however long ago it was handed over", async () => {
    await setState("agent", "1 hour");
    expect(await claimedIds()).not.toContain(browserSessionId);
  });

  it("does not hand out the same browser twice", async () => {
    await setState("human", "11 minutes");
    expect(await claimedIds()).toContain(browserSessionId);
    expect(await claimedIds()).not.toContain(browserSessionId);
  });

  it("hands a stale claim back out, because that worker died mid-stop", async () => {
    await setState("human", "11 minutes");
    await sql()`
      update public.browser_sessions
      set claimed_at = now() - interval '30 minutes'
      where id = ${browserSessionId}
    `;
    expect(await claimedIds()).toContain(browserSessionId);
  });

  /**
   * The one that cannot be mocked. Two concurrent ticks against the real
   * database, and exactly one of them may see the row -- otherwise one
   * browser is stopped twice and its profile refreshed twice.
   */
  it("gives one browser to exactly one of two concurrent ticks", async () => {
    await setState("human", "11 minutes");
    const [first, second] = await Promise.all([claimedIds(), claimedIds()]);
    const winners = [first, second].filter((ids) => ids.includes(browserSessionId));
    expect(winners).toHaveLength(1);
  });

  /**
   * Ruling R20's arm: a browser nobody is using. `lastRunFor` is how long ago
   * the last run started; `browser` is the provider browser the row still
   * names, which the sweep clears once it has seen it stopped.
   */
  async function setIdle(lastRunFor: string | null, browser: string | null = "bu-browser-secret") {
    await sql()`
      update public.browser_sessions
      set live_state = 'none',
          human_since = null,
          claimed_at = null,
          last_run_at = now() - ${lastRunFor}::interval,
          provider_browser_id = ${browser}
      where id = ${browserSessionId}
    `;
  }

  it("takes a browser nobody has used for ten minutes since its last run", async () => {
    await setIdle("11 minutes");
    expect(await claimedIds()).toContain(browserSessionId);
  });

  it("leaves a browser whose last run was a moment ago", async () => {
    await setIdle("5 minutes");
    expect(await claimedIds()).not.toContain(browserSessionId);
  });

  it("leaves a browser the sweep has already stopped, which the row no longer names", async () => {
    await setIdle("1 hour", null);
    expect(await claimedIds()).not.toContain(browserSessionId);
  });

  it("leaves a row that has never run", async () => {
    await setIdle(null);
    expect(await claimedIds()).not.toContain(browserSessionId);
  });

  it("does not hand out the same idle browser twice", async () => {
    await setIdle("11 minutes");
    expect(await claimedIds()).toContain(browserSessionId);
    expect(await claimedIds()).not.toContain(browserSessionId);
  });

  it("gives one idle browser to exactly one of two concurrent ticks", async () => {
    await setIdle("11 minutes");
    const [first, second] = await Promise.all([claimedIds(), claimedIds()]);
    const winners = [first, second].filter((ids) => ids.includes(browserSessionId));
    expect(winners).toHaveLength(1);
  });

  /** 42501 specifically, for the reason `browser-profiles.test.ts` gives. */
  it("is not callable by a client role", async () => {
    const { error } = await owner.db.rpc("claim_due_browser_sessions", { p_limit: 1 });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });
});
