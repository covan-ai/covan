/**
 * Invariants over the schema itself, rather than over any one policy.
 *
 * This is the file that earns the suite its keep. The behavioural tests in
 * isolation.test.ts can only check tables that exist today; these checks apply
 * to every table anyone adds later, which is the case we actually care about
 * once the repo takes outside contributions.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anonClient, closeSql, sql } from "./harness";

/**
 * Tables that intentionally have no policies at all.
 *
 * RLS with zero policies denies everyone, so this is a safe state, not a
 * dangerous one — but it must be a decision rather than an oversight, which is
 * what this list records. These rows are written and read only by the Worker
 * through the service-role client, which bypasses RLS: `routine_deliveries` by
 * the scheduled sync, and — on the hosted service only — `credit_holds` by the
 * credit check before every step of a turn (supabase/cloud/0004),
 * `signup_grant_addresses` by the new-workspace trigger (cloud/0005), and
 * `passage_vector_changes` by 0116's trigger and the background tick.
 */
const SERVICE_ROLE_ONLY = new Set([
  "routine_deliveries",
  "credit_holds",
  "signup_grant_addresses",
  "passage_vector_changes",
]);

// The two that exist only where supabase/cloud/ is applied. A database without
// them is the open-source one, not a stale list.
const HOSTED_ONLY = new Set(["credit_holds", "signup_grant_addresses"]);

let tables: string[] = [];

beforeAll(async () => {
  const rows = await sql()<{ name: string }[]>`
    select c.relname as name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  `;
  tables = rows.map((r) => r.name);
});

afterAll(closeSql);

describe("row level security", () => {
  it("finds the schema it expects", () => {
    // A guard on the guard: if this query ever comes back empty, every other
    // assertion in the file passes vacuously.
    expect(tables.length).toBeGreaterThan(0);
  });

  it("is enabled on every table in public", async () => {
    const rows = await sql()<{ name: string }[]>`
      select c.relname as name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
      order by c.relname
    `;

    // Named rather than counted, so a failure says which migration to look at.
    expect(rows.map((r) => r.name)).toEqual([]);
  });

  it("is not left toothless — every table has a policy, or is declared service-role-only", async () => {
    const rows = await sql()<{ name: string }[]>`
      select c.relname as name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
      group by c.relname
      having count(p.polname) = 0
      order by c.relname
    `;

    const undeclared = rows.map((r) => r.name).filter((name) => !SERVICE_ROLE_ONLY.has(name));
    expect(undeclared).toEqual([]);
  });

  it("has no stale entries in the service-role-only list", async () => {
    // The list above is a licence to skip a check. If a table gains policies,
    // or disappears, the licence should go with it.
    const rows = await sql()<{ name: string; policies: number }[]>`
      select c.relname as name, count(p.polname)::int as policies
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public' and c.relkind = 'r'
      group by c.relname
    `;
    const byName = new Map(rows.map((r) => [r.name, r.policies]));

    for (const name of SERVICE_ROLE_ONLY) {
      if (HOSTED_ONLY.has(name) && !byName.has(name)) continue;
      expect(byName.has(name), `${name} is listed as service-role-only but no longer exists`).toBe(
        true,
      );
      expect(byName.get(name), `${name} has policies now — drop it from SERVICE_ROLE_ONLY`).toBe(0);
    }
  });
});

describe("an anonymous caller", () => {
  /**
   * Postgres grants are wide open here: Supabase's legacy auto-expose behaviour
   * hands `anon` full DML on nearly every table (`auto_expose_new_tables` in
   * supabase/config.toml). RLS is the only thing standing in front of that, so
   * this is the test that proves the door is actually shut — and it keeps
   * proving it for tables that do not exist yet.
   */
  it("can read nothing, from any table", async () => {
    const anon = anonClient();

    const readable: string[] = [];
    for (const table of tables) {
      const { data, error } = await anon.from(table).select("*").limit(1);
      // An error here means the grant itself is missing, which is stricter than
      // RLS and equally fine. Rows coming back is the failure.
      if (!error && data && data.length > 0) readable.push(table);
    }

    expect(readable).toEqual([]);
  });

  // Reading was the only thing this suite asked of `anon`, and the only thing
  // that kept writes out was the policies — until 0089 took every grant away.
  // So the refusal asked for here is the grant's (42501), not a policy's empty
  // answer: a table `anon` could write to the moment somebody added a careless
  // policy is the failure.
  it("can write nothing, to any table, by grant", async () => {
    const anon = anonClient();

    const writable: string[] = [];
    for (const table of tables) {
      const insert = await anon.from(table).insert({});
      const [first] = await sql()<{ column_name: string }[]>`
        select column_name from information_schema.columns
         where table_schema = 'public' and table_name = ${table}
         order by ordinal_position limit 1`;
      const remove = await anon.from(table).delete().is(first.column_name, null);
      if (insert.error?.code !== "42501" || remove.error?.code !== "42501") writable.push(table);
    }

    expect(writable).toEqual([]);
  });

  it("can call none of the functions a signed-in client calls", async () => {
    const anon = anonClient();
    const id = "00000000-0000-4000-8000-000000000000";
    const calls: Array<[string, Record<string, unknown>]> = [
      ["create_workspace", { p_name: "anon" }],
      ["is_workspace_member", { p_workspace_id: id }],
      ["soft_delete_document", { p_document_id: id }],
      ["restore_agent", { p_agent_id: id }],
      ["set_agent_sharing", { p_agent_id: id, p_workspace_access: null, p_shares: [] }],
      ["agent_access", { p_agent_id: id }],
      ["workspace_usage_all", { p_workspace_id: id }],
    ];

    const callable: string[] = [];
    for (const [fn, args] of calls) {
      const { error } = await anon.rpc(fn, args);
      if (error?.code !== "42501") callable.push(`${fn}: ${error?.code ?? "ok"}`);
    }

    expect(callable).toEqual([]);
  });
});

describe("security definer functions", () => {
  /**
   * The policies lean on SECURITY DEFINER helpers (`is_workspace_member`,
   * `shares_workspace`) to avoid infinite recursion — see the comments in
   * 0001_init.sql. A definer function runs as its owner, so one without a
   * pinned search_path can be steered into resolving an unqualified name
   * against an attacker-controlled schema. Every one of them in this repo sets
   * it; this makes the next one do the same.
   */
  it("all pin a search_path", async () => {
    const rows = await sql()<{ name: string }[]>`
      select p.proname as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef = true
        and (p.proconfig is null or not exists (
          select 1 from unnest(p.proconfig) as c(setting)
          where c.setting like 'search_path=%'
        ))
      order by p.proname
    `;

    expect(rows.map((r) => r.name)).toEqual([]);
  });

  /**
   * The catalog half of `worker/src/definer-grant.static.test.ts`'s anon rule,
   * and the half that cannot be fooled by a revoke the static test reads but a
   * later `drop function` undid.
   *
   * Supabase grants EXECUTE on new functions to `anon` by name, so this asks
   * the database rather than the migrations. 0084_the_deleted_and_the_anonymous
   * left the five policy helpers, because `anon` still held table privileges
   * and every policy naming one is `to public`. 0089 took those table
   * privileges, and the helpers with them, so nothing remains.
   * docs/security.md has the rule.
   */
  it("are not executable by anon", async () => {
    const rows = await sql()<{ name: string }[]>`
      select p.proname as name
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prosecdef = true
        and has_function_privilege('anon', p.oid, 'execute')
      order by p.proname
    `;

    expect(rows.map((r) => r.name)).toEqual([]);
  });
});

/**
 * Two-step sign-in (0108) rests on two pieces of configuration that nothing in
 * a migration's own success proves are still in place: the PostgREST hook, and
 * the policies standing in for it where PostgREST is not in the path. Either
 * missing leaves an account's authenticator decorative, and every other test
 * in this suite green.
 */
describe("the second step", () => {
  it("is asked of every PostgREST request", async () => {
    const [row] = await sql()<{ config: string[] | null }[]>`
      select rolconfig as config from pg_roles where rolname = 'authenticator'
    `;

    expect(row.config ?? []).toContain("pgrst.db_pre_request=public.require_second_factor");
  });

  // Realtime decides what to deliver from table policies alone. A table added
  // to the publication without one would stream rows to a session that has
  // not given its code.
  it("is asked by a restrictive policy on every table Realtime publishes", async () => {
    const rows = await sql()<{ name: string }[]>`
      select pt.tablename as name
      from pg_publication_tables pt
      where pt.pubname = 'supabase_realtime'
        and pt.schemaname = 'public'
        and not exists (
          select 1 from pg_policies p
          where p.schemaname = 'public'
            and p.tablename = pt.tablename
            and p.permissive = 'RESTRICTIVE'
            and p.qual like '%second_factor_satisfied%'
        )
      order by pt.tablename
    `;

    expect(rows.map((r) => r.name)).toEqual([]);
  });
});
