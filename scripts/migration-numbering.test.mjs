import { describe, it, expect } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * No two migrations in a directory may share a number.
 *
 * This is not tidiness. `docker/migrate.sh` records what it has applied by
 * **filename**, in `covan_meta.migrations`. The Supabase CLI — which is what
 * `supabase start` and any local reset run — records it by **version**, the
 * numeric prefix alone, in `supabase_migrations.schema_migrations`. Two files
 * called `0039_a.sql` and `0039_b.sql` are therefore two migrations to one tool
 * and one migration to the other: the CLI applies whichever it reaches first,
 * writes `0039`, and silently skips the other. No error, and a schema that is
 * missing a migration nothing will ever try to apply again.
 *
 * It gets worse from there, because `tests/rls/preflight.ts` treats a file in a
 * CLI-managed directory as applied if *either* ledger knows it (covan#57, and
 * the per-directory `cli` flag in covan#82). One `0039` in
 * `schema_migrations` therefore vouches for both, so the preflight that exists
 * to catch a database behind the checkout reports everything present. The
 * suite then runs green against a schema missing a table.
 *
 * How it happens is the ordinary way: two branches open at the same time, both
 * read `ls supabase/migrations | tail -1`, both pick the next number, and
 * whichever merges second is a collision nobody looked for. It happened on
 * 2026-09-02 with two `0039`s, and this test is the reason it should not
 * happen twice.
 *
 * **Per directory, not across them.** `supabase/cloud/` is applied by
 * `migrate.sh` and never by the CLI, and it has held its own `0001` since it
 * was created — that overlap with `supabase/migrations/0001_init.sql` is
 * deliberate and covan#82 turned on the flag that makes it safe. Comparing the
 * two directories to each other would fail on a decision already taken.
 *
 * **The fix when this fails** is to renumber, and which file moves is not a
 * coin toss: the one that has not been applied to production yet moves, and if
 * both have, the one whose migration is idempotent does. A rename orphans the
 * ledger row keyed on the old filename, so the file comes back around for a
 * second application under its new name — harmless for a migration written
 * with `if not exists` throughout, an error for one that was not.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DIRS = ["supabase/migrations", "supabase/cloud"].filter((d) => existsSync(resolve(root, d)));

function migrationsIn(dir) {
  return readdirSync(resolve(root, dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** The CLI's idea of a version: the leading digits, and nothing else. */
function versionOf(filename) {
  return /^(\d+)/.exec(filename)?.[1] ?? null;
}

describe("migration numbering", () => {
  // A guard on the guard, in the shape `check-rls.mjs` uses: if the paths ever
  // move, an empty directory list would pass this file as "nothing wrong here".
  it("found the migration directories at all", () => {
    expect(DIRS.length).toBeGreaterThan(0);
    expect(migrationsIn(DIRS[0]).length).toBeGreaterThan(0);
  });

  it.each(DIRS)("%s numbers every migration exactly once", (dir) => {
    const byVersion = new Map();
    for (const file of migrationsIn(dir)) {
      const version = versionOf(file);
      if (version === null) continue;
      byVersion.set(version, [...(byVersion.get(version) ?? []), file]);
    }

    const collisions = [...byVersion]
      .filter(([, files]) => files.length > 1)
      .map(([version, files]) => `${version}: ${files.join(", ")}`);

    expect(collisions).toEqual([]);
  });

  it.each(DIRS)("%s names every migration so a version can be read off it", (dir) => {
    const unnumbered = migrationsIn(dir).filter((f) => versionOf(f) === null);

    expect(unnumbered).toEqual([]);
  });
});
