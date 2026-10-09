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
 * `browser_profiles` and `browser_takeovers` (0077) are the two rows behind a
 * login Covan never saw. Four claims, and every one of them is a claim about
 * Postgres rather than about the code that calls it:
 *
 *  - A jar belongs to a PERSON. There is no workspace column for a colleague
 *    to be a member of, so the read policy is `user_id = auth.uid()` and a
 *    colleague in the same workspace is in exactly the same position as a
 *    stranger. That is narrower than `browser_tasks`, and the test for it has
 *    to prove the narrowness rather than assume it.
 *  - `provider_profile_id` and `provider_session_id` are granted to no client
 *    role. One deployment-wide `BROWSER_USE_API_KEY` makes the first the
 *    whole address of somebody's cookie jar and the second a running browser
 *    with a live view of a sign-in page.
 *  - Neither table has a write surface for a client, and that is asserted at
 *    the GRANT level the way `browser-tasks.test.ts` learned to. A refused
 *    insert proves only that this insert was refused; counting grants,
 *    column grants and policies proves there is no road in to find.
 *  - The sweep's claim is exclusive, and its predicate has two arms. Both
 *    Workers tick against one database, so a double claim would mean two stop
 *    calls for one rented browser -- and `for update skip locked` is not
 *    something a mock can be wrong about safely.
 */

let owner: TestUser;
let colleague: TestUser;
let outsider: TestUser;
let seeded: Seeded;
let taskId: string;
let profileId: string;
let takeoverId: string;

/**
 * The write surface a role actually has on a table, read out of the catalog.
 *
 * Three questions rather than one, because they fail independently: a table
 * privilege, a column privilege (which PostgREST honours and which a
 * table-level revoke does not always remove), and a policy. A policy test
 * alone passes on a table whose grant is missing for some unrelated reason,
 * and would keep passing if somebody later added the grant back.
 */
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
  owner = await createTestUser("takeover-owner");
  colleague = await createTestUser("takeover-colleague");
  outsider = await createTestUser("takeover-outsider");

  const service = serviceClient();
  const { error: memberError } = await service.from("workspace_members").insert({
    workspace_id: owner.workspaceId,
    user_id: colleague.id,
    role: "member",
  });
  if (memberError) throw new Error(`seeding the colleague failed: ${memberError.message}`);

  seeded = await seedWorkspace(owner, "shared");

  const { data: task, error: taskError } = await service
    .from("browser_tasks")
    .insert({
      workspace_id: owner.workspaceId,
      agent_id: seeded.agentId,
      user_id: owner.id,
      session_id: seeded.sessionId,
      provider_task_id: "bu-task-behind-a-login",
      task: "download last month's invoice from the supplier portal",
    })
    .select("id")
    .single();
  if (taskError) throw new Error(`seeding the browser task failed: ${taskError.message}`);
  taskId = task.id as string;

  const { data: profile, error: profileError } = await service
    .from("browser_profiles")
    .insert({
      user_id: owner.id,
      provider_profile_id: "bu-profile-secret",
      cookie_domains: ["https://portal.example.com"],
      proxy_country_code: "de",
    })
    .select("id")
    .single();
  if (profileError) throw new Error(`seeding the profile failed: ${profileError.message}`);
  profileId = profile.id as string;

  const { data: takeover, error: takeoverError } = await service
    .from("browser_takeovers")
    .insert({
      user_id: owner.id,
      workspace_id: owner.workspaceId,
      profile_id: profileId,
      browser_task_id: taskId,
      provider_session_id: "bu-session-secret",
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    })
    .select("id")
    .single();
  if (takeoverError) throw new Error(`seeding the takeover failed: ${takeoverError.message}`);
  takeoverId = takeover.id as string;
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("browser_profiles", () => {
  it("is visible to the person whose logins it holds", async () => {
    const { data, error } = await owner.db
      .from("browser_profiles")
      .select("id, cookie_domains, last_used_at");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.id).toBe(profileId);
    expect(data?.[0]?.cookie_domains).toEqual(["https://portal.example.com"]);
  });

  /**
   * The departure from `browser_tasks`, stated as a test. There is no
   * workspace column here, so sharing a room with somebody grants nothing:
   * a colleague is in the same position as a stranger, which is the whole
   * point of the jar being personal.
   */
  it("is invisible to a colleague in the same workspace", async () => {
    const { data } = await colleague.db.from("browser_profiles").select("id");
    expect(data).toEqual([]);
  });

  it("is invisible to somebody outside the workspace", async () => {
    const { data } = await outsider.db.from("browser_profiles").select("id");
    expect(data).toEqual([]);
  });

  it("does not hand the provider's profile id to any client", async () => {
    const { error } = await owner.db.from("browser_profiles").select("provider_profile_id");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("refuses a wildcard select, so the withheld columns cannot be read sideways", async () => {
    const { error } = await owner.db.from("browser_profiles").select("*");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("gives no client role a write of any kind, by grant and not only by policy", async () => {
    const surface = await writeSurface("browser_profiles");
    expect(surface.table_grants).toBe(0);
    expect(surface.column_grants).toBe(0);
    expect(surface.write_policies).toBe(0);
  });

  /**
   * The index that makes find-or-create survivable. Without it the race the
   * design describes — two devices, or one double-click before the first
   * response lands — calls `POST /api/v2/profiles` twice, and the loser
   * leaves a profile at browser-use that nothing in this database can name
   * and that counts against the account's limit forever. The insert goes
   * first precisely so this index can be the thing that decides.
   */
  it("refuses a second jar for the same person", async () => {
    const { error } = await serviceClient()
      .from("browser_profiles")
      .insert({ user_id: owner.id, provider_profile_id: "bu-second-jar" });
    expect(error?.code).toBe("23505");
  });

  it("cannot be pointed at somebody else's jar from the browser", async () => {
    const { data } = await owner.db
      .from("browser_profiles")
      .update({ provider_profile_id: "somebody-elses-jar" })
      .eq("id", profileId)
      .select("id");
    expect(data ?? []).toEqual([]);
    const [row] = (await sql()`
      select provider_profile_id from public.browser_profiles where id = ${profileId}
    `) as unknown as { provider_profile_id: string }[];
    expect(row.provider_profile_id).toBe("bu-profile-secret");
  });
});

describe("browser_takeovers", () => {
  it("is visible to the person driving the browser", async () => {
    const { data, error } = await owner.db
      .from("browser_takeovers")
      .select("id, status, browser_task_id, expires_at");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]?.status).toBe("open");
    expect(data?.[0]?.browser_task_id).toBe(taskId);
  });

  it("is invisible to a colleague in the same workspace", async () => {
    const { data } = await colleague.db.from("browser_takeovers").select("id");
    expect(data).toEqual([]);
  });

  it("is invisible to somebody outside the workspace", async () => {
    const { data } = await outsider.db.from("browser_takeovers").select("id");
    expect(data).toEqual([]);
  });

  it("does not hand the provider's session id to any client", async () => {
    const { error } = await owner.db.from("browser_takeovers").select("provider_session_id");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("refuses a wildcard select, so the withheld columns cannot be read sideways", async () => {
    const { error } = await owner.db.from("browser_takeovers").select("*");
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });

  it("gives no client role a write of any kind, by grant and not only by policy", async () => {
    const surface = await writeSurface("browser_takeovers");
    expect(surface.table_grants).toBe(0);
    expect(surface.column_grants).toBe(0);
    expect(surface.write_policies).toBe(0);
  });

  it("cannot be closed from the browser, which would skip the stop at the provider", async () => {
    const { data } = await owner.db
      .from("browser_takeovers")
      .update({ status: "closed" })
      .eq("id", takeoverId)
      .select("id");
    expect(data ?? []).toEqual([]);
    const [row] = (await sql()`
      select status from public.browser_takeovers where id = ${takeoverId}
    `) as unknown as { status: string }[];
    expect(row.status).toBe("open");
  });

  /**
   * The one nonsensical row the database can recognise without calling
   * `now()`. Deliberately weak: that `expires_at` falls inside the provider's
   * own fifteen-minute window is `openTakeover`'s invariant, not this
   * constraint's — see the note beside it in 0077.
   *
   * Asserted on the outsider, who holds no open takeover, so the refusal that
   * comes back is this check and not the one-open unique index.
   */
  it("refuses a window that closes before it opens", async () => {
    const service = serviceClient();
    const { data: profile, error: profileError } = await service
      .from("browser_profiles")
      .insert({ user_id: outsider.id, provider_profile_id: "bu-outsider-jar" })
      .select("id")
      .single();
    expect(profileError).toBeNull();

    const { error } = await service.from("browser_takeovers").insert({
      user_id: outsider.id,
      workspace_id: outsider.workspaceId,
      profile_id: profile?.id as string,
      provider_session_id: "bu-session-backwards",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(error?.code).toBe("23514");

    await service
      .from("browser_profiles")
      .delete()
      .eq("id", profile?.id as string);
  });

  it("refuses a status nothing in the code writes", async () => {
    const { error } = await serviceClient()
      .from("browser_takeovers")
      .update({ status: "abandoned" })
      .eq("id", takeoverId);
    expect(error?.code).toBe("23514");
  });
});

describe("claim_due_browser_takeovers", () => {
  /**
   * Put the row in one of the four states the predicate distinguishes.
   *
   * `created_at` moves with `expires_at`, keeping the pair ten minutes apart
   * — which is both what the route actually writes and what
   * `browser_takeovers_window_forward` requires. A fixture that moved only
   * `expires_at` would be writing a row that closed before it opened, and the
   * constraint would refuse the update; that it does is asserted above.
   */
  async function setState(state: {
    status: string;
    expiresIn: string;
    closedAt?: string | null;
    providerStoppedAt?: string | null;
  }) {
    await sql()`
      update public.browser_takeovers
      set status = ${state.status},
          created_at = now() + ${state.expiresIn}::interval - interval '10 minutes',
          expires_at = now() + ${state.expiresIn}::interval,
          closed_at = ${state.closedAt ?? null},
          provider_stopped_at = ${state.providerStoppedAt ?? null},
          claimed_at = null
      where id = ${takeoverId}
    `;
  }

  async function claimedIds(limit = 50): Promise<string[]> {
    const { data, error } = await serviceClient().rpc("claim_due_browser_takeovers", {
      p_limit: limit,
    });
    if (error) throw new Error(error.message);
    return ((data ?? []) as { id: string }[]).map((r) => r.id);
  }

  /** The abandoned tab: nobody pressed done, so the sweep is what saves the jar. */
  it("takes an open takeover whose window has run out", async () => {
    await setState({ status: "open", expiresIn: "-1 minute" });
    expect(await claimedIds()).toContain(takeoverId);
  });

  it("leaves an open takeover that is still inside its window", async () => {
    await setState({ status: "open", expiresIn: "9 minutes" });
    expect(await claimedIds()).not.toContain(takeoverId);
  });

  /**
   * The second arm of the predicate, and the one the task sweep has no
   * equivalent of: the route marked the row closed, the provider refused the
   * stop, and the browser is still running and still billing.
   */
  it("takes a closed takeover the provider never confirmed stopping", async () => {
    await setState({
      status: "closed",
      expiresIn: "-1 minute",
      closedAt: new Date().toISOString(),
    });
    expect(await claimedIds()).toContain(takeoverId);
  });

  it("leaves a closed takeover the provider did stop", async () => {
    const now = new Date().toISOString();
    await setState({
      status: "closed",
      expiresIn: "-1 minute",
      closedAt: now,
      providerStoppedAt: now,
    });
    expect(await claimedIds()).not.toContain(takeoverId);
  });

  it("does not hand out the same takeover twice", async () => {
    await setState({ status: "open", expiresIn: "-1 minute" });
    expect(await claimedIds()).toContain(takeoverId);
    expect(await claimedIds()).not.toContain(takeoverId);
  });

  it("hands a stale claim back out, because that worker died mid-stop", async () => {
    await setState({ status: "open", expiresIn: "-1 minute" });
    await sql()`
      update public.browser_takeovers
      set claimed_at = now() - interval '30 minutes'
      where id = ${takeoverId}
    `;
    expect(await claimedIds()).toContain(takeoverId);
  });

  /**
   * The one that cannot be mocked. Two concurrent ticks against the real
   * database, and exactly one of them may see the row -- otherwise one rented
   * browser gets stopped twice and delivered twice.
   */
  it("gives one takeover to exactly one of two concurrent ticks", async () => {
    await setState({ status: "open", expiresIn: "-1 minute" });
    const [first, second] = await Promise.all([claimedIds(), claimedIds()]);
    const winners = [first, second].filter((ids) => ids.includes(takeoverId));
    expect(winners).toHaveLength(1);
  });

  /**
   * `42501` specifically, and the specificity is the test: a bare "something
   * went wrong" would pass on a misspelled function name, which is the one
   * way this assertion could be green while the grant was wide open.
   *
   * Worth knowing that it IS 42501 — PostgREST passes Postgres's privilege
   * error through rather than hiding an unexecutable function behind a 404,
   * so a refusal here is distinguishable from a function that does not
   * exist. Which means this test cannot be fooled by a rename either.
   */
  it("is not callable by a client role", async () => {
    const { error } = await owner.db.rpc("claim_due_browser_takeovers", { p_limit: 1 });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");
  });
});

/**
 * The partial unique index is the whole of the abuse story: without it one
 * account opens rented browsers until the account-wide concurrency pool is
 * empty and every other tenant's task 429s.
 */
describe("browser_takeovers_one_open_idx", () => {
  async function openRow(user: TestUser, profile: string) {
    return await serviceClient()
      .from("browser_takeovers")
      .insert({
        user_id: user.id,
        workspace_id: owner.workspaceId,
        profile_id: profile,
        provider_session_id: `bu-session-${crypto.randomUUID()}`,
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      })
      .select("id")
      .single();
  }

  it("refuses a second open takeover for the same person", async () => {
    await sql()`
      update public.browser_takeovers
      set status = 'open', closed_at = null, provider_stopped_at = null
      where id = ${takeoverId}
    `;
    const { error } = await openRow(owner, profileId);
    expect(error?.code).toBe("23505");
  });

  it("permits an open takeover for a different person", async () => {
    const service = serviceClient();
    const { data: profile, error: profileError } = await service
      .from("browser_profiles")
      .insert({ user_id: colleague.id, provider_profile_id: "bu-colleague-jar" })
      .select("id")
      .single();
    expect(profileError).toBeNull();

    const { data, error } = await openRow(colleague, profile?.id as string);
    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();

    await service
      .from("browser_takeovers")
      .delete()
      .eq("id", data?.id as string);
  });
});

/**
 * 0077's one change to an existing table's client-visible surface. It is a
 * column-level grant on a table whose other columns are deliberately
 * withheld, which is the shape that goes wrong quietly: a future edit
 * reaching for `grant select on public.browser_tasks to authenticated`
 * would make this half pass and the other half fail.
 */
describe("browser_tasks.retry_of", () => {
  it("is readable by the person whose task it is", async () => {
    const { data, error } = await owner.db.from("browser_tasks").select("id, retry_of");
    expect(error).toBeNull();
    expect(data?.some((r) => r.id === taskId)).toBe(true);
    expect(data?.find((r) => r.id === taskId)?.retry_of).toBeNull();
  });

  it("points at the attempt it replaces, and the client can read which", async () => {
    const service = serviceClient();
    const { data: retry, error: retryError } = await service
      .from("browser_tasks")
      .insert({
        workspace_id: owner.workspaceId,
        agent_id: seeded.agentId,
        user_id: owner.id,
        session_id: seeded.sessionId,
        provider_task_id: "bu-task-after-the-login",
        task: "download last month's invoice from the supplier portal",
        retry_of: taskId,
      })
      .select("id")
      .single();
    expect(retryError).toBeNull();

    const { data, error } = await owner.db
      .from("browser_tasks")
      .select("id, retry_of")
      .eq("id", retry?.id as string)
      .single();
    expect(error).toBeNull();
    expect(data?.retry_of).toBe(taskId);

    await service
      .from("browser_tasks")
      .delete()
      .eq("id", retry?.id as string);
  });

  /**
   * The other half, and the half that would catch a table-level grant: 0073's
   * withheld columns are still withheld. Granting one column must not have
   * opened the row.
   */
  it("did not open the columns 0073 withholds", async () => {
    for (const column of ["provider_task_id", "next_poll_at", "claimed_at"]) {
      const { error } = await owner.db.from("browser_tasks").select(column);
      expect(error?.code, `${column} should still be withheld`).toBe("42501");
    }
  });
});

/**
 * `on delete set null`, which is the choice the header argues hardest for and
 * which nothing else here holds. Its inverse — cascade — deletes the takeover
 * row while the rented browser carries on at the provider: orphaned, never
 * swept, never stopped, the profile never saved, and a slot held in the
 * account-wide concurrency pool until the provider's own timeout. Last in the
 * file because it destroys the fixture.
 */
describe("browser_takeovers.browser_task_id on delete set null", () => {
  it("survives the deletion of the task it was recovering", async () => {
    const service = serviceClient();
    const { error: deleteError } = await service.from("browser_tasks").delete().eq("id", taskId);
    expect(deleteError).toBeNull();

    const [row] = (await sql()`
      select browser_task_id, provider_session_id
      from public.browser_takeovers where id = ${takeoverId}
    `) as unknown as { browser_task_id: string | null; provider_session_id: string }[];
    expect(row).toBeTruthy();
    expect(row.browser_task_id).toBeNull();
    // Still nameable at the provider, which is the whole point of keeping it.
    expect(row.provider_session_id).toBe("bu-session-secret");
  });
});
