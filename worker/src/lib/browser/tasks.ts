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
 */
export async function recordBrowserTask(
  env: RoutineEnv,
  input: {
    workspaceId: string;
    agentId: string;
    userId: string;
    sessionId: string;
    providerTaskId: string;
    task: string;
  },
): Promise<string | null> {
  const { data, error } = await serviceClient(env)
    .from("browser_tasks")
    .insert({
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      user_id: input.userId,
      session_id: input.sessionId,
      provider_task_id: input.providerTaskId,
      task: input.task,
      status: "queued",
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("started a browser task but could not record it", error);
    return null;
  }
  return String(data.id);
}
