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

/**
 * Tables no `service_role` will ever touch.
 *
 * `feedback` is written in `routes/feedback.ts` through the caller's own
 * client, so the row is authored by the person who wrote it and RLS is the
 * whole mechanism rather than something to get past. There is no engine path to
 * it and no webhook that arrives without a caller — the two shapes that force a
 * table onto the service role — so the omission in 0041 is a decision.
 *
 * The default is the other way round, deliberately. A table that turns out not
 * to need the grant costs one line here and a sentence saying why; a table that
 * needed it and did not get one costs an afternoon of reading a third party's
 * OAuth documentation. That asymmetry is the whole argument for the list being
 * exemptions rather than opt-ins.
 */
const NO_SERVICE_GRANT = new Set(["feedback"]);

/**
 * The migrations that create a table the service role writes and grant it in a
 * later file.
 *
 * The same kind of entry as `GRANTED_LATE` above and for the same reason: an
 * applied migration is not rewritten, so the grant lives in a later file and
 * this list says which.
 *
 * 0033 is here as well as in `GRANTED_LATE` — it granted nothing to anybody,
 * and 0034 supplied both halves. 0043 and 0044 are the second occurrence, three
 * migrations later, and the narrower one: they did grant, generously, to
 * `authenticated`, which is precisely why the version of this test that did not
 * name a role called them correct.
 *
 * It is a record of the same mistake twice, not a mechanism. A fourth entry
 * would mean this file has become a place to register exceptions rather than a
 * thing that stops them.
 */
const SERVICE_GRANTED_LATE = new Map([
  ["0033_a_key_that_is_a_person.sql", "granted by 0034"],
  ["0043_a_bundle_that_keeps_itself_current.sql", "granted by 0045"],
  ["0044_an_agent_you_can_ask_from_a_channel.sql", "granted by 0045"],
]);

/** `create table [if not exists] [public.]<name>`, across every migration. */
function tablesCreatedIn(sql: string): string[] {
  const matches = sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)/gi);
  return [...matches].map((m) => m[1]);
}

type Role = "authenticated" | "service_role";

/**
 * Whether this file grants something on that table **to this role**.
 *
 * The role used to be implicit, and that is the hole 0043 went through. It
 * grants on `connections` — carefully, with a column list — and it grants to
 * `authenticated` only. Asking "is there a grant?" got a yes, the suite stayed
 * green, and on the hosted project the service client got
 * `42501 permission denied` on the INSERT that ends the OAuth flow. 0045 is the
 * repair; this parameter is what stops the third occurrence.
 *
 * `[^;]` rather than `[\s\S]`, so the match cannot run past the semicolon that
 * ends the statement. Without it, `grant ... to authenticated;` followed later
 * in the file by any mention of `service_role` — a policy, a function grant, a
 * comment — reads as a grant to `service_role`. 0043 contains exactly that
 * pair, so the loose version would have gone on passing after being taught the
 * question.
 */
function grantsFor(sql: string, table: string, role: Role): boolean {
  // Both shapes count: `grant ... on public.api_keys to authenticated` and
  // 0023's `grant ... on all tables in schema public to anon, authenticated,
  // service_role`.
  const specific = new RegExp(
    `grant[^;]*?\\bon\\s+(?:table\\s+)?(?:public\\.)?${table}\\b[^;]*?\\b${role}\\b`,
    "i",
  );
  const blanket = new RegExp(
    `grant[^;]*?\\bon\\s+all\\s+tables\\s+in\\s+schema\\s+public\\b[^;]*?\\b${role}\\b`,
    "i",
  );
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
        if (!grantsFor(sql, table, "authenticated")) {
          offenders.push(`${file} creates ${table} and grants nothing to authenticated`);
        }
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
      .filter((t) => !all.some(([, sql]) => grantsFor(sql, t, "authenticated")))
      .sort();

    expect(ungranted).toEqual([]);
  });

  it("is granted to service_role by the same migration that creates the table", () => {
    // The rule above, asked again about the role that actually broke. Both
    // halves have to be checked separately or one satisfies the other: 0043
    // grants generously to `authenticated` and not at all to `service_role`,
    // and a single combined question calls that a pass.
    const offenders: string[] = [];

    for (const [file, sql] of migrations()) {
      if (file < "0023") continue;
      if (SERVICE_GRANTED_LATE.has(file)) continue;
      for (const table of tablesCreatedIn(sql)) {
        if (NO_SERVICE_GRANT.has(table)) continue;
        if (!grantsFor(sql, table, "service_role")) {
          offenders.push(`${file} creates ${table} and grants nothing to service_role`);
        }
      }
    }

    expect(
      offenders,
      "A table the engine, a webhook, or an OAuth callback writes is reached " +
        "with the service client, which BYPASSRLS but not the grants — so a " +
        "missing one is 42501 in production and nothing anywhere else. Add " +
        "`grant select, insert, update, delete on public.<table> to " +
        "service_role;` to the same migration, or name the table in " +
        "NO_SERVICE_GRANT with the reason no service path reaches it.",
    ).toEqual([]);
  });

  it("grants service_role for every table that needs one, somewhere", () => {
    // The whole-set view, as above: 0023's blanket names `service_role` too, so
    // everything older than it is already satisfied and only a table created
    // after it and never granted shows up here.
    const all = migrations();
    const created = new Set(all.flatMap(([, sql]) => tablesCreatedIn(sql)));

    const ungranted = [...created]
      .filter((t) => !NO_SERVICE_GRANT.has(t))
      .filter((t) => !all.some(([, sql]) => grantsFor(sql, t, "service_role")))
      .sort();

    expect(ungranted).toEqual([]);
  });

  it("does not read a grant to one role as a grant to another", () => {
    // The bug in this test, written down as a test. 0043 grants on
    // `connections` to `authenticated`, and later in the same file grants
    // EXECUTE on `claim_due_connections` to `service_role` — which is what a
    // pattern spanning semicolons would have latched onto.
    const sql = readFileSync(
      join(MIGRATIONS, "0043_a_bundle_that_keeps_itself_current.sql"),
      "utf8",
    );

    expect(grantsFor(sql, "connections", "authenticated")).toBe(true);
    expect(grantsFor(sql, "connections", "service_role")).toBe(false);
  });

  it("keeps the late-grant list to the one mistake it records", () => {
    // The exception above is a record, not a door. If this list grows, the rule
    // it is an exception to has stopped being a rule.
    expect([...GRANTED_LATE.keys()]).toEqual(["0033_a_key_that_is_a_person.sql"]);
  });

  it("keeps the late service-grant list to the three files it records", () => {
    // Same door, same reason it stays shut. 0043 and 0044 shipped together and
    // are repaired together by 0045; a fourth entry means somebody chose to
    // split a table from its grant again rather than write the grant.
    expect([...SERVICE_GRANTED_LATE.keys()]).toEqual([
      "0033_a_key_that_is_a_person.sql",
      "0043_a_bundle_that_keeps_itself_current.sql",
      "0044_an_agent_you_can_ask_from_a_channel.sql",
    ]);
  });

  it("names the five tables 0045 repairs", () => {
    // Explicit rather than implied, exactly as the api_keys case below: the
    // general rules would keep passing if 0045 were reverted and 0043 rewritten
    // in place, and this would not.
    const sql = readFileSync(join(MIGRATIONS, "0045_the_grant_0043_forgot.sql"), "utf8");

    for (const table of [
      "connections",
      "connection_runs",
      "slack_installations",
      "slack_identities",
      "slack_threads",
    ]) {
      expect(grantsFor(sql, table, "service_role"), `0045 grants ${table}`).toBe(true);
    }
  });

  it("names api_keys, which is the table this test exists because of", () => {
    // Explicit rather than implied: the general rules above would keep passing
    // if 0034 were reverted and 0033 rewritten, and this would not.
    const all = migrations();
    expect(all.some(([, sql]) => /grant[\s\S]*?on\s+public\.api_keys/i.test(sql))).toBe(true);
  });
});
