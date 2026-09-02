import type { RoutineEnv } from "./../types";
import { canSyncConnections } from "./../types";
import { runDueRoutines } from "./routines/dispatcher";
import { runDueConnections } from "./connections/dispatcher";

/**
 * One scheduled tick, for both Workers that have one.
 *
 * There are two kinds of background work now — routines deliver, connections
 * sync — and one cron trigger to run them on. This is where the two are
 * sequenced, in one place, because the sequencing is the interesting part.
 *
 * **They do not both run.** A routine tick can spend up to 49 subrequests and a
 * connection sync up to 45, against the 50 a Cloudflare Free invocation gets.
 * Running them back to back would not fail cleanly: the first would work and
 * the second would die partway through, so a workspace would see its routines
 * deliver and its Drive quietly stop syncing, which is the worst of the
 * available failures because it looks like a connector bug rather than a
 * platform limit.
 *
 * So a tick does routines, and only reaches the connections if there were no
 * routines due. Routines are the latency-sensitive half — somebody asked for a
 * digest at 9am — and connections are the patient half, measured in hours. On
 * any realistic schedule the idle ticks vastly outnumber the busy ones, so a
 * connection waits for the next quiet minute rather than for a free hour.
 *
 * On Workers Paid, where the limit is 10,000, this could simply be both. It is
 * written as an either/or because the open build has to work on Free — a
 * self-hoster's first deploy is the one that has to not need a plan upgrade.
 */
export async function runScheduledWork(env: RoutineEnv): Promise<void> {
  const routines = await runDueRoutines(env);
  if (routines.claimed > 0) return;

  if (!canSyncConnections(env)) {
    // Not an error, and not silent either. This is the cron-only Worker
    // deployed without a document store, which is exactly how it shipped before
    // connections existed — it can deliver routines and cannot write documents.
    // Said once per idle tick so an operator wondering why Notion never syncs
    // finds the answer in `wrangler tail` rather than in the database.
    console.warn(
      "connections not synced: this Worker has no document storage bound (DOCS or DOCS_DIR)",
    );
    return;
  }

  await runDueConnections(env);
}
