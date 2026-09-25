import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `eval` as well as `src`. Nothing under `eval/` calls a model — the only
    // test there checks the case set's own invariants, which are all the kind
    // that fail silently at run time (a misspelled tool name replays nothing
    // and the case quietly measures something else, at full price).
    include: ["src/**/*.test.ts", "eval/**/*.test.ts"],
    environment: "node",
  },
});
