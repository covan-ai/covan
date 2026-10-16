/**
 * Somebody answered a routine's emailed report, and the routine reads the
 * answer and writes back (Tasklet's "Email Replies").
 *
 * The report's Reply-To named its run (`lib/inbound-email/address.ts`), so by
 * the time anything here runs the route has a run id it can trust was made by
 * this deployment. What it cannot yet trust is the person: anybody the report
 * was forwarded to can answer it too. So the answer counts only when it comes
 * from the address the routine delivers to — the email channel its owner
 * confirmed (0096) — and when the sender's domain vouched for it
 * (`passesAuthentication`, checked by the route). Everything else is dropped
 * without a word, because an answer to a stranger is mail to a stranger.
 *
 * WHY NO EVENT SUBSCRIPTION. A reply is not something a routine waits for: any
 * routine whose report went by email can be answered, scheduled or not, and
 * making each one an `event` routine to allow it would change what starts it.
 * So this does not pass through `events/receive.ts`, and its bounds are its
 * own: the per-run expensive tier in the route, an hourly cap on replies per
 * routine below, the channel check, and the credit check every run has.
 *
 * WHAT THE RUN READS. The report the person answered and what they wrote, with
 * the quoted copy of the report cut off (`newTextOf`). It runs down the same
 * road as any poke (`runPokedRoutine`, `source: "reply"`), and its own report
 * goes back to the same address, threaded under the reply.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { serviceClient } from "../supabase";
import { decryptSecret } from "../secret-box";
import { addressOf } from "../inbound-email/address";
import { newTextOf, type ReceivedEmail } from "../inbound-email/resend";
import type { IngestTrigger, RoutineRow } from "./executor";
import { ROUTINE_COLUMNS } from "./ingest";

/** At most this many answers start a routine in an hour. A conversation, not a flood. */
export const REPLIES_PER_HOUR = 10;

/** How much of the answered report the run is reminded of. */
const MAX_REPORT_CHARS = 4_000;
/** How much of the answer it reads. */
const MAX_REPLY_CHARS = 6_000;

export type ReplyOutcome =
  { status: "accepted"; routineId: string } | { status: "ignored"; reason: string };

export type ReplyDeps = {
  db?: SupabaseClient;
  defer: (work: Promise<unknown>) => void;
  run: (env: RoutineEnv, routine: RoutineRow, trigger: IngestTrigger) => Promise<unknown>;
  now?: () => Date;
};

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[…cut at ${max} characters]` : text;
}

/** "Re: Weekly digest", without stacking "Re: Re:". */
function answerSubject(subject: string): string {
  const base = subject.trim() || "Your routine";
  return /^re:/i.test(base) ? base : `Re: ${base}`;
}

export async function receiveReply(
  env: RoutineEnv,
  runId: string,
  email: ReceivedEmail,
  deps: ReplyDeps,
): Promise<ReplyOutcome> {
  const db = deps.db ?? serviceClient(env);
  const now = deps.now ?? (() => new Date());

  // The report that was answered.
  const { data: report, error: reportError } = await db
    .from("routine_runs")
    .select("id, routine_id, summary")
    .eq("id", runId)
    .maybeSingle();
  if (reportError) throw new Error(`could not read the answered report: ${reportError.message}`);
  if (!report) return { status: "ignored", reason: "no such report" };
  const answered = report as { id: string; routine_id: string; summary: string | null };

  const { data: routineRow, error: routineError } = await db
    .from("routines")
    .select(ROUTINE_COLUMNS)
    .eq("id", answered.routine_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (routineError) throw new Error(`could not read the routine: ${routineError.message}`);
  const routine = routineRow as (RoutineRow & { status: string }) | null;
  // A paused routine is paused for answers too: Pause means nothing runs.
  if (!routine || routine.status !== "active") return { status: "ignored", reason: "not running" };

  // Only from the address the routine delivers to, and only one it confirmed.
  const { data: channelRow } = await db
    .from("delivery_channels")
    .select("id, kind, secret_ciphertext, confirmed_at")
    .eq("id", routine.delivery_channel_id)
    .eq("user_id", routine.user_id)
    .is("disabled_at", null)
    .maybeSingle();
  const channel = channelRow as {
    kind: string;
    secret_ciphertext: string;
    confirmed_at: string | null;
  } | null;
  if (!channel || channel.kind !== "email" || !channel.confirmed_at) {
    return { status: "ignored", reason: "the routine does not deliver by email" };
  }
  const deliveredTo = addressOf(
    await decryptSecret(channel.secret_ciphertext, env.ROUTINE_SECRET_KEY),
  );
  const sender = addressOf(email.from);
  if (sender !== deliveredTo)
    return { status: "ignored", reason: "not from the routine's address" };

  const answer = newTextOf(email.text);
  if (!answer) return { status: "ignored", reason: "nothing new in the reply" };

  // The hourly cap, counted from the runs replies have already started.
  const since = new Date(now().getTime() - 60 * 60 * 1000).toISOString();
  const { data: recent } = await db
    .from("routine_runs")
    .select("id")
    .eq("routine_id", routine.id)
    .eq("triggered_by", "reply")
    .gte("started_at", since)
    .limit(REPLIES_PER_HOUR);
  if (Array.isArray(recent) && recent.length >= REPLIES_PER_HOUR) {
    return { status: "ignored", reason: "too many replies this hour" };
  }

  const previous = email.headers["references"] ?? "";
  const trigger: IngestTrigger = {
    // Resend's id for the received message: a redelivered webhook carries the
    // same one, and the claim (`reply:<id>`) makes it run once.
    eventId: `resend:${email.id}`,
    payload:
      `The report you sent:\n\n${clip(answered.summary ?? "(no report text was kept)", MAX_REPORT_CHARS)}` +
      `\n\n---\n\nTheir reply, from ${sender}:\n\n${clip(answer, MAX_REPLY_CHARS)}`,
    source: "reply",
    label: "Email · Reply",
    thread: email.messageId
      ? {
          inReplyTo: email.messageId,
          references: [previous, email.messageId].filter(Boolean).join(" "),
          subject: answerSubject(email.subject),
        }
      : undefined,
  };
  deps.defer(deps.run(env, routine, trigger));
  return { status: "accepted", routineId: routine.id };
}
