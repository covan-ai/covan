import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Does anything actually call the sweeper?
 *
 * It shipped wired to nothing. `lib/purge.ts` was written, tested and reviewed;
 * `index.ts` called it from `scheduled`; and no deployment fired that handler.
 * The Cloudflare API Worker carried no `[triggers]` — deliberately, and
 * documented, because the engine's heartbeat lives in a second Worker. The
 * second Worker runs `cron.ts`, which cannot sweep: it takes `RoutineEnv` and
 * has no bucket bound, so a purged document's bytes would outlive its row. And
 * the self-hosted entry point ran `runScheduledWork` on an interval and nothing
 * else.
 *
 * So every unit test passed, the feature demonstrated correctly by hand, and
 * the promise on the screen — "28 days left" under every row in the trash — was
 * one nothing was ever going to keep. Deleted rows and their uploaded files
 * would have accumulated forever, which against a 500 MB ceiling is the failure
 * that eventually shows up as something else entirely.
 *
 * A behavioural test cannot catch this. The gap was not in what any function
 * did; it was in whether a scheduler existed to call one. That makes it a
 * question about entry points, which is what this file reads.
 */

const SRC = `${process.cwd()}/src`;
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

/**
 * The CALL, not the identifier.
 *
 * The first version of this file asserted `toContain("runPurge")`, which the
 * import line satisfies on its own — so deleting the call and keeping the
 * import left the guard green. A wiring test that passes on unwired code is
 * worse than no wiring test, because it is also a claim that somebody checked.
 */
const CALLS_PURGE = /\brunPurge\s*\(\s*env\s*\)/;

describe("the sweeper has a caller in every deployment", () => {
  it("is run from the Worker's scheduled handler", () => {
    const index = read("index.ts");
    expect(index).toMatch(CALLS_PURGE);
    // Not chained onto the other tick: a failing routine tick must not stop the
    // sweep, and a failing sweep must not mark the tick broken.
    expect(index.match(/waitUntil\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("is run from the self-hosted interval", () => {
    const node = read("node.ts");
    expect(node).toMatch(CALLS_PURGE);
    // Its own interval rather than a call inside the routine tick: an hourly
    // sweep against a thirty-day window, versus a tick that wants to be a
    // minute.
    expect(node.match(/setInterval\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // And cleared on the way out, like the tick beside it.
    expect(node).toContain("clearInterval(purgeTick)");
  });

  it("is deliberately absent from the cron Worker", () => {
    // The one entry point that must NOT sweep, and the reason is a binding it
    // does not have. If somebody adds `runPurge` here, they have either bound a
    // document store to that Worker — in which case delete this assertion and
    // say so — or they have written a sweep that deletes rows and orphans every
    // file they named.
    expect(read("cron.ts")).not.toMatch(CALLS_PURGE);
  });
});
