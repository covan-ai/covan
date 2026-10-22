import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { needsYouEmail } from "../emails/away";
import { appUrlFrom, mailerFrom, type Mailer } from "./mailer";

/**
 * "An agent needs me and I have been away for an hour" (A16, 0133).
 *
 * `claim_needs_you_reminders` decides who is away, who wants to be told and
 * what has not been told yet, and marks each as told as it hands it over; this
 * looks up the address and sends. A deployment that cannot send mail claims
 * nothing, so nothing is marked told that was never sent.
 */

export const REMINDERS_PER_TICK = 10;

type Reminder = {
  kind: "approval" | "question";
  ref_id: string;
  user_id: string;
  workspace_name: string;
  session_id: string;
  session_title: string;
  agent_id: string;
  agent_name: string;
  summary: string | null;
};

export type ReminderDeps = { db: SupabaseClient; mail: Mailer; appUrl: string };

export async function sendNeedsYouReminders(env: RoutineEnv): Promise<{ sent: number }> {
  const mail = mailerFrom(env);
  if (!mail) return { sent: 0 };
  return sendNeedsYouRemindersWith({ db: serviceClient(env), mail, appUrl: appUrlFrom(env) });
}

export async function sendNeedsYouRemindersWith(deps: ReminderDeps): Promise<{ sent: number }> {
  const { data, error } = await deps.db.rpc("claim_needs_you_reminders", {
    p_limit: REMINDERS_PER_TICK,
  });
  if (error) {
    console.error("reminders: could not claim", error.code);
    return { sent: 0 };
  }
  let sent = 0;
  for (const r of (data ?? []) as Reminder[]) {
    try {
      const { data: found } = await deps.db.auth.admin.getUserById(r.user_id);
      const email = found?.user?.email;
      if (!email) continue;
      await deps.mail(
        needsYouEmail({
          email,
          kind: r.kind,
          agentName: r.agent_name,
          workspaceName: r.workspace_name,
          title: r.session_title,
          summary: r.summary,
          url: `${deps.appUrl}/agents/${r.agent_id}/chat?s=${r.session_id}`,
        }),
      );
      sent++;
    } catch (err) {
      // Marked told already; one lost reminder beats a second one later.
      console.error("reminders: could not send", r.kind, r.ref_id, err);
    }
  }
  return { sent };
}
