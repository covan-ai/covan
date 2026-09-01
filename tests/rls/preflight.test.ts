import { describe, it, expect } from "vitest";

import { missingMigrations, unknownToCheckout, type Ledger, type MigrationFile } from "./preflight";

/*
 * The comparison behind the preflight check in `preflight.ts`, tested without a
 * database. The check itself runs as `globalSetup`, where it cannot be asserted
 * on — a `globalSetup` that throws takes the run with it, which is the point of
 * it. This covers the part that decides whether it throws.
 *
 * It lives in tests/rls/ rather than src/ because that is where the code is.
 * It needs no database of its own; the suite around it already has one.
 */
const ledger = (patch: Partial<{ filenames: string[]; versions: string[] }> = {}): Ledger => ({
  filenames: new Set(patch.filenames ?? []),
  versions: new Set(patch.versions ?? []),
});

/** Under `supabase/migrations/` — the one directory the CLI reads. */
const shared = (...names: string[]): MigrationFile[] => names.map((name) => ({ name, cli: true }));
/** Under `supabase/cloud/`, which only `docker/migrate.sh` applies. */
const hosted = (...names: string[]): MigrationFile[] => names.map((name) => ({ name, cli: false }));

const FILES = shared("0001_init.sql", "0002_policies.sql", "0003_api_keys.sql");
const NAMES = FILES.map((file) => file.name);

describe("missingMigrations", () => {
  it("finds nothing when the compose ledger has every file", () => {
    expect(missingMigrations(FILES, ledger({ filenames: NAMES }))).toEqual([]);
  });

  it("names the files a compose stack has not applied", () => {
    // The shape of the failure this whole check exists for: the database was at
    // 0029, the repository at 0034, and `api_keys` did not exist.
    expect(missingMigrations(FILES, ledger({ filenames: NAMES.slice(0, 1) }))).toEqual([
      "0002_policies.sql",
      "0003_api_keys.sql",
    ]);
  });

  it("accepts the CLI's version prefixes as applied", () => {
    // `supabase start` records `0001`, not `0001_init.sql`. Matching only on
    // filenames would report every migration as missing on a stack that has
    // them all — a check that fails where nothing is wrong is worse than none.
    expect(missingMigrations(FILES, ledger({ versions: ["0001", "0002", "0003"] }))).toEqual([]);
  });

  it("names what the CLI is missing, by prefix", () => {
    expect(missingMigrations(FILES, ledger({ versions: ["0001", "0002"] }))).toEqual([
      "0003_api_keys.sql",
    ]);
  });

  it("takes either ledger as an answer", () => {
    // Nothing stops a database from having both tables — a compose stack that
    // was once pointed at by the CLI, or the reverse. A file applied by either
    // route is applied.
    expect(
      missingMigrations(FILES, ledger({ filenames: ["0003_api_keys.sql"], versions: ["0001"] })),
    ).toEqual(["0002_policies.sql"]);
  });

  it("reports everything when both ledgers are empty", () => {
    expect(missingMigrations(FILES, ledger())).toEqual(NAMES);
  });

  it("does not let a shared prefix vouch for a hosted-only file", () => {
    // The hosted tree numbers supabase/cloud/ from 0001 of its own, so
    // `0001_user_usage.sql` and `0001_init.sql` have the same version and are
    // different migrations. `supabase start` never reads supabase/cloud/ at
    // all, so its `0001` can only ever mean the shared one — and treating the
    // prefix as an answer for both would report a database as up to date while
    // `user_usage` did not exist.
    const tree = [...FILES, ...hosted("0001_user_usage.sql")];
    expect(missingMigrations(tree, ledger({ versions: ["0001", "0002", "0003"] }))).toEqual([
      "0001_user_usage.sql",
    ]);
  });

  it("takes the compose ledger's word for a hosted-only file", () => {
    // The route that does apply it keys on the filename, where there is no
    // collision — migrate.sh refuses one outright.
    const tree = [...FILES, ...hosted("0001_user_usage.sql")];
    expect(
      missingMigrations(tree, ledger({ filenames: [...NAMES, "0001_user_usage.sql"] })),
    ).toEqual([]);
  });
});

describe("unknownToCheckout", () => {
  it("says nothing when the database matches", () => {
    expect(unknownToCheckout(FILES, ledger({ filenames: NAMES }))).toEqual([]);
  });

  it("names a migration the database has and the branch does not", () => {
    expect(
      unknownToCheckout(FILES, ledger({ filenames: [...NAMES, "0004_from_another_branch.sql"] })),
    ).toEqual(["0004_from_another_branch.sql"]);
  });

  it("does not read a hosted-only file as a stray ledger entry", () => {
    const tree = [...FILES, ...hosted("0001_user_usage.sql")];
    expect(
      unknownToCheckout(tree, ledger({ filenames: [...NAMES, "0001_user_usage.sql"] })),
    ).toEqual([]);
  });
});
