/**
 * Refuses to run the RLS suite against a database that is behind the checkout.
 *
 * The compose stack applies `supabase/migrations/` once, at `docker compose up`.
 * Pull new migrations and the containers keep serving the old schema — and the
 * suite then reports policy failures for policies that were never installed.
 * That is the worst shape a red suite can take: it blames the code for the
 * environment, and the danger is not the confusion, it is somebody "fixing" a
 * policy that was correct.
 *
 * So this runs once, before any test file, and turns a dozen misleading
 * failures into one sentence naming the missing files. It is `globalSetup`
 * rather than a test on purpose: CI builds a fresh database every run and would
 * never trip it, and a test that only ever passes in CI is protecting CI rather
 * than the laptop where the problem actually happens.
 *
 * Two ledgers, because there are two supported ways to have a database here and
 * they do not record the same thing:
 *
 *   covan_meta.migrations                   docker/migrate.sh — filenames
 *   supabase_migrations.schema_migrations   the Supabase CLI — version prefixes
 *
 * `resolveConfig` in harness.ts accepts either stack, so this has to as well; a
 * check that only understood the compose ledger would fail every `supabase
 * start` run with a message about migrations that are, in fact, applied.
 */

import { existsSync, readdirSync } from "node:fs";

import { sql, closeSql } from "./harness";

/**
 * The directories the stack applies, in the order it applies them.
 *
 * These are `docker/migrate.sh`'s two default mounts: the schema everybody
 * gets, and a deployment's own additions. The second is absent in the
 * open-source tree, which is why it is checked for rather than assumed — the
 * same file then works in both.
 *
 * `cli` marks the one directory `supabase start` knows about. It matters
 * because the two ledgers key on different things, and only one of them can
 * speak for a hosted-only file. See `versionOf`.
 */
const MIGRATION_DIRS = [
  { path: "supabase/migrations", cli: true },
  { path: "supabase/cloud", cli: false },
];

export type MigrationFile = {
  name: string;
  /** Whether a CLI stack would have applied this file, had one been used. */
  cli: boolean;
};

function migrationFilesOnDisk(): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const dir of MIGRATION_DIRS) {
    if (!existsSync(dir.path)) continue;
    for (const name of readdirSync(dir.path)) {
      if (name.endsWith(".sql")) files.push({ name, cli: dir.cli });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `0034_something.sql` → `0034`. What the Supabase CLI stores as a version.
 *
 * A prefix is only unique inside one directory. The hosted tree numbers
 * `supabase/cloud/` from 0001 of its own, so `0001_user_usage.sql` and
 * `0001_init.sql` share a version while being different migrations —
 * `docker/migrate.sh` gets away with it because its ledger keys on the full
 * filename, and it refuses a genuine filename collision outright.
 *
 * So a version only ever answers for a file the CLI could have applied, which
 * is `supabase/migrations/` and nothing else. Without that restriction a CLI
 * stack in the hosted tree would count `0001_user_usage.sql` as applied on the
 * strength of `0001_init.sql` — and it is a file the CLI never even reads.
 */
function versionOf(filename: string): string {
  return filename.split("_")[0];
}

export type Ledger = {
  /** Filenames, from `covan_meta.migrations`. Empty if that table is absent. */
  filenames: Set<string>;
  /** Version prefixes, from the CLI's table. Empty if that table is absent. */
  versions: Set<string>;
};

/**
 * Files on disk that neither ledger accounts for — the database is behind.
 *
 * A file counts as applied if either ledger knows it, because the two stacks
 * record it differently and a developer has only ever used one of them.
 */
export function missingMigrations(onDisk: MigrationFile[], ledger: Ledger): string[] {
  return onDisk
    .filter(
      (file) =>
        !ledger.filenames.has(file.name) &&
        !(file.cli && ledger.versions.has(versionOf(file.name))),
    )
    .map((file) => file.name);
}

/**
 * Ledger entries with no file behind them — the checkout is behind.
 *
 * Not an error: every policy under test is installed, so the suite is sound.
 * It means the branch is older than the database, which is worth one line
 * before somebody reads a green run as a statement about this branch.
 */
export function unknownToCheckout(onDisk: MigrationFile[], ledger: Ledger): string[] {
  const names = new Set(onDisk.map((file) => file.name));
  const versions = new Set(onDisk.filter((file) => file.cli).map((file) => versionOf(file.name)));
  return [
    ...[...ledger.filenames].filter((name) => !names.has(name)),
    ...[...ledger.versions].filter((version) => !versions.has(version)),
  ].sort();
}

export async function setup() {
  const onDisk = migrationFilesOnDisk();
  if (onDisk.length === 0) {
    throw new Error(
      `No .sql files under ${MIGRATION_DIRS.map((dir) => dir.path).join(" or ")}. ` +
        "The suite is being run from somewhere that is not the repository root.",
    );
  }

  const db = sql();
  try {
    // `to_regclass` answers null instead of raising, so a stack with neither
    // ledger is a message rather than a stack trace.
    const [present] = await db<{ compose: boolean; cli: boolean }[]>`
      select to_regclass('covan_meta.migrations') is not null as compose,
             to_regclass('supabase_migrations.schema_migrations') is not null as cli
    `;

    if (!present.compose && !present.cli) {
      throw new Error(
        "This database has no migration ledger, so nothing has been applied to it.\n" +
          "  Compose stack:  docker compose up migrate\n" +
          "  Supabase CLI:   supabase start",
      );
    }

    const ledger: Ledger = { filenames: new Set(), versions: new Set() };
    if (present.compose) {
      const rows = await db<{ filename: string }[]>`select filename from covan_meta.migrations`;
      for (const row of rows) ledger.filenames.add(row.filename);
    }
    // Version prefixes, kept in their own set: the CLI records `0034`, not
    // `0034_a_name.sql`, and matching a bare number against filenames would
    // count nothing.
    if (present.cli) {
      const rows = await db<
        { version: string }[]
      >`select version from supabase_migrations.schema_migrations`;
      for (const row of rows) ledger.versions.add(row.version);
    }

    const missing = missingMigrations(onDisk, ledger);

    if (missing.length > 0) {
      const how = present.compose ? "docker compose up migrate" : "supabase migration up";
      throw new Error(
        `The database is behind this checkout by ${missing.length} migration${
          missing.length === 1 ? "" : "s"
        }.\n\n` +
          missing.map((name) => `  ${name}`).join("\n") +
          `\n\nEvery policy those files install is missing, so the suite would report ` +
          `them as regressions in code that is fine. Apply them first:\n\n  ${how}\n`,
      );
    }

    const unknown = unknownToCheckout(onDisk, ledger);
    if (unknown.length > 0) {
      console.warn(
        `\nThis database has ${unknown.length} migration(s) this checkout does not: ` +
          `${unknown.sort().join(", ")}.\n` +
          `The schema is ahead of the branch. Nothing here will fail because of it.\n`,
      );
    }
  } finally {
    await closeSql();
  }
}
