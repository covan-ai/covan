import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { approvalRequestEmail } from "../emails/away";
import { appUrlFrom, type Mailer } from "../reports/mailer";

/**
 * Tell the person a turn runs as that it is waiting on them (0144).
 *
 * The moment it asks, rather than the hour-away reminder (0133): a request
 * made at 03:00 by a routine is not somebody who walked away from a
 * conversation, and the run does nothing until it is answered. Once sent,
 * `reminded_at` is stamped, so the reminder does not say it again an hour
 * later.
 *
 * Only to the owner. An admin who may also answer a routine's request sees it
 * in the Inbox (0146) and is not mailed: one email per request, to the person
 * whose standing the action runs with.
 *
 * Best-effort, and says whether it sent: the request waits in the Inbox
 * either way, and a mail provider's hiccup must not undo a park.
 */
export async function notifyApprovalRequest(
  env: RoutineEnv,
  db: SupabaseClient,
  mail: Mailer | null,
  request: {
    id: string;
    userId: string;
    workspaceId: string;
    agentId: string;
    routineName: string | null;
    summary: string;
    proposal: unknown;
    expiresAt: Date;
  },
): Promise<boolean> {
  if (!mail) return false;
  try {
    const { data: prefs } = await db
      .from("notification_preferences")
      .select("approval_requests")
      .eq("user_id", request.userId)
      .maybeSingle();
    // No row is every switch at its default, and this one defaults on.
    if (prefs && prefs.approval_requests === false) return false;

    const [{ data: agent }, { data: workspace }, { data: found }] = await Promise.all([
      db.from("agents").select("name").eq("id", request.agentId).maybeSingle(),
      db.from("workspaces").select("name").eq("id", request.workspaceId).maybeSingle(),
      db.auth.admin.getUserById(request.userId),
    ]);
    const email = found?.user?.email;
    if (!email) return false;

    await mail(
      approvalRequestEmail({
        email,
        agentName: String(agent?.name ?? "Your agent"),
        workspaceName: String(workspace?.name ?? "your workspace"),
        routineName: request.routineName,
        summary: request.summary,
        proposal: request.proposal,
        expiresAt: request.expiresAt,
        url: `${appUrlFrom(env as { ALLOWED_ORIGIN?: string })}/approvals/${request.id}`,
      }),
    );

    const { error } = await db
      .from("paused_turns")
      .update({ reminded_at: new Date().toISOString() })
      .eq("id", request.id);
    if (error) console.error("could not mark a request as told", request.id, error.code);
    return true;
  } catch (err) {
    console.error("could not tell the owner about a request", request.id, err);
    return false;
  }
}
