import { defineConfig } from "vitest/config";

// Separate from vitest.config.ts on purpose. These tests talk to a real
// Postgres over the network: they need the node environment (not jsdom), a
// generous timeout for the first connection, and — most importantly — a single
// worker. Every file in tests/rls/ shares one database, so running them in
// parallel would let one file's cleanup delete another file's fixtures.
//
// The root config's `include` deliberately does not reach tests/rls/, so
// `bun run test` stays fast and needs no database. Run these with
// `bun run test:rls`.
export default defineConfig({
  test: {
    include: ["tests/rls/**/*.test.ts"],
    // Reads the migration ledger before the first test file and refuses to run
    // against a database that is behind the checkout. `globalSetup`, not a
    // test: a stale schema makes the whole suite lie, so the right answer is
    // one sentence instead of a dozen failures blaming the policies.
    globalSetup: ["tests/rls/preflight.ts"],
    environment: "node",
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // One file at a time, one thread. See above.
    //
    // `maxWorkers`/`minWorkers`, not `poolOptions.threads.singleThread`: vitest
    // 4 removed `poolOptions` and does not error on it, it just ignores it — so
    // the old spelling reads as "one thread" while quietly running several
    // against the one database. That failure is a flake, not a red test, which
    // is the worst kind. These two are the supported replacement.
    fileParallelism: false,
    pool: "threads",
    maxWorkers: 1,
    minWorkers: 1,
  },
});
