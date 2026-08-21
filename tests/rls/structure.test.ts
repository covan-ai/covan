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
 * what this list records. These rows are written and read only by the scheduled
 * Worker through the service-role client, which bypasses RLS.
 */
const SERVICE_ROLE_ONLY = new Set(["routine_deliveries"]);

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
});
