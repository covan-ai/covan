import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";

/**
 * The database side of a browser task's handoff.
 *
 * **Why this is not an insert through the caller's own client, which is what
 * `browse` did on 2026-10-09 and what broke it in production.** `0073` gives
 * `browser_tasks` no write policy and no write grant for any client role, on
 * purpose: every column is the worker's account of what it did with somebody's
 * money, and a client that could insert could fabricate a row naming an
 * arbitrary `provider_task_id`. One deployment-wide `BROWSER_USE_API_KEY`
 * serves every tenant, so that id addresses *somebody's* running browser —
 * and the poller would fetch its output and deliver it into the fabricator's
 * conversation. That is the tenant boundary the column grant exists for, so
 * the answer is not to relax it.
 *
 * The first version of the tool inserted with `ctx.db` anyway and got
 * `42501 permission denied for table browser_tasks`. The task had already been
 * created at browser-use by then, so the money was spent on work whose answer
 * could never be delivered — which is exactly the failure the tool's own
 * ordering was written to make survivable, and exactly the one its unit tests
 * could not see, because a mocked `ctx.db` has no grants to refuse it.
 *
 * Same shape and same reason as `savePausedTurn` in `lib/harness/turn.ts`:
 * `paused_turns` refuses client writes for the same argument, and its writer
 * takes the service-role client rather than the caller's.
 *
 * **Nothing here decides anything.** Every id comes from `ToolContext`, which
 * the route resolved from the authenticated request before the tool ran — the
 * model cannot choose a workspace, a session or a user. So there is no
 * permission question left for RLS to answer that has not already been
 * answered upstream; this reaches past it only to write columns no client role
 * may write.
 *
 * `retryOf` arrives from one caller only — `retryBrowserTask` in
 * `lib/browser/takeover.ts` — and names the attempt this row replaces after a
 * takeover, which is how the card knows not to offer a second free attempt for
 * a task that already has a successor (0077).
 *
 * **Two shapes, because two APIs are live at once (0078).** `browse` now
 * creates v4 runs, each inside the conversation's browser session; the
 * take-over's re-run still creates a v2 task until it moves too, and v2 rows
 * already in flight are drained on the v2 API. A v4 row says so in
 * `api_version` — the column the poller branches on — and carries its run id
 * and its browser. **`provider_task_id` gets the run id as well**: the column
 * is `not null`, and every reader written before v4 reads it, so the one value
 * that addresses something real is better than an empty string that
 * addresses nothing. A v2 row is written exactly as it always was, and the
 * column's default says what it is.
 */
export type RecordedRun =
  | {
      /** The v2 task. */
      providerTaskId: string;
    }
  | {
      /** The v4 run, written to `provider_run_id` and to `provider_task_id`. */
      providerRunId: string;
      /** The `browser_sessions` row the run is driving. */
      browserSessionId: string;
    };

export async function recordBrowserTask(
  env: RoutineEnv,
  input: {
    workspaceId: string;
    agentId: string;
    userId: string;
    sessionId: string;
    task: string;
    /** The attempt this one replaces, after a takeover. See the header. */
    retryOf?: string;
    /**
     * The saved login the run carried as secret bindings (ruling R32, 0079),
     * so `deliver` says "the saved login did not work" only of one it was
     * given. Absent or null for a run that carried none, which the column's
     * null already says.
     */
    credentialId?: string | null;
  } & RecordedRun,
): Promise<string | null> {
  const provider =
    "providerRunId" in input
      ? {
          provider_task_id: input.providerRunId,
          provider_run_id: input.providerRunId,
          browser_session_id: input.browserSessionId,
          api_version: "v4",
        }
      : { provider_task_id: input.providerTaskId };
  const { data, error } = await serviceClient(env)
    .from("browser_tasks")
    .insert({
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      user_id: input.userId,
      session_id: input.sessionId,
      ...provider,
      task: input.task,
      status: "queued",
      retry_of: input.retryOf ?? null,
      ...(input.credentialId ? { credential_id: input.credentialId } : {}),
    })
    .select("id")
    .single();

  if (error || !data) {
    /**
     * The code and the message, never the error object.
     *
     * PostgREST hands Postgres' `DETAIL` back as `details`, and a NOT NULL or
     * CHECK violation's detail is `Failing row contains (…)` — every column of
     * the row that failed. The row being inserted here carries
     * `provider_task_id`, which under one deployment-wide
     * `BROWSER_USE_API_KEY` is the boundary between two tenants at the
     * provider rather than a label. `lib/browser/takeover.ts` writes the same
     * rule down at length and has a test that reads its own source for it.
     */
    console.error("started a browser task but could not record it", {
      code: error?.code,
      message: error?.message,
    });
    return null;
  }
  return String(data.id);
}
