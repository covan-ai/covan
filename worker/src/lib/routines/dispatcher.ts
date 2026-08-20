// worker/src/lib/routines/dispatcher.ts
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { runRoutine as defaultRunRoutine, type ExecutorDeps, type RoutineRow } from "./executor";
import { summariseWithOpenAI } from "./summarise";
import { ownHostsFrom } from "./url-guard";

/**
 * How many routines one tick may run, bounded by the Workers **Free** plan's
 * limit of 50 subrequests per invocation.
 *
 * A tick spends 1 subrequest on the claim RPC. Each routine then spends up to
 * 12: the membership check, the source fetch (1, or 4 when it follows the
 * maximum 3 redirects), the delivery claim, the channel and agent reads, the
 * LLM call, the delivery itself, and the two bookkeeping writes. So
 * 1 + 4 x 12 = 49 fits; 5 would not. Most ticks cost far less — a 304 costs 4
 * per routine — but the cap has to hold for the worst case.
 *
 * On Workers Paid the limit is 10,000 and this can go well past 10 — there the
 * binding constraint becomes CPU time (30s) rather than subrequests.
 */
const BATCH_SIZE = 4;

export type DispatcherDeps = {
  db: any;
  runRoutine: typeof defaultRunRoutine;
};

/**
 * One tick. Asks the database which routines are due — `claim_due_routines`
 * uses `for update skip locked`, so overlapping ticks can never take the same
 * row — then runs each one.
 *
 * The batch is capped: a tick that cannot drain the backlog leaves the rest for
 * the next one five minutes later, rather than running until it is killed.
 */
function executorDeps(env: RoutineEnv, db: any): ExecutorDeps {
  // WORKER_HOST is optional — on workers.dev the guard already blocks the whole
  // domain class, so it only matters once a custom domain fronts this worker.
  const ownHosts = ownHostsFrom(env);

  // `fetch` has to be bound. The Workers runtime refuses to run global fetch
  // with a `this` that isn't the global scope, so passing the bare reference
  // down and calling it as `deps.fetchImpl(...)` throws "Illegal invocation" —
  // and only in production: Node's fetch is an ordinary function that does not
  // care, so every test with a real fetch would still pass.
  const boundFetch: typeof fetch = fetch.bind(globalThis);

  return {
    db,
    summarise: summariseWithOpenAI(env),
    fetchDeps: { fetchImpl: boundFetch, ownHosts },
    deliveryDeps: {
      fetchImpl: boundFetch,
      secretKey: env.ROUTINE_SECRET_KEY,
      resendApiKey: env.RESEND_API_KEY,
      resendFrom: env.RESEND_FROM,
    },
    now: () => new Date(),
  };
}

/**
 * Run one routine right now, outside the schedule.
 *
 * Deliberately does not go through `claim_due_routines`: the point is to run a
 * routine that is not due, so there is nothing to claim. Overlapping with a
 * cron tick is safe for the same reason a retry is — the executor reserves
 * `routine_deliveries` keys before it sends, so whichever run gets there second
 * wins nothing and delivers nothing.
 */
export async function runOneRoutine(
  env: RoutineEnv,
  routine: RoutineRow,
  overrides: Partial<DispatcherDeps> = {},
): Promise<{ status: "ok" | "skipped" | "failed"; itemsNew: number }> {
  const db = overrides.db ?? serviceClient(env);
  const runRoutine = overrides.runRoutine ?? defaultRunRoutine;
  return runRoutine(routine, executorDeps(env, db));
}

export async function runDueRoutines(
  env: RoutineEnv,
  overrides: Partial<DispatcherDeps> = {},
): Promise<{ claimed: number; ok: number; failed: number }> {
  const db = overrides.db ?? serviceClient(env);
  const runRoutine = overrides.runRoutine ?? defaultRunRoutine;

  const { data, error } = await db.rpc("claim_due_routines", { p_limit: BATCH_SIZE });
  if (error) throw new Error(`claim_due_routines failed: ${error.message}`);

  const due = (data ?? []) as RoutineRow[];
  if (due.length === 0) return { claimed: 0, ok: 0, failed: 0 };

  const deps = executorDeps(env, db);

  // One routine blowing up must not strand the others in a claimed state.
  const results = await Promise.allSettled(due.map((r) => runRoutine(r, deps)));
  const failed = results.filter(
    (r) => r.status === "rejected" || (r.status === "fulfilled" && r.value.status === "failed"),
  ).length;

  return { claimed: due.length, ok: due.length - failed, failed };
}
