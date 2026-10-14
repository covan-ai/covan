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
 * `browser_credentials` (0079) holds a site login somebody saved, encrypted,
 * for one agent: either for themselves (`scope = 'owner'`) or for everybody
 * who uses that agent (`scope = 'agent'`). Five claims, each about Postgres
 * rather than about the code that will call it:
 *
 *  - The person who saved a login always sees its row. A colleague in the
 *    same workspace sees the agent's shared logins and none of anybody's
 *    own; a stranger sees nothing.
 *  - Seeing a shared login goes through the agent's own read rule, so an
 *    agent in the trash takes its shared logins out of sight with it.
 *  - `username_ciphertext` and `password_ciphertext` are granted to no client
 *    role, and the columns that ARE granted are exactly the list 0079 names --
 *    asserted as a list, because the failure that matters is a grant that
 *    grows by one.
 *  - There is no plaintext username anywhere in the table, so "the label is
 *    visible, the username never" is a statement about the schema, not about
 *    a select list somebody chose well.
 *  - No client role can write the table at all, by grant and not only by
 *    policy. Saving and deleting a login goes through the service role in
 *    `lib/browser/credentials.ts`, after a route has checked the caller.
 */

let owner: TestUser;
let colleague: TestUser;
let outsider: TestUser;
let seeded: Seeded;
let ownerScopedId: string;
let agentScopedId: string;

/** Exactly the columns 0079 grants `authenticated` to read, sorted. */
const GRANTED = [
  "agent_id",
  "created_at",
  "id",
  "label",
  "last_used_at",
  "scope",
  "site_host",
  "user_id",
  "workspace_id",
].sort();

/** Every column the table has. The two ciphertexts are the only extra ones. */
const ALL_COLUMNS = [...GRANTED, "password_ciphertext", "username_ciphertext"].sort();

/** The write surface `browser-profiles.test.ts` counts, for this table. */
async function writeSurface() {
  const [row] = (await sql()`
    select
      (select count(*) from information_schema.table_privileges
        where table_schema = 'public' and table_name = 'browser_credentials'
          and grantee in ('anon', 'authenticated')
          and privilege_type in ('INSERT', 'UPDATE', 'DELETE'))::int as table_grants,
      (select count(*) from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'browser_credentials'
          and grantee in ('anon', 'authenticated')
          and privilege_type in ('INSERT', 'UPDATE', 'DELETE'))::int as column_grants,
      (select count(*) from pg_policies
        where schemaname = 'public' and tablename = 'browser_credentials'
          and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')
          -- A restrictive policy grants nothing; 0087's narrows every command.
          and permissive = 'PERMISSIVE')::int as write_policies
  `) as unknown as { table_grants: number; column_grants: number; write_policies: number }[];
  return row;
}

/** A row the way the service role writes one; overrides for the refusals. */
function credential(overrides: Record<string, unknown> = {}) {
  return {
    workspace_id: owner.workspaceId,
    agent_id: seeded.agentId,
    user_id: owner.id,
    scope: "owner",
    site_host: "linkedin.com",
    label: "LinkedIn — my own account",
    username_ciphertext: "not-a-real-ciphertext-user",
    password_ciphertext: "not-a-real-ciphertext-pass",
    ...overrides,
  };
}

beforeAll(async () => {
  owner = await createTestUser("credentials-owner");
  colleague = await createTestUser("credentials-colleague");
  outsider = await createTestUser("credentials-outsider");

  const service = serviceClient();
  const { error: memberError } = await service.from("workspace_members").insert({
    workspace_id: owner.workspaceId,
    user_id: colleague.id,
    role: "member",
  });
  if (memberError) throw new Error(`seeding the colleague failed: ${memberError.message}`);

  seeded = await seedWorkspace(owner, "shared");

  const { data: mine, error: mineError } = await service
    .from("browser_credentials")
    .insert(credential())
    .select("id")
    .single();
  if (mineError) throw new Error(`seeding the owner-scoped login failed: ${mineError.message}`);
  ownerScopedId = mine.id as string;

  const { data: shared, error: sharedError } = await service
    .from("browser_credentials")
    .insert(credential({ scope: "agent", label: "LinkedIn — sales account" }))
    .select("id")
    .single();
  if (sharedError) throw new Error(`seeding the agent-scoped login failed: ${sharedError.message}`);
  agentScopedId = shared.id as string;
});

afterAll(async () => {
  await destroyTestUsers();
  await closeSql();
});

describe("browser_credentials: who reads which row", () => {
  it("shows the person who saved them both of their logins", async () => {
    const { data, error } = await owner.db
      .from("browser_credentials")
      .select("id, scope, site_host, label");
    expect(error).toBeNull();
    expect(data?.map((r) => r.id).sort()).toEqual([ownerScopedId, agentScopedId].sort());
  });

  /**
   * The split the `scope` column exists for. The colleague uses the same
   * agent in the same workspace, so the login saved FOR the agent is theirs
   * to know about; the one saved for the owner alone is not.
   */
  it("shows a colleague the agent's shared login and not the owner's own", async () => {
    const { data, error } = await colleague.db.from("browser_credentials").select("id, scope");
    expect(error).toBeNull();
    expect(data).toEqual([{ id: agentScopedId, scope: "agent" }]);
  });

  it("shows somebody outside the workspace nothing", async () => {
    const { data, error } = await outsider.db.from("browser_credentials").select("id");
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  /**
   * The predicate borrowed from `agents_select_workspace_member` (0040): an
   * agent in the trash is an agent nobody may use, so its shared logins go
   * out of sight with it. The owner still sees their own row through the
   * `user_id` branch -- it is their login, and the delete control for it has
   * to be able to find it.
   */
  it("hides an agent's shared login from colleagues while the agent is in the trash", async () => {
    await sql()`update public.agents set deleted_at = now() where id = ${seeded.agentId}`;
    try {
      const { data: colleagueSees } = await colleague.db.from("browser_credentials").select("id");
      expect(colleagueSees).toEqual([]);
      const { data: ownerSees } = await owner.db.from("browser_credentials").select("id");
      expect(ownerSees?.map((r) => r.id).sort()).toEqual([ownerScopedId, agentScopedId].sort());
    } finally {
      await sql()`update public.agents set deleted_at = null where id = ${seeded.agentId}`;
    }
  });
});

describe("browser_credentials: what a client can read of a row", () => {
  it("shows the label", async () => {
    const { data, error } = await colleague.db
      .from("browser_credentials")
      .select("label")
      .eq("id", agentScopedId)
      .single();
    expect(error).toBeNull();
    expect(data?.label).toBe("LinkedIn — sales account");
  });

  it("refuses either ciphertext to everybody, the person who saved it included", async () => {
    for (const user of [owner, colleague, outsider]) {
      for (const column of ["username_ciphertext", "password_ciphertext"]) {
        const { error } = await user.db.from("browser_credentials").select(column);
        expect(error?.code, `${column} should be withheld`).toBe("42501");
      }
    }
  });

  it("refuses a wildcard select, so the ciphertexts cannot be read sideways", async () => {
    const { error } = await owner.db.from("browser_credentials").select("*");
    expect(error?.code).toBe("42501");
  });

  it("grants authenticated exactly 0079's columns and anon none", async () => {
    const rows = (await sql()`
      select grantee, column_name from information_schema.column_privileges
      where table_schema = 'public' and table_name = 'browser_credentials'
        and grantee in ('anon', 'authenticated') and privilege_type = 'SELECT'
    `) as unknown as { grantee: string; column_name: string }[];
    expect(rows.filter((r) => r.grantee === "anon")).toEqual([]);
    expect(
      rows
        .filter((r) => r.grantee === "authenticated")
        .map((r) => r.column_name)
        .sort(),
    ).toEqual(GRANTED);
  });

  /**
   * "The username never", made structural. The username is stored only as
   * ciphertext, so there is no column for a future grant to open by mistake;
   * a plaintext `username` added for a screen's convenience fails here.
   */
  it("has no plaintext username column for anybody to grant", async () => {
    const rows = (await sql()`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'browser_credentials'
    `) as unknown as { column_name: string }[];
    expect(rows.map((r) => r.column_name).sort()).toEqual(ALL_COLUMNS);
  });
});

describe("browser_credentials: writes", () => {
  /**
   * The delete rule -- the saver always, a workspace admin for a shared
   * login -- lives in `lib/browser/credentials.ts` on the service-role path.
   * What this asserts is the half that makes that the ONLY path: no client
   * role holds a write grant, a column write grant or a write policy.
   */
  it("gives no client role a write of any kind, by grant and not only by policy", async () => {
    const surface = await writeSurface();
    expect(surface.table_grants).toBe(0);
    expect(surface.column_grants).toBe(0);
    expect(surface.write_policies).toBe(0);
  });

  it("cannot be relabelled or deleted from the browser", async () => {
    const { data: updated, error: updateError } = await owner.db
      .from("browser_credentials")
      .update({ label: "renamed by a client" })
      .eq("id", ownerScopedId)
      .select("id");
    expect(updateError?.code).toBe("42501");
    expect(updated ?? []).toEqual([]);
    const { error: deleteError } = await owner.db
      .from("browser_credentials")
      .delete()
      .eq("id", ownerScopedId);
    expect(deleteError?.code).toBe("42501");
    const [row] = (await sql()`
      select label from public.browser_credentials where id = ${ownerScopedId}
    `) as unknown as { label: string }[];
    expect(row?.label).toBe("LinkedIn — my own account");
  });

  /**
   * `site_host` is a bare lowercase host, the shape `allowedDomains` wants,
   * and the run binding (2.3) matches on it. Each of these is a mistake a
   * form would plausibly pass through: a pasted URL, a capital, a space.
   */
  it("refuses a site_host that is not a bare lowercase host", async () => {
    for (const site_host of ["https://x.com", "X.com", "a b.com"]) {
      const { error } = await serviceClient()
        .from("browser_credentials")
        .insert(credential({ site_host, scope: "owner", label: `bad ${site_host}` }));
      expect(error?.code, site_host).toBe("23514");
    }
  });

  it("refuses a scope nothing in the code writes", async () => {
    const { error } = await serviceClient()
      .from("browser_credentials")
      .insert(credential({ scope: "workspace", site_host: "example.com" }));
    expect(error?.code).toBe("23514");
  });

  /** `browser_credentials_owner_site_idx`: one personal login per person per site per agent. */
  it("refuses a second personal login for the same agent, person and site", async () => {
    const { error } = await serviceClient().from("browser_credentials").insert(credential());
    expect(error?.code).toBe("23505");
  });

  /**
   * `browser_credentials_agent_site_idx` (ruling R28): ONE shared login per
   * site per agent, whoever saves it. The owner already saved the agent's
   * LinkedIn login; a colleague saving another would leave the run binding
   * two accounts and nothing to choose between them by.
   */
  it("refuses a second member's shared login for the same agent and site", async () => {
    const { error } = await serviceClient()
      .from("browser_credentials")
      .insert(credential({ user_id: colleague.id, scope: "agent", label: "LinkedIn — mine too" }));
    expect(error?.code).toBe("23505");
  });

  /** The other half of R28: a personal login is per person, so two members may each keep one. */
  it("lets two members each keep a personal login for the same agent and site", async () => {
    const service = serviceClient();
    const { data, error } = await service
      .from("browser_credentials")
      .insert(credential({ user_id: colleague.id, scope: "owner", label: "LinkedIn — colleague" }))
      .select("id")
      .single();
    try {
      expect(error).toBeNull();
      const [{ owners }] = (await sql()`
        select count(distinct user_id)::int as owners from public.browser_credentials
        where agent_id = ${seeded.agentId} and site_host = 'linkedin.com' and scope = 'owner'
      `) as unknown as { owners: number }[];
      expect(owners).toBe(2);
    } finally {
      if (data?.id) {
        await service
          .from("browser_credentials")
          .delete()
          .eq("id", data.id as string);
      }
    }
  });

  /**
   * The fixture itself is the case: the owner holds their own LinkedIn login
   * and the agent's, side by side, and both inserts succeeded in `beforeAll`.
   * Asserted from the catalog so a future fixture change cannot quietly
   * remove the coverage.
   */
  it("lets one person hold a personal and a shared login for the same site", async () => {
    const rows = (await sql()`
      select scope from public.browser_credentials
      where agent_id = ${seeded.agentId} and user_id = ${owner.id} and site_host = 'linkedin.com'
    `) as unknown as { scope: string }[];
    expect(rows.map((r) => r.scope).sort()).toEqual(["agent", "owner"]);
  });
});
