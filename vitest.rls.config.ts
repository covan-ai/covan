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
    environment: "node",
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // One file at a time, one thread. See above.
    fileParallelism: false,
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
  },
});
