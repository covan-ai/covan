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
import { entitlementsFor, weighTokens } from "../entitlements";
import { retrieveForAgent } from "../retrieval";
import { runCoverageReport, type CoverageDeps } from "./coverage-source";
import { resolveModel } from "../models";
import { complete, totalTokens } from "../completion";

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
 * A `workspace` routine (0074) never reaches the fetch above — it has no url
 * and no connection — but spends about the same dozen a different way: the
 * membership check, `readWorkspace`'s two parallel reads (workspace row,
 * members), `readGaps`, the clustering call in its place, `readTotals` on the
 * one outcome that reaches it, the delivery claim, the channel read (no
 * agent read — its summary is rendered in code, never written by a model),
 * the delivery itself, and the two bookkeeping writes. The review that found
 * this gap counted it at about 12 against the same ceiling, so `BATCH_SIZE`
 * below did not need to change for it — this paragraph was the part missing.
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
    // The gap report (0074), end to end. `coverageDeps` is rebuilt per call
    // rather than once per tick, because it closes over `input.ownerId` —
    // `readTotals` and `readGaps` both need `p_user_id` on the wire (see the
    // function below for why) and neither has it in its own `CoverageDeps`
    // signature, which is `(workspaceId, days)` for both. `runEnv` for the
    // same reason `file` takes it: clustering is a paid call, and it goes to
    // whichever key is answering this run.
    coverage: (input, runEnv) => runCoverageReport(input, coverageDeps(db, input.ownerId, runEnv)),
    now: () => new Date(),
  };
}

/**
 * Asks the model to group a workspace's unanswered questions into topics —
 * the one model call `coverage-source.ts`'s header promises, bound to its
 * real dependencies.
 *
 * `readWorkspace` reads two ordinary tables under the service role, so it has
 * no `auth.uid()` to answer to. `readTotals` and `readGaps` are RPCs instead,
 * and that is where the two reads 0075 added differ from 0053's pair they
 * sit beside: `workspace_coverage` (0053) checks `is_workspace_admin`, which
 * asks `auth.uid()` — null for this service-role caller, always, on every
 * scheduled run — so it would refuse every call with 42501. 0075's
 * `workspace_coverage_totals` and `workspace_coverage_gaps` exist because of
 * exactly that dead end: both take `p_user_id` explicitly instead, check that
 * id is an admin, and are granted to `service_role` only. `p_user_id` here is
 * `ownerId` — `runCoverageReport` re-checks admin status itself through
 * `readWorkspace` before either RPC is ever reached, so this is not a second,
 * looser gate; it is the same one the two functions insist on asking for
 * themselves.
 *
 * Exported for `dispatcher.test.ts` alone, alongside `clusterQuestions` below
 * — both are plain functions with no state of their own, and the alternative
 * for testing them — proving the RPC names, the `p_user_id` wiring, and the
 * clustering prompt's contract with `parseClusters` only through a full
 * `runOneRoutine` pass — would mean faking the executor's membership check,
 * quota check and channel lookup just to reach code that touches none of them.
 */
export function coverageDeps(db: SupabaseClient, ownerId: string, env: RoutineEnv): CoverageDeps {
  return {
    readWorkspace: async (workspaceId, forOwnerId) => {
      const [{ data: workspace, error: workspaceError }, { data: members, error: membersError }] =
        await Promise.all([
          db.from("workspaces").select("gap_report_enabled").eq("id", workspaceId).single(),
          db.from("workspace_members").select("user_id, role").eq("workspace_id", workspaceId),
        ]);
      // postgrest-js resolves { data, error }; it does not throw — see
      // `executor.ts`'s membership lookup for the same convention stated at
      // length. Fix round 1, finding A1: a swallowed error here used to read
      // as "the report is turned off" or "the owner is no longer an admin",
      // and the routine paused on a false premise with nothing logged, forever
      // (`claim_due_routines` only selects `status = 'active'`). A thrown
      // error is a failed run instead: recorded, backed off, retried next
      // tick — what a transient read deserves.
      if (workspaceError) {
        throw new Error(`workspace read failed: ${workspaceError.message}`);
      }
      if (membersError) {
        throw new Error(`workspace members read failed: ${membersError.message}`);
      }
      return {
        gapReportEnabled: workspace?.gap_report_enabled === true,
        ownerIsAdmin: (members ?? []).some(
          (m: { user_id: string; role: string }) => m.user_id === forOwnerId && m.role === "admin",
        ),
        memberCount: (members ?? []).length,
      };
    },
    readTotals: async (workspaceId, days) => {
      const { data, error } = await db.rpc("workspace_coverage_totals", {
        p_workspace_id: workspaceId,
        p_user_id: ownerId,
        p_days: days,
      });
      // Fix round 1, finding A2. This read only ever runs on the report path,
      // after the clustering call already spent money. A swallowed error used
      // to fall through to every count reading zero, and
      // `renderCoverageReport` turns zero answers into "no answer recorded
      // what grounded it, so there is no coverage to report" — printed
      // directly above the real gap topics `readGaps` found moments earlier.
      // A thrown error is a failed run instead of a report that contradicts
      // itself.
      if (error) {
        throw new Error(`workspace_coverage_totals failed: ${error.message}`);
      }
      const row = (data ?? [])[0];
      return {
        days,
        answers: Number(row?.answers ?? 0),
        covered: Number(row?.covered ?? 0),
        fallback: Number(row?.fallback ?? 0),
        ungrounded: Number(row?.ungrounded ?? 0),
        unrecorded: Number(row?.unrecorded ?? 0),
      };
    },
    readGaps: async (workspaceId, days) => {
      const { data, error } = await db.rpc("workspace_coverage_gaps", {
        p_workspace_id: workspaceId,
        p_user_id: ownerId,
        p_days: days,
      });
      // This fix wave, finding A3 — and the brief's own miss, not this
      // function's: `readWorkspace` and `readTotals` beside it both throw,
      // each for an argument that applies here too and more. An empty read
      // used to be "the safe reading of an error", but `runCoverageReport`
      // (coverage-source.ts) turns an empty `readGaps` into `kind: "skip"`
      // with the note "every answer in this window found something close" —
      // a run recorded as having found nothing to report when it never
      // managed to read anything. A thrown error also avoids building a
      // report on a failed query, and — the reason that actually carries —
      // gets the run recorded as failed, backed off and retried next tick,
      // instead of a false all-clear with no failure count and no retry.
      if (error) {
        throw new Error(`workspace_coverage_gaps failed: ${error.message}`);
      }
      return data ?? [];
    },
    cluster: (questions) => clusterQuestions(questions, env),
  };
}

/**
 * The instruction half of the clustering call's contract. The parser half —
 * `parseClusters` in `coverage-source.ts` — accepts a bare array OR an object
 * of this exact shape, because `completion.ts`'s `extractJsonObject` (:314-324)
 * documents that neither provider this build talks to can be made to answer
 * with a bare top-level array: OpenAI's `response_format: {type:"json_object"}`
 * guarantees an object, and the Anthropic path extracts `{...}` out of
 * whatever came back. Naming `clusters` here is what makes the two halves
 * agree — asking for an array this call cannot receive would mean every
 * reply parses to nothing, forever, with no error anywhere to say so.
 */
const CLUSTER_INSTRUCTION =
  "Group the questions below into at most eight topics, by the area of work each " +
  'is about. Respond with a JSON object of the shape {"clusters": [{"label": ' +
  'string, "members": number[]}]} — one top-level object with a single key, ' +
  '"clusters", never a bare array. `members` are the zero-based indices of the ' +
  "questions in that topic. A label is two to six words naming the area — never " +
  "a question, never a quotation, and never anybody's wording. Leave a question " +
  "out rather than forcing it into a topic it does not belong to.";

/**
 * The one model call this feature ever makes.
 *
 * `gpt-4.1-mini` rather than whatever an agent's own settings say, because
 * this call has no agent behind it — grouping questions by area is shaping,
 * not thinking, the same category `titleModelFor`'s header names for a
 * session title or a persona draft. `resolveModel` rather than the bare
 * literal, so an operator's `OPENAI_MODEL` override still wins the way it
 * does everywhere else a model is picked.
 *
 * The questions ride in the user message, never the system one — third-party
 * text, written by colleagues, and `summarise.ts` makes this argument at
 * length for a watched page. It applies with more force here, since these are
 * sentences people typed expecting nobody outside their own question to read
 * them literally.
 */
export async function clusterQuestions(
  questions: string[],
  env: RoutineEnv,
): Promise<{ raw: unknown; model: string; tokens: number; weightedTokens: number }> {
  const model = resolveModel("gpt-4.1-mini", env);
  const { text, usage } = await complete(env, {
    model,
    json: true,
    messages: [
      { role: "system", content: CLUSTER_INSTRUCTION },
      { role: "user", content: questions.map((q, i) => `${i}. ${q}`).join("\n") },
    ],
  });

  // Never thrown past this point: an unparsable reply is a cluster list of
  // zero, which `enforceFloorWithCoverage` turns into a skip, not a crashed
  // run. The call was still made and still spent, which is why `tokens` below
  // is read off `usage` regardless of whether `text` parsed.
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    console.error("coverage clustering reply was not JSON", err);
  }

  // What the allowance is actually charged, as against what moved — same
  // `usage` breakdown, two different functions, the same pattern
  // `summarise.ts` uses. Fix round 1, finding B2/B3: this call's completion
  // share used to go unweighted (charged at `TOKEN_WEIGHTS.fresh`, 1x,
  // instead of `TOKEN_WEIGHTS.completion`, 5x) because nothing threaded the
  // real breakdown past `tokens` — see `weighTokens`.
  return { raw, model, tokens: totalTokens(usage), weightedTokens: weighTokens(usage) };
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
