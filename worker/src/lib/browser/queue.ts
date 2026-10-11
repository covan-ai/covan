import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { BROWSER_TASK_TOKENS, entitlementsFor } from "../entitlements";
import { wasBilled } from "../harness/spend";
import { serviceClient } from "../supabase";
import { hasBrowserKey } from "./client";
import { deliverBrowserTask } from "./deliver";
import type { BrowserTaskRow, FinishedTask } from "./poller";
import { beginConversationRun, finishRunStart, type RunBrowser } from "./start";
import { heldTakeover } from "./takeover";
import { cancelRun } from "./v4";

/**
 * A conversation's browser tasks, one after another (0080).
 *
 * The browser does one thing at a time. Until this existed a `browse` that
 * found it busy was refused, and on 2026-10-11 an agent asked to look at three
 * sites started one, was refused twice, and told the person all three were
 * running. Now the second and third wait their turn as `waiting` rows, and
 * each starts when the one in front of it is done.
 *
 * **Who starts them.** The settle of the task in front (`settle.ts`, both
 * clocks), and a cron stage for everything a settle cannot: a line held by a
 * take-over or a sign-in that has since let go, a start that has to be tried
 * again. The claim (`claim_next_browser_tasks`) is what lets both fire at once
 * and still start each task once, in order, one per browser.
 *
 * **What a waiting task costs.** Nothing until it starts. `browse` checks the
 * allowance when it queues one, and the charge is made here, when the provider
 * has taken the run — the same moment `browse` charges its own. A task that
 * never starts (cancelled, expired, given up) is never charged, except where
 * the provider took a request and failed it, which `browse` charges too (R12).
 *
 * **Nothing here throws.** It runs after a settle that has already delivered
 * an answer, and inside a cron tick; every failure is logged and left for the
 * next tick.
 */

/**
 * The `stop_reason` of every task that ended without ever starting: taken out
 * of the line, its browser closed, given up on, or waited too long. One value,
 * so a reader looking for "the task the browser last ran" can leave them all
 * out without reading `provider_task_id`, which no client role may (0073).
 * The reason itself is in `error`.
 */
export const NOT_STARTED = "not_started";

/** How many tasks may wait behind the one running. A longer line is a plan, not a queue. */
export const QUEUE_MAX = 3;

/**
 * How many times a start is tried before the task is given up. A busy
 * provider, the person's own browser open (R44): each try keeps the lease,
 * which is the back-off, so six is about twelve minutes of trying.
 */
export const MAX_START_ATTEMPTS = 6;

/** A task that has waited this long is not what the person is waiting for any more. */
export const WAITING_TOO_LONG_MS = 4 * 60 * 60 * 1000;

/** The start lease, and the back-off a failed start keeps. See 0080. */
const START_LEASE = "2 minutes";

/** How long a sign-in the panel is asking for holds the line. See 0080. */
const LOGIN_HOLD = "10 minutes";

/** How many lines one cron tick advances, for the cron's subrequest budget. */
const CRON_BATCH = 2;

/**
 * Provider answers that mean "not now" rather than "no": nothing reached them
 * (0), the browser is busy with something this database does not know about
 * (409), every browser is busy (429), or they are having a bad minute (5xx).
 */
function isTransient(status: number): boolean {
  return status === 0 || status === 409 || status === 429 || status >= 500;
}

export type QueueDeps = {
  db: SupabaseClient;
  now: () => Date;
  begin: typeof beginConversationRun;
  finish: typeof finishRunStart;
  heldTakeover: typeof heldTakeover;
  cancelRun: typeof cancelRun;
  deliver: typeof deliverBrowserTask;
  entitlements: Pick<ReturnType<typeof entitlementsFor>, "check" | "record">;
};

function resolve(env: RoutineEnv, overrides: Partial<QueueDeps>): QueueDeps {
  return {
    db: overrides.db ?? serviceClient(env),
    now: overrides.now ?? (() => new Date()),
    begin: overrides.begin ?? beginConversationRun,
    finish: overrides.finish ?? finishRunStart,
    heldTakeover: overrides.heldTakeover ?? heldTakeover,
    cancelRun: overrides.cancelRun ?? cancelRun,
    deliver: overrides.deliver ?? deliverBrowserTask,
    entitlements: overrides.entitlements ?? entitlementsFor(env),
  };
}

/** A `browser_tasks` row as the claim returns it: the whole row. */
type WaitingRow = BrowserTaskRow & {
  login_host?: string | null;
  browser_session_id?: string | null;
};

function code(error: { code?: string } | null | undefined): string | undefined {
  return error?.code;
}

/**
 * How many tasks are waiting for this browser, or null when that cannot be
 * read. `browse` asks it to keep the line in order — a task that arrives
 * while others wait joins the end even if nothing happens to be running — and
 * to refuse past `QUEUE_MAX`.
 */
export async function waitingInLine(
  env: RoutineEnv,
  browserSessionId: string,
  overrides: Partial<QueueDeps> = {},
): Promise<number | null> {
  const { db } = resolve(env, overrides);
  const { data, error } = await db
    .from("browser_tasks")
    .select("id")
    .eq("browser_session_id", browserSessionId)
    .eq("status", "waiting")
    .limit(QUEUE_MAX + 1);
  if (error) {
    console.error("could not read a browser's line", code(error));
    return null;
  }
  return Array.isArray(data) ? data.length : 0;
}

/**
 * Put a task at the end of the browser's line. Through the service role for
 * `tasks.ts`'s reason: no client role may write `browser_tasks`. Returns the
 * row id, or null when it could not be written.
 */
export async function queueBrowserTask(
  env: RoutineEnv,
  input: {
    workspaceId: string;
    agentId: string;
    userId: string;
    sessionId: string;
    task: string;
    /** The host whose saved login it needs, looked up again when it starts. */
    site: string | null;
    browserSessionId: string;
  },
  overrides: Partial<QueueDeps> = {},
): Promise<string | null> {
  const { db } = resolve(env, overrides);
  const { data, error } = await db
    .from("browser_tasks")
    .insert({
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      user_id: input.userId,
      session_id: input.sessionId,
      task: input.task,
      status: "waiting",
      api_version: "v4",
      browser_session_id: input.browserSessionId,
      login_host: input.site,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("could not queue a browser task", code(error));
    return null;
  }
  return String(data.id);
}

/**
 * Start what is next in line: in one browser (a settle, which has just freed
 * it), or in any (`null`, the cron). Returns how many started.
 *
 * In one browser, a task given up on frees the line for the one behind it, so
 * that is tried at once rather than a tick later — up to `QUEUE_MAX` times.
 */
export async function advanceBrowserQueue(
  env: RoutineEnv,
  browserSessionId: string | null,
  overrides: Partial<QueueDeps> = {},
): Promise<number> {
  if (!hasBrowserKey(env)) return 0;
  const deps = resolve(env, overrides);
  let started = 0;
  for (let round = 0; round < (browserSessionId ? QUEUE_MAX : 1); round++) {
    const { data, error } = await deps.db.rpc("claim_next_browser_tasks", {
      p_browser_session_id: browserSessionId,
      p_limit: browserSessionId ? 1 : CRON_BATCH,
      p_lease: START_LEASE,
      p_login_hold: LOGIN_HOLD,
    });
    if (error) {
      console.error("could not claim the next browser task", code(error));
      return started;
    }
    const rows = (Array.isArray(data) ? data : []) as WaitingRow[];
    if (rows.length === 0) return started;
    let gaveUp = false;
    // One at a time: each start is several subrequests, and the cron's budget
    // is the whole invocation's.
    for (const row of rows) {
      const outcome = await startWaiting(env, row, deps);
      if (outcome === "started") started += 1;
      if (outcome === "gave_up") gaveUp = true;
    }
    if (!gaveUp) return started;
  }
  return started;
}

type StartOutcome = "started" | "backed_off" | "gave_up";

async function startWaiting(
  env: RoutineEnv,
  row: WaitingRow,
  deps: QueueDeps,
): Promise<StartOutcome> {
  try {
    // The allowance, asked again: it was asked when the task was queued, and
    // the tasks in front of it have spent since. A failed check lets the start
    // through, `affordable`'s rule.
    try {
      const verdict = await deps.entitlements.check(row.user_id);
      if (!verdict.allowed) {
        return giveUp(
          env,
          row,
          deps,
          `this account used its allowance for the period while it waited (it resets on ${verdict.resetsAt})`,
        );
      }
    } catch {
      console.warn("could not check the allowance for a waiting browser task; starting it", row.id);
    }

    // Ruling R44: the person's own browser carries the same jar, and the one
    // that stops last writes it. Not now, then — and not "no" either.
    const own = await deps.heldTakeover(env, row.user_id);
    if (own !== false) return backOff(env, row, deps);

    const browser = await readBrowser(deps.db, row.browser_session_id ?? null);
    if (browser === "gone")
      return giveUp(env, row, deps, "its browser was closed before it could start");
    if (!browser) return backOff(env, row, deps);

    const begun = await deps.begin(env, {
      userId: row.user_id,
      agentId: row.agent_id,
      task: row.task,
      site: row.login_host ?? null,
      browser,
    });
    if (begun.kind === "error") {
      if (isTransient(begun.status)) return backOff(env, row, deps);
      // Taken and failed by the provider: charged, as `browse` charges it (R12).
      if (wasBilled(begun.status)) await charge(row, deps);
      // A status line, never the provider's body: `createRun` redacts it.
      return giveUp(env, row, deps, `the browser could not start it (${begun.message})`);
    }

    const runId = begun.value.run.id;
    // Waiting to queued, only if it is still waiting: a task removed or
    // cancelled while its run was being created is not marked started, and
    // its run is cancelled instead of left running for nobody.
    const { data: moved, error } = await deps.db
      .from("browser_tasks")
      .update({
        status: "queued",
        provider_task_id: runId,
        provider_run_id: runId,
        credential_id: begun.value.credentialId,
        claimed_at: null,
        poll_count: 0,
        next_poll_at: deps.now().toISOString(),
      })
      .eq("id", row.id)
      .eq("status", "waiting")
      .select("id")
      .maybeSingle();
    if (error || !moved) {
      if (error)
        console.error("could not record a waiting browser task's start", row.id, code(error));
      const cancelled = await deps.cancelRun(env, runId);
      if (cancelled.kind === "error") {
        console.error("could not cancel a run nothing records", row.id, cancelled.status);
      }
      return "backed_off";
    }

    await deps.finish(env, browser, begun.value);
    await charge(row, deps);
    return "started";
  } catch (err) {
    console.error("could not start a waiting browser task", row.id, err);
    return "backed_off";
  }
}

/**
 * The browser the task waits for, or `"gone"` when its row no longer exists,
 * or null when it cannot be read or is in somebody's hands right now.
 */
async function readBrowser(
  db: SupabaseClient,
  browserSessionId: string | null,
): Promise<RunBrowser | "gone" | null> {
  if (!browserSessionId) return "gone";
  const { data, error } = await db
    .from("browser_sessions")
    .select("id, provider_session_id, profile_id, provider_browser_id, live_state")
    .eq("id", browserSessionId)
    .maybeSingle();
  if (error) {
    console.error("could not read the browser a task waits for", code(error));
    return null;
  }
  if (!data) return "gone";
  if (data.live_state === "human") return null;
  const text = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    id: String(data.id),
    providerSessionId: text(data.provider_session_id),
    profileId: text(data.profile_id),
    providerBrowserId: text(data.provider_browser_id),
  };
}

/** Not now. The lease stays as the back-off; past `MAX_START_ATTEMPTS`, given up. */
async function backOff(env: RoutineEnv, row: WaitingRow, deps: QueueDeps): Promise<StartOutcome> {
  const attempts = (row.poll_count ?? 0) + 1;
  if (attempts >= MAX_START_ATTEMPTS) {
    return giveUp(env, row, deps, "the browser stayed busy for too long to start it");
  }
  const { error } = await deps.db
    .from("browser_tasks")
    .update({ poll_count: attempts })
    .eq("id", row.id)
    .eq("status", "waiting");
  if (error) console.error("could not count a waiting browser task's start", row.id, code(error));
  return "backed_off";
}

/**
 * The task will not start. Recorded as failed, with the reason, and said in
 * the conversation through the same delivery a finished task takes — so the
 * person is told, and the agent's task note says so.
 */
async function giveUp(
  env: RoutineEnv,
  row: WaitingRow,
  deps: QueueDeps,
  reason: string,
): Promise<StartOutcome> {
  const { data: claimed, error } = await deps.db
    .from("browser_tasks")
    .update({
      status: "failed",
      stop_reason: NOT_STARTED,
      error: reason,
      claimed_at: null,
      finished_at: deps.now().toISOString(),
    })
    .eq("id", row.id)
    .eq("status", "waiting")
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("could not give up on a waiting browser task", row.id, code(error));
    return "backed_off";
  }
  if (!claimed) return "gave_up";
  await deps.deliver(row, failed(reason), env, deps.db);
  return "gave_up";
}

function failed(reason: string): FinishedTask {
  return { status: "failed", output: null, error: reason, costUsd: null };
}

async function charge(row: WaitingRow, deps: QueueDeps): Promise<void> {
  try {
    await deps.entitlements.record(row.user_id, BROWSER_TASK_TOKENS);
  } catch (err) {
    console.error("failed to record a browser task's start", row.id, err);
  }
}

/**
 * Take every task waiting for this browser out of the line, and say so in
 * the conversation. For the browser being closed — the panel's close and
 * Settings' Stop are one route: what was waiting for it will not run, and a
 * person who closed a browser should not find it reopened by the next task in
 * line.
 *
 * Not for Forget: that refuses while a browser is in use, and an idle one's
 * waiting task then starts in a fresh browser with a fresh jar, which is what
 * forgetting asked for.
 *
 * One message per conversation, written without a model: a list of what did
 * not start, which is a fact rather than something to phrase.
 */
export async function cancelWaitingTasks(
  env: RoutineEnv,
  browserSessionId: string,
  overrides: Partial<QueueDeps> = {},
): Promise<number> {
  const deps = resolve(env, overrides);
  try {
    const { data, error } = await deps.db
      .from("browser_tasks")
      .update({
        status: "stopped",
        stop_reason: NOT_STARTED,
        error: "the browser was closed before its turn came",
        claimed_at: null,
        finished_at: deps.now().toISOString(),
      })
      .eq("browser_session_id", browserSessionId)
      .eq("status", "waiting")
      .select("id, session_id, task");
    if (error) {
      console.error("could not cancel the tasks waiting for a browser", code(error));
      return 0;
    }
    const rows = (Array.isArray(data) ? data : []) as Array<{ session_id: string; task: string }>;
    const bySession = new Map<string, string[]>();
    for (const row of rows) {
      bySession.set(row.session_id, [...(bySession.get(row.session_id) ?? []), row.task]);
    }
    for (const [sessionId, tasks] of bySession) {
      await postNotice(deps, sessionId, cancelledNotice(tasks));
    }
    return rows.length;
  } catch (err) {
    console.error("could not cancel the tasks waiting for a browser", err);
    return 0;
  }
}

export function cancelledNotice(tasks: string[]): string {
  const list = tasks.map((task) => `- ${task.replace(/\s+/g, " ").trim()}`).join("\n");
  return tasks.length === 1
    ? `The browser beside this conversation was closed, so the task waiting for it did not start:\n${list}`
    : `The browser beside this conversation was closed, so the ${tasks.length} tasks waiting ` +
        `for it did not start:\n${list}`;
}

async function postNotice(deps: QueueDeps, sessionId: string, content: string): Promise<void> {
  const { error } = await deps.db.from("messages").insert({
    session_id: sessionId,
    role: "assistant",
    content,
    sender_id: null,
    model: null,
    outcome: "answered",
  });
  if (error) {
    console.error("could not tell a conversation its browser tasks were cancelled", code(error));
    return;
  }
  await deps.db
    .from("chat_sessions")
    .update({ updated_at: deps.now().toISOString() })
    .eq("id", sessionId);
}

/**
 * Remove one waiting task, for the panel's Remove. The caller has already
 * shown, through its own client, that the task is theirs. Returns whether it
 * was still waiting.
 */
export async function cancelWaitingTask(
  env: RoutineEnv,
  taskId: string,
  overrides: Partial<QueueDeps> = {},
): Promise<boolean> {
  const deps = resolve(env, overrides);
  const { data, error } = await deps.db
    .from("browser_tasks")
    .update({
      status: "stopped",
      stop_reason: NOT_STARTED,
      error: "taken out of the line before its turn came",
      claimed_at: null,
      finished_at: deps.now().toISOString(),
    })
    .eq("id", taskId)
    .eq("status", "waiting")
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("could not remove a waiting browser task", code(error));
    return false;
  }
  return Boolean(data);
}

/**
 * The cron stage: give up on what has waited too long or lost its browser,
 * then start what is due. Before `pollDueBrowserTasks`, so a line that a
 * settle could not advance moves on the same tick.
 */
export async function startQueuedBrowserTasks(
  env: RoutineEnv,
  overrides: Partial<QueueDeps> = {},
): Promise<{ expired: number; started: number }> {
  if (!hasBrowserKey(env)) return { expired: 0, started: 0 };
  const deps = resolve(env, overrides);
  let expired = 0;
  try {
    const before = new Date(deps.now().getTime() - WAITING_TOO_LONG_MS).toISOString();
    const { data, error } = await deps.db
      .from("browser_tasks")
      .update({
        status: "stopped",
        stop_reason: NOT_STARTED,
        error: "its turn did not come in time",
        claimed_at: null,
        finished_at: deps.now().toISOString(),
      })
      .eq("status", "waiting")
      .or(`created_at.lt."${before}",browser_session_id.is.null`)
      .select("*");
    if (error) {
      console.error("could not expire waiting browser tasks", code(error));
    } else {
      const rows = (Array.isArray(data) ? data : []) as WaitingRow[];
      expired = rows.length;
      for (const row of rows) {
        await deps.deliver(
          row,
          {
            status: "stopped",
            output: null,
            error: row.browser_session_id
              ? "it waited more than four hours for the browser and was not started"
              : "its browser was closed before it could start",
            costUsd: null,
          },
          env,
          deps.db,
        );
      }
    }
  } catch (err) {
    console.error("could not expire waiting browser tasks", err);
  }
  const started = await advanceBrowserQueue(env, null, deps);
  return { expired, started };
}
