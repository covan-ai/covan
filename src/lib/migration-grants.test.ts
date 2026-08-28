import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A table without a grant is invisible to every test we have.
 *
 * `0023_grants_supabase_no_longer_gives.sql` records the platform change behind
 * this: Supabase used to give `anon`, `authenticated` and `service_role` full
 * DML on any table added to `public`, and stopped. A migration that creates a
 * table and does not grant for it produces a schema whose policies are all
 * correct and whose every request answers `42501 permission denied`.
 *
 * 0023 closed it and wrote the rule — grant in the same file — and 0033, the
 * first migration to add a table afterwards, broke it anyway. Nothing failed.
 * Not the unit tests, and not `tests/rls/api-keys.test.ts`, which inserts and
 * reads those very rows: both the compose stack and the Supabase CLI stack ship
 * the old permissive default, so the missing grant is invisible to any database
 * we are willing to test against. The one that shows it is production.
 *
 * So this checks the files rather than a database. It reads
 * `supabase/migrations/` on disk, needs nothing running, and is right in CI, on
 * a laptop, and in either repository — which is exactly what a guard for
 * "something is different about production" has to be.
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

/**
 * Tables that are deliberately reachable by no client role.
 *
 * `routine_deliveries` is written and read only by the scheduled Worker through
 * the service-role client — 0023 revokes it from `anon` and `authenticated` on
 * purpose, and `tests/rls/structure.test.ts` carries the same name in its own
 * service-role-only list. An entry here is a decision, not an exemption from
 * thinking.
 */
const NO_CLIENT_GRANT = new Set(["routine_deliveries"]);

/**
 * The one migration that creates a table and grants in a later file.
 *
 * 0033 is why this test exists. It reached production before the omission was
 * found, and an applied migration is not rewritten — every database that ran it
 * has it recorded — so the grant lives in 0034 and this entry says so out loud.
 *
 * It is a record of one mistake, not a mechanism. A second entry here would mean
 * somebody chose to split a table from its grant, which is the arrangement 0023
 * wrote its closing paragraph against.
 */
const GRANTED_LATE = new Map([["0033_a_key_that_is_a_person.sql", "granted by 0034"]]);

/** `create table [if not exists] [public.]<name>`, across every migration. */
function tablesCreatedIn(sql: string): string[] {
  const matches = sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)/gi);
  return [...matches].map((m) => m[1]);
}

/** Whether this file grants something on that table to a client role. */
function grantsFor(sql: string, table: string): boolean {
  // Both shapes count: `grant ... on public.api_keys to authenticated` and
  // 0023's `grant ... on all tables in schema public`.
  const specific = new RegExp(`grant[\\s\\S]*?on\\s+(?:table\\s+)?(?:public\\.)?${table}\\b`, "i");
  const blanket = /grant[\s\S]{0,80}on\s+all\s+tables\s+in\s+schema\s+public/i;
  return specific.test(sql) || blanket.test(sql);
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Every migration, oldest first, as `[filename, contents]`. */
function migrations(): [string, string][] {
  return migrationFiles().map((f) => [f, readFileSync(join(MIGRATIONS, f), "utf8")]);
}

describe("table grants", () => {
  it("finds the migrations it is meant to be reading", () => {
    // A guard on the guard: an empty directory would pass everything below.
    expect(migrationFiles().length).toBeGreaterThan(20);
  });

  it("is granted by the same migration that creates the table", () => {
    // The rule 0023 wrote, enforced. Everything before 0023 inherited the old
    // platform default and is correct as it stands; re-litigating those files
    // would only produce noise, so the rule starts where the rule started.
    const offenders: string[] = [];

    for (const [file, sql] of migrations()) {
      if (file < "0023") continue;
      if (GRANTED_LATE.has(file)) continue;
      for (const table of tablesCreatedIn(sql)) {
        if (NO_CLIENT_GRANT.has(table)) continue;
        if (!grantsFor(sql, table)) offenders.push(`${file} creates ${table} and grants nothing`);
      }
    }

    expect(
      offenders,
      "Supabase no longer grants DML on a new table — see 0023. Add " +
        "`grant select, insert, update, delete on public.<table> to authenticated" +
        "[, service_role];` to the same migration, or name the table in " +
        "NO_CLIENT_GRANT if no client should ever reach it.",
    ).toEqual([]);
  });

  it("grants for every table that exists today, somewhere", () => {
    // The rule above only looks forward. This looks at the whole set, so a table
    // created before 0023 and still ungranted anywhere would be caught too —
    // 0023's blanket statement satisfies all of them, which is the point.
    const all = migrations();
    const created = new Set(all.flatMap(([, sql]) => tablesCreatedIn(sql)));

    const ungranted = [...created]
      .filter((t) => !NO_CLIENT_GRANT.has(t))
      .filter((t) => !all.some(([, sql]) => grantsFor(sql, t)))
      .sort();

    expect(ungranted).toEqual([]);
  });

  it("keeps the late-grant list to the one mistake it records", () => {
    // The exception above is a record, not a door. If this list grows, the rule
    // it is an exception to has stopped being a rule.
    expect([...GRANTED_LATE.keys()]).toEqual(["0033_a_key_that_is_a_person.sql"]);
  });

  it("names api_keys, which is the table this test exists because of", () => {
    // Explicit rather than implied: the general rules above would keep passing
    // if 0034 were reverted and 0033 rewritten, and this would not.
    const all = migrations();
    expect(all.some(([, sql]) => /grant[\s\S]*?on\s+public\.api_keys/i.test(sql))).toBe(true);
  });
});
