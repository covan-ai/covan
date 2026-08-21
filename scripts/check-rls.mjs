#!/usr/bin/env node
/**
 * CI guard: every table these migrations create in `public` must also enable
 * Row Level Security.
 *
 * tests/rls/structure.test.ts already asserts this, and asserts it better —
 * against a real database, where a table created by a trigger or a function
 * cannot hide from it. But that suite needs Postgres, GoTrue and PostgREST up,
 * which is a minute of CI. This is the same claim in about a second, with no
 * database and no credentials, and it names the migration file that introduced
 * the gap rather than just the table. The two are not redundant: this one fails
 * first and explains itself, that one proves the policies actually behave.
 *
 * Why it needs a gate at all rather than review: the anon key is public by
 * design, and Supabase's bootstrap grants anon and authenticated full DML on
 * new tables in `public` (see `auto_expose_new_tables` in supabase/config.toml).
 * A `create table` without a matching `enable row level security` is therefore
 * not "missing hardening" — it is a table anyone on the internet can read and
 * write through PostgREST.
 *
 * Scope is deliberately narrow: whether RLS is ON. It does not read policies.
 * `using (true)` is a real exposure too, but whether a predicate is too broad is
 * a review question, not a lint one — and it is what the live suite is for.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// supabase/cloud/ only exists in the hosted repo, and holds migrations that are
// applied after the shared ones. Scanning it when present keeps this one file
// identical in both repos.
const DIRS = ["supabase/migrations", "supabase/cloud"]
  .map((d) => resolve(root, d))
  .filter((d) => existsSync(d));

/**
 * Tables that must stay without RLS, each with the reason. An empty map is the
 * healthy state; an entry here is a decision someone has to defend.
 */
const EXEMPT = new Map();

const CREATE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi;
const RLS_RE =
  /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+enable\s+row\s+level\s+security/gi;
// A rename splits a table's history in two: created under one name, RLS enabled
// under the other. Carrying both facts across keeps a renamed table from looking
// either uncreated or unprotected.
const RENAME_RE =
  /alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+rename\s+to\s+"?([a-z_][a-z0-9_]*)"?/gi;

/** table name -> the migration file that created it */
const created = new Map();
const rlsEnabled = new Set();

for (const dir of DIRS) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    const label = `${dir.slice(root.length + 1)}/${file}`;

    for (const m of sql.matchAll(CREATE_RE)) if (!created.has(m[1])) created.set(m[1], label);
    for (const m of sql.matchAll(RLS_RE)) rlsEnabled.add(m[1]);
    for (const m of sql.matchAll(RENAME_RE)) {
      const [, from, to] = m;
      if (created.has(from)) {
        created.set(to, created.get(from));
        created.delete(from);
      }
      if (rlsEnabled.has(from)) rlsEnabled.add(to);
    }
  }
}

// A guard on the guard. If the paths or the regexes ever stop matching, an empty
// result would otherwise pass as "nothing wrong here".
if (created.size === 0) {
  console.error(`ERROR: found no \`create table\` at all under ${DIRS.join(", ")}.`);
  console.error("Either the migrations moved or this checker's patterns went stale.");
  process.exit(1);
}

const missing = [...created]
  .filter(([table]) => !rlsEnabled.has(table) && !EXEMPT.has(table))
  .sort(([a], [b]) => a.localeCompare(b));

if (missing.length > 0) {
  console.error("ERROR: table(s) created in `public` without Row Level Security:\n");
  for (const [table, file] of missing) console.error(`  - ${table}  (created in ${file})`);
  console.error(
    "\nThe anon key is public, and Supabase grants anon full DML on new tables in",
    "\n`public`, so these are readable and writable by anyone. Add to the migration:",
    "\n",
    "\n  alter table public.<table> enable row level security;",
    "\n",
    "\nthen either a per-user policy, or no policy at all if only the service role",
    "\ntouches it — RLS with zero policies denies everyone, and service_role bypasses",
    "\nit. If you take the second route, add the table to SERVICE_ROLE_ONLY in",
    "\ntests/rls/structure.test.ts so the choice is recorded there too.",
  );
  process.exit(1);
}

console.log(
  `✓ all ${created.size} tables created under ${DIRS.length} director${DIRS.length === 1 ? "y" : "ies"} enable RLS`,
);
