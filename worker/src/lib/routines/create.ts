import type { SupabaseClient } from "@supabase/supabase-js";
import { isValidCron, nextRunAt } from "./schedule";
import { assertFetchableUrl } from "./url-guard";
import { insertErrorStatus } from "./insert-error";
import type { mapRoutine } from "../dto";

/**
 * Making a routine, in one place, because there are now two ways to ask for
 * one.
 *
 * `POST /routines` is the first: a person fills in the form. The second is an
 * agent proposing one mid-conversation and a person approving the proposal —
 * and the whole reason that is safe is that it lands here, on the same
 * validation and the same insert, through the same caller's own RLS client.
 * Two insert sites would be two places for the delivery-channel check to
 * drift, and the drift would be invisible: both would work.
 *
 * It decides nothing about permission. `routines_insert_own` does — the
 * channel has to be the caller's, the agent has to be in the workspace, the
 * output bundle has to be in the same one — and this hands the policy's
 * refusal back as a 400 rather than re-asking the question in TypeScript.
 */

export type CreateRoutineInput = {
  agentId: string;
  workspaceId: string;
  userId: string;
  name: string;
  sourceKind: "rss" | "web" | "none" | "connection" | "workspace";
  sourceUrl?: string | null;
  connectionId?: string | null;
  instruction: string;
  deliveryChannelId: string;
  scheduleCron: string;
  timezone: string;
  triggerKind?: "schedule" | "webhook" | "both";
  outputBundleId?: string | null;
  outputRetention?: number;
  /** After how many delivered runs this routine ends itself, or null for never. */
  endsAfterRuns?: number | null;
};

export type CreateRoutineResult =
  /** The inserted row, exactly as `select("*")` returned it. */
  { ok: true; row: RoutineInsertRow } | { ok: false; status: 400 | 500; message: string };

/**
 * What `.select("*")` gives back, borrowed from the one thing that reads it.
 *
 * `mapRoutine` already names every column a routine row has, and restating
 * them here would be a second declaration to keep in step with the schema.
 * This module reads none of them — it inserts and hands the row on.
 */
export type RoutineInsertRow = Parameters<typeof mapRoutine>[0];

/**
 * The slug is decided here, not carried in from the caller.
 *
 * `executor.ts`'s `RoutineRow.source_config` types `report?: string`, but
 * nothing branches on it at run time — the workspace path dispatches on
 * `source_kind` alone and calls `deps.coverage(...)` unconditionally. So
 * today the only consumer of this value is 0075's
 * `routines_workspace_config_check`, which just needs *a* snake_case slug to
 * be present. There is exactly one report, so widening the template, the
 * client type and `createSchema` to carry a field that names it would buy
 * nothing, and the slug belongs next to the constraint that validates it
 * instead. When a second report ships, this is where its field gets added.
 *
 * `"coverage_gaps"` must match the fixtures that already assume it
 * (`tests/rls/coverage-gaps.test.ts`, `executor.test.ts`) exactly — a mismatch
 * here is invisible until a run.
 */
function sourceConfigFor(input: CreateRoutineInput): Record<string, string> {
  if (input.sourceKind === "connection" && input.connectionId) {
    return { connectionId: input.connectionId };
  }
  if (input.sourceKind === "workspace") {
    return { report: "coverage_gaps" };
  }
  if (input.sourceUrl) return { url: input.sourceUrl };
  return {};
}

export async function createRoutine(
  db: SupabaseClient,
  input: CreateRoutineInput,
  ownHosts: string[],
): Promise<CreateRoutineResult> {
  if (!isValidCron(input.scheduleCron, input.timezone)) {
    return { ok: false, status: 400, message: "unusable schedule" };
  }
  if (input.sourceKind === "rss" || input.sourceKind === "web") {
    if (!input.sourceUrl) return { ok: false, status: 400, message: "this source needs a url" };
    try {
      assertFetchableUrl(input.sourceUrl, ownHosts);
    } catch (err) {
      return {
        ok: false,
        status: 400,
        message: err instanceof Error ? err.message : "invalid url",
      };
    }
  }
  // A connection is checked by the database, not here: 0047's policy resolves
  // the id through the caller's own RLS, so a connection in another workspace
  // is refused by the same mechanism that refuses another workspace's agent.
  // This only catches the shape, so the error names the missing field instead
  // of arriving as the policy's generic refusal below.
  if (input.sourceKind === "connection" && !input.connectionId) {
    return { ok: false, status: 400, message: "this source needs a connection" };
  }

  const { data, error } = await db
    .from("routines")
    .insert({
      workspace_id: input.workspaceId,
      agent_id: input.agentId,
      user_id: input.userId,
      name: input.name,
      source_kind: input.sourceKind,
      source_config: sourceConfigFor(input),
      instruction: input.instruction,
      delivery_channel_id: input.deliveryChannelId,
      schedule_cron: input.scheduleCron,
      timezone: input.timezone,
      // Kept even for a webhook-only routine, which never runs on it: the
      // column is `not null` and six other places assume a string is there.
      // 0055 says why that was the cheaper of the two mistakes.
      trigger_kind: input.triggerKind ?? "schedule",
      output_bundle_id: input.outputBundleId ?? null,
      ...(input.outputRetention !== undefined ? { output_retention: input.outputRetention } : {}),
      ends_after_runs: input.endsAfterRuns ?? null,
      // The first run is scheduled, not immediate. Creating "every day at
      // 09:00" used to send a real message within one 5-minute tick, because
      // claim_due_routines claims anything already due and `now()` is. Use
      // the Run now button for an instant first result.
      next_run_at: nextRunAt(input.scheduleCron, input.timezone, new Date()).toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    const status = insertErrorStatus(error);
    return {
      ok: false,
      status,
      message:
        status === 400
          ? "the delivery channel, agent or output bundle is not available to you in this " +
            "workspace, or this source cannot have a webhook trigger"
          : "failed to create routine",
    };
  }
  return { ok: true, row: data as RoutineInsertRow };
}
