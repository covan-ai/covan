import type { SupabaseClient } from "@supabase/supabase-js";
import type { SyncEnv } from "../../types";
import { serviceClient } from "../supabase";
import { entitlementsFor } from "../entitlements";
import { runConnection as defaultRunConnection, type ConnectionRow, type SyncDeps } from "./sync";

/**
 * How many connections one tick may sync.
 *
 * One, and the arithmetic is in `sync.ts`: a single connection importing five
 * documents already spends around 45 of the 50 subrequests a Cloudflare Free
 * invocation gets. Two would not fit, and the failure would be a mid-run
 * exception in whichever connection happened to be second — a workspace whose
 * Notion works and whose Drive silently does not.
 *
 * On Workers Paid the limit is 10,000 and this can rise considerably; the
 * binding constraint there becomes CPU time. Left at one because the cost of
 * being conservative is latency on a six-hourly job, and the cost of being
 * wrong is a connector that works for small teams and breaks for the ones with
 * enough documents to need it.
 */
const BATCH_SIZE = 1;

export type DispatcherDeps = {
  db: SupabaseClient;
  runConnection: typeof defaultRunConnection;
};

function syncDeps(env: SyncEnv, db: SupabaseClient): SyncDeps {
  // `fetch` has to be bound. The Workers runtime refuses to run global fetch
  // with a `this` that isn't the global scope, so passing the bare reference
  // down and calling it as `deps.fetchImpl(...)` throws "Illegal invocation" —
  // and only in production: Node's fetch is an ordinary function that does not
  // care, so every test with a real fetch would still pass.
  const boundFetch: typeof fetch = fetch.bind(globalThis);

  return {
    db,
    env,
    entitlements: entitlementsFor(env),
    fetchImpl: boundFetch,
    now: () => new Date(),
  };
}

/**
 * Sync one connection right now, outside the schedule.
 *
 * Deliberately does not go through `claim_due_connections`: the point is to
 * sync something that is not due, so there is nothing to claim. Overlapping
 * with a tick is safe because the engine reconciles rather than advances — two
 * runs against the same source reach the same end state, and the second finds
 * nothing left to do.
 */
export async function runOneConnection(
  env: SyncEnv,
  connection: ConnectionRow,
  overrides: Partial<DispatcherDeps> = {},
) {
  const db = overrides.db ?? serviceClient(env);
  const run = overrides.runConnection ?? defaultRunConnection;
  return run(connection, syncDeps(env, db));
}

export async function runDueConnections(
  env: SyncEnv,
  overrides: Partial<DispatcherDeps> = {},
): Promise<{ claimed: number; ok: number; failed: number }> {
  const db = overrides.db ?? serviceClient(env);
  const run = overrides.runConnection ?? defaultRunConnection;

  const { data, error } = await db.rpc("claim_due_connections", { p_limit: BATCH_SIZE });
  if (error) throw new Error(`claim_due_connections failed: ${error.message}`);

  const due = (data ?? []) as ConnectionRow[];
  if (due.length === 0) return { claimed: 0, ok: 0, failed: 0 };

  const deps = syncDeps(env, db);

  // One connection blowing up must not strand the others in a claimed state.
  const results = await Promise.allSettled(due.map((c) => run(c, deps)));
  const failed = results.filter(
    (r) => r.status === "rejected" || (r.status === "fulfilled" && r.value.status === "failed"),
  ).length;

  return { claimed: due.length, ok: due.length - failed, failed };
}
