// worker/src/lib/routines/dispatcher.ts
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { canFileDocuments } from "../../types";
import { serviceClient } from "../supabase";
import {
  runRoutine as defaultRunRoutine,
  type ExecutorDeps,
  type IngestTrigger,
  type RoutineRow,
} from "./executor";
import { summariseWithModel } from "./summarise";
import { runRoutineWithTools } from "./agent-run";
import { ownHostsFrom } from "./url-guard";
import { deliveryDepsFrom } from "./delivery";
import { fileRoutineOutput } from "./filing";
import { entitlementsFor } from "../entitlements";
import { retrieveForAgent } from "../retrieval";

/**
 * How many routines one tick may run, bounded by the Workers **Free** plan's
 * limit of 50 subrequests per invocation.
 *
 * A tick spends 1 subrequest on the claim RPC, and **one more** asking which
 * of the claimed routines' workspaces have a connected service at all — see
 * `workspacesWithConnections` below for why that is one read per tick rather
 * than one per routine. Each routine then spends up to 12: the membership
 * check, the source fetch (1, or 4 when it follows the maximum 3 redirects),
 * the delivery claim, the channel and agent reads, the LLM call, the delivery
 * itself, and the two bookkeeping writes. So 2 + 4 x 12 = 50 — exactly the
 * cap, with nothing left over, which is not a number to ship.
 *
 * Hence 3: 2 + 3 x 12 = 38. What that costs is throughput on Free alone, and
 * a tick that cannot drain the backlog leaves the rest for the next one five
 * minutes later. What the alternative costs is the last routine of a busy
 * tick failing at the ceiling, being recorded as a failure, backing off
 * geometrically and eventually pausing — for a reason nothing in the run log
 * would explain.
 *
 * On Workers Paid the limit is 10,000 and this can go well past 10 — there the
 * binding constraint becomes CPU time (30s) rather than subrequests. A routine
 * whose agent actually HAS tools spends far more than 12 and does not fit on
 * Free at all; `docs/routines.md` says so rather than leaving it to be
 * discovered.
 *
 * This is also why a scheduled run keeps the old eight-step budget while chat
 * moved to sixteen (`SCHEDULED_MAX_STEPS` in `lib/harness/budget.ts`). The
 * arithmetic above is already generous about a tool-using routine; letting one
 * take twice as many steps would break it three routines into a tick, and the
 * symptom would be the last routines of a busy tick failing at a ceiling with
 * nothing in their run log to explain it.
 */
const BATCH_SIZE = 3;

export type DispatcherDeps = {
  db: SupabaseClient;
  runRoutine: typeof defaultRunRoutine;
};

/**
 * One tick. Asks the database which routines are due — `claim_due_routines`
 * uses `for update skip locked`, so overlapping ticks can never take the same
 * row — then runs each one.
 *
 * The batch is capped: a tick that cannot drain the backlog leaves the rest for
 * the next tick, rather than running until it is killed.
 */
function executorDeps(
  env: RoutineEnv,
  db: SupabaseClient,
  hasConnections?: (workspaceId: string) => boolean,
): ExecutorDeps {
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
    env,
    // `summariseWithModel` still takes the env it completes with; the run
    // resolves that env once (house or workspace) and hands it in here, per
    // call, rather than baking one in at construction the way this used to.
    summarise: (input, runEnv) => summariseWithModel(runEnv)(input),
    // The same run, with the tools the workspace has connected — and `null`
    // when it has connected none, which sends the run back to the single
    // call above. The env this is built with is the house one; the run env
    // arrives per call, for the reason `summarise` takes one.
    //
    // `hasConnections` is how a tick avoids paying a lookup per routine to
    // learn the same "no" several times over. Absent on the single-routine
    // paths, where there is nothing to amortise over and the run asks.
    runWithTools: (input, runEnv) => runRoutineWithTools(env, db, hasConnections)(input, runEnv),
    // The same retrieval chat and Slack use, reached through the same module.
    // `retrieval.ts` exists precisely because a second surface needed to ask an
    // agent something and two copies would have drifted rather than failed —
    // this is the third surface, and it passes an empty history because a
    // routine has no prior turns to carry a subject in.
    //
    // `runEnv` for the same reason `summarise` takes it: embedding is a paid
    // call and goes to whichever key is answering this run.
    retrieve: async ({ agentId, query }, runEnv) => {
      const { ragBlock, embeddingTokens } = await retrieveForAgent(db, runEnv, agentId, query, []);
      return { ragBlock, embeddingTokens };
    },
    entitlements: entitlementsFor(env),
    fetchDeps: { fetchImpl: boundFetch, ownHosts },
    // Built from the env rather than inline, so the routine engine and the
    // test-send button cannot end up with different ideas of which hosts a
    // channel may point at — `ownHosts` is the one a copy would forget.
    deliveryDeps: deliveryDepsFrom(env),
    // Absent, deliberately, when this Worker has no document store bound.
    //
    // This is where the guard lives rather than inside the filing code, and the
    // difference matters: an undefined dependency is something the executor can
    // report in one sentence, while a `getDocStore()` that throws inside a run
    // is a failure, a geometric backoff and eventually a paused routine. The
    // cron Worker on Cloudflare is routinely in exactly this state — an R2
    // bucket cannot cross accounts, and `wrangler.cron.toml.example` says so —
    // so this is the ordinary path, not the edge case.
    //
    // The narrowed env goes in here and not into `ExecutorDeps`: the executor
    // keeps taking `RoutineEnv`, which is what the cron Worker is deployed
    // with, and the one thing that needs more than that is the one thing that
    // is optional.
    //
    // Both envs are spread, in that order, and neither alone would do. `env` is
    // the one `canFileDocuments` narrowed, so it is what carries the storage
    // binding into the type. `runEnv` is the one this particular run resolved,
    // so it carries whichever provider key is paying — and filing embeds, which
    // is a paid call. An owner who brought their own key pays for the filing
    // half of their run as well as the answering half.
    file: canFileDocuments(env)
      ? (input, runEnv) => fileRoutineOutput(db, { ...env, ...runEnv }, input)
      : undefined,
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
  // The one place a run has a person behind it. A webhook receiver is told, so
  // a result that arrived at an odd hour can be explained by somebody having
  // pressed the button rather than read as the schedule having drifted.
  return runRoutine(routine, { ...executorDeps(env, db), trigger: "manual" });
}

/**
 * Run one routine because something poked it.
 *
 * Separate from `runOneRoutine` because the two differ in what they may not
 * share: this one carries an event id that becomes the delivery claim, and a
 * payload that reaches the model. Folding the trigger into `runOneRoutine` as
 * an optional argument would make it possible to call the button path with one
 * by accident, and the button path has no event to be idempotent about.
 *
 * The routine row comes from `resolveIngestToken`, which read it with the
 * service role after matching the token's hash — so it is the row the token
 * names, not one the caller described.
 */
export async function runPokedRoutine(
  env: RoutineEnv,
  routine: RoutineRow,
  trigger: IngestTrigger,
  overrides: Partial<DispatcherDeps> = {},
): Promise<{ status: "ok" | "skipped" | "failed"; itemsNew: number }> {
  const db = overrides.db ?? serviceClient(env);
  const runRoutine = overrides.runRoutine ?? defaultRunRoutine;
  return runRoutine(routine, executorDeps(env, db), trigger);
}

/**
 * Which of this batch's workspaces have a connected service, in one read.
 *
 * The alternative is each run asking for itself, which is the same question
 * asked up to `BATCH_SIZE` times and answered "no" every time on a
 * deployment that has connected nothing — the ordinary case. On the cron
 * Worker a read is a subrequest and Free allows fifty, so "the same question,
 * cheaper" is not tidiness here, it is the difference between a tick that
 * finishes and one that runs out.
 *
 * Failure is answered `"none"` rather than raised: a tick that cannot read
 * this table should still run its routines the way it ran them before any of
 * this existed, which is exactly what an empty set produces.
 *
 * Filtered to `active`, the same filter `lib/harness/connections.ts` applies
 * and for a sharper reason here. A connected application's row exists from the
 * moment somebody is sent to a consent screen (0063), so a workspace can hold
 * connections that are half made — and counting one would put that workspace on
 * the expensive path, where every routine builds a tool loop, for a service
 * `capabilitiesFor` will then decline to offer. The cost of that mistake is
 * paid in subrequests against a ceiling of fifty.
 */
async function workspacesWithConnections(
  db: SupabaseClient,
  due: RoutineRow[],
): Promise<Set<string>> {
  const ids = [...new Set(due.map((r) => r.workspace_id))];
  if (ids.length === 0) return new Set();
  const { data, error } = await db
    .from("tool_connections")
    .select("workspace_id")
    .eq("status", "active")
    .in("workspace_id", ids);
  if (error) {
    console.error("could not read tool connections for this tick", error);
    return new Set();
  }
  return new Set((data ?? []).map((row: { workspace_id: string }) => row.workspace_id));
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

  const connected = await workspacesWithConnections(db, due);
  const deps = executorDeps(env, db, (workspaceId) => connected.has(workspaceId));

  // One routine blowing up must not strand the others in a claimed state.
  const results = await Promise.allSettled(due.map((r) => runRoutine(r, deps)));
  const failed = results.filter(
    (r) => r.status === "rejected" || (r.status === "fulfilled" && r.value.status === "failed"),
  ).length;

  return { claimed: due.length, ok: due.length - failed, failed };
}
