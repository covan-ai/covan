/**
 * A request made with an API key reaches the key's own workspace and no other
 * (0087).
 *
 * The API mints a short-lived token for every key request, and that token
 * carries the key's workspace as `covan_ws`. A browser session's token never
 * does. These tests stand in for that minted token the way PostgREST would
 * apply it — the claims set on the transaction, the role switched to
 * `authenticated` — because this suite holds no JWT secret to sign one with.
 * That the API puts the claim in the token is `worker/src/lib/api-keys.test.ts`.
 *
 * The person here is an admin of two workspaces, and owns rows in both. The
 * failure being guarded is a key made for one of them reading or changing the
 * other: before 0087 it could, because the owner IS a member over there, and
 * some policies ("your own rows") never asked about a workspace at all.
 */

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

let owner: TestUser;
let colleague: TestUser;
let home: Seeded;
let elsewhere: Seeded;
/** Rows the owner holds in the colleague's workspace, through "own row" policies. */
let elsewhereChannelId: string;
let elsewhereRoutineId: string;

const ROLLBACK = Symbol("rollback");

/**
 * Runs `fn` as the owner, the way PostgREST runs a request: claims on the
 * transaction, role `authenticated`. `workspace` is the key's `covan_ws`;
 * null is a browser session. Always rolled back.
 */
async function asOwner<T>(
  workspace: string | null,
  fn: (tx: ReturnType<typeof sql>) => Promise<T>,
): Promise<T> {
  const claims: Record<string, string> = { sub: owner.id, role: "authenticated" };
  if (workspace) claims.covan_ws = workspace;
  let result: T | undefined;
  try {
    await sql().begin(async (tx) => {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
      await tx`set local role authenticated`;
      result = await fn(tx as never);
      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }
  return result as T;
}

async function count(tx: ReturnType<typeof sql>, table: string, column: string, id: string) {
  const [row] = await tx.unsafe(
    `select count(*)::int as n from public.${table} where ${column} = $1`,
    [id],
  );
  return row.n as number;
}

beforeAll(async () => {
  owner = await createTestUser("key-scope-owner");
  colleague = await createTestUser("key-scope-colleague");
  home = await seedWorkspace(owner, "shared");
  elsewhere = await seedWorkspace(colleague, "shared");

  const service = serviceClient();
  const { error: joinError } = await service
    .from("workspace_members")
    .insert({ workspace_id: colleague.workspaceId, user_id: owner.id, role: "admin" });
  if (joinError) throw new Error(`could not add the owner: ${joinError.message}`);

  const { data: channel, error: channelError } = await service
    .from("delivery_channels")
    .insert({
      workspace_id: colleague.workspaceId,
      user_id: owner.id,
      kind: "email",
      label: "o••••r@covan.test",
      secret_ciphertext: "not-a-real-ciphertext",
    })
    .select("id")
    .single();
  if (channelError) throw new Error(`could not seed a channel: ${channelError.message}`);
  elsewhereChannelId = channel.id;

  const { data: routine, error: routineError } = await service
    .from("routines")
    .insert({
      workspace_id: colleague.workspaceId,
      agent_id: elsewhere.agentId,
      user_id: owner.id,
      name: "Owner's routine over there",
      visibility: "private",
      source_kind: "web",
      source_config: { url: "https://example.com/feed" },
      instruction: "summarise",
      delivery_channel_id: elsewhereChannelId,
      schedule_cron: "0 9 * * *",
    })
    .select("id")
    .single();
  if (routineError) throw new Error(`could not seed a routine: ${routineError.message}`);
  elsewhereRoutineId = routine.id;
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

/** What the owner can see of the other workspace, as a key or as a session. */
async function visibleElsewhere(workspace: string | null) {
  return asOwner(workspace, async (tx) => ({
    workspace: await count(tx, "workspaces", "id", colleague.workspaceId),
    members: await count(tx, "workspace_members", "workspace_id", colleague.workspaceId),
    agent: await count(tx, "agents", "id", elsewhere.agentId),
    bundle: await count(tx, "knowledge_bundles", "id", elsewhere.bundleId),
    document: await count(tx, "documents", "id", elsewhere.documentId),
    session: await count(tx, "chat_sessions", "id", elsewhere.sessionId),
    message: await count(tx, "messages", "id", elsewhere.messageId),
    // The two that "your own rows" policies used to hand over regardless.
    ownChannel: await count(tx, "delivery_channels", "id", elsewhereChannelId),
    ownRoutine: await count(tx, "routines", "id", elsewhereRoutineId),
    colleagueProfile: await count(tx, "profiles", "id", colleague.id),
  }));
}

describe("a key made in one workspace", () => {
  it("sees nothing of another workspace its owner belongs to", async () => {
    expect(await visibleElsewhere(owner.workspaceId)).toEqual({
      workspace: 0,
      members: 0,
      agent: 0,
      bundle: 0,
      document: 0,
      session: 0,
      message: 0,
      ownChannel: 0,
      ownRoutine: 0,
      colleagueProfile: 0,
    });
  });

  it("still sees its own workspace", async () => {
    const seen = await asOwner(owner.workspaceId, async (tx) => ({
      agent: await count(tx, "agents", "id", home.agentId),
      document: await count(tx, "documents", "id", home.documentId),
      message: await count(tx, "messages", "id", home.messageId),
      routine: await count(tx, "routines", "id", home.routineId),
      channel: await count(tx, "delivery_channels", "id", home.channelId),
    }));
    expect(seen).toEqual({ agent: 1, document: 1, message: 1, routine: 1, channel: 1 });
  });

  it("is told it is not a member over there, by every helper a policy asks", async () => {
    const answers = await asOwner(owner.workspaceId, async (tx) => {
      const [row] = await tx`
        select public.is_workspace_member(${colleague.workspaceId}::uuid) as member,
               public.can_write_in_workspace(${colleague.workspaceId}::uuid) as writer,
               public.is_workspace_admin(${colleague.workspaceId}::uuid) as admin,
               public.shares_workspace(${colleague.id}::uuid) as shares`;
      return row;
    });
    expect(answers).toEqual({ member: false, writer: false, admin: false, shares: false });
  });

  it("cannot write there, including to rows that are its owner's own", async () => {
    const outcome = await asOwner(owner.workspaceId, async (tx) => {
      const deletedChannel = await tx`
        delete from public.delivery_channels where id = ${elsewhereChannelId} returning id`;
      const pausedRoutine = await tx`
        update public.routines set status = 'paused' where id = ${elsewhereRoutineId} returning id`;
      let inserted = "no error";
      try {
        await tx`savepoint s`;
        await tx`insert into public.agents (workspace_id, name, created_by)
                 values (${colleague.workspaceId}, 'planted', ${owner.id})`;
      } catch (e) {
        inserted = (e as { code?: string }).code ?? "error";
        await tx`rollback to savepoint s`;
      }
      return {
        deletedChannel: deletedChannel.length,
        pausedRoutine: pausedRoutine.length,
        inserted,
      };
    });
    expect(outcome).toEqual({ deletedChannel: 0, pausedRoutine: 0, inserted: "42501" });
  });
});

describe("a browser session", () => {
  it("is not affected: the owner still sees both workspaces", async () => {
    // With no claim, every policy answers exactly as it did before 0087.
    expect(await visibleElsewhere(null)).toEqual({
      workspace: 1,
      members: 2,
      agent: 1,
      bundle: 1,
      document: 1,
      session: 1,
      message: 1,
      ownChannel: 1,
      ownRoutine: 1,
      colleagueProfile: 1,
    });
  });
});

describe("the schema", () => {
  /**
   * Tables with no workspace of their own. Each belongs to a person, or to
   * nobody, and is the same answer in every workspace.
   */
  const PERSONAL = new Map([
    ["browser_profiles", "a person's own signed-in browser, across workspaces"],
    ["notification_preferences", "a person's own settings"],
    ["profiles", "a person; co-member visibility goes through shares_workspace, which is scoped"],
    ["slack_identities", "a Slack user linked to a person"],
    ["user_onboarding", "a person's own progress"],
    ["onboarding_events", "a person's own first run, step by step (0119)"],
    ["user_usage", "a person's own counters"],
    ["signup_grants", "hosted builds: keyed by person and outliving the workspace it names"],
    ["routine_deliveries", "no policies at all: the service role is the only reader"],
    ["passage_vector_changes", "no policies at all: the passage index's queue, service role only"],
    ["credit_holds", "hosted builds: no policies at all, the service role is the only reader"],
    ["signup_grant_addresses", "hosted builds: no policies, and outlives every account"],
    ["onboarding_rewards", "hosted builds: no policies at all, the trigger is the only reader"],
  ]);

  it("holds every workspace table to the key's workspace", async () => {
    // A table in neither list fails here. A new workspace table needs a
    // `<table>_request_workspace` restrictive policy (0087 shows the shape);
    // a new personal one needs a line above saying why it is not one.
    const rows = (await sql()`
      select c.relname as table,
             exists (select 1 from pg_policy p
                      where p.polrelid = c.oid and not p.polpermissive
                        and pg_get_expr(p.polqual, p.polrelid) like '%request_workspace()%') as scoped
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
       order by 1`) as Array<{ table: string; scoped: boolean }>;

    const unscoped = rows.filter((r) => !r.scoped && !PERSONAL.has(r.table)).map((r) => r.table);
    // Only tables that exist: two of the lines above are hosted-only tables, and
    // a database without them is not a stale list.
    const stale = rows.filter((r) => r.scoped && PERSONAL.has(r.table)).map((r) => r.table);

    expect(unscoped, "workspace tables a key could read across workspaces").toEqual([]);
    expect(stale, "scoped after all; drop them from PERSONAL").toEqual([]);
  });
});
