import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineEnv } from "../../types";
import { approvalReplyNotTakenEmail } from "../emails/away";
import { addressOf } from "../inbound-email/address";
import {
  newTextOf,
  passesAlignedAuthentication,
  type ReceivedEmail,
} from "../inbound-email/resend";
import { appUrlFrom, mailerFrom, type Mailer } from "../reports/mailer";
import { serviceClient } from "../supabase";

/**
 * A yes or a no, by replying to the request email (0147).
 *
 * The request email's Reply-To names the request (`approvalLocalPart`), so a
 * reply arriving at `POST /email/inbound` is for exactly one request. Before
 * it answers anything, every one of these has to hold:
 *
 *  - the sender is the owner's own account address — the person the request
 *    was mailed to. Anybody else, an admin included, answers on the page;
 *  - their domain passed DMARC, strictly (`passesAlignedAuthentication`), so
 *    the From is the address that was checked, not merely one somebody typed;
 *  - they have not turned answering by reply off;
 *  - the first line they wrote, quotes cut, is one of a short list of words
 *    for yes or no (`readAnswer`). No model reads it: "yes, but only the
 *    small one" is not a yes, and gets the link back.
 *
 * Then the answer goes through `answer_approval_as`, which decides in
 * Postgres exactly as the app's button does, and the cron carries on with it.
 *
 * **As strong as the owner's mailbox, and no stronger.** A delegate, a
 * mailbox somebody took over, a rule that replies on its own — any of them
 * can say yes, and nothing here can tell. That is why it is a switch of the
 * owner's own and why the request email says so.
 */

const YES = new Set([
  "yes",
  "y",
  "ok",
  "okay",
  "approve",
  "approved",
  "evet",
  "onay",
  "onayla",
  "onaylıyorum",
  "onayliyorum",
  "tamam",
]);

const NO = new Set([
  "no",
  "n",
  "decline",
  "declined",
  "deny",
  "hayır",
  "hayir",
  "reddet",
  "reddediyorum",
  "ret",
  "red",
]);

/** Punctuation and quotes a person puts around a one-word answer. */
const AROUND = /^[\s"'“”‘’.,!?;:()\-–—]+|[\s"'“”‘’.,!?;:()\-–—]+$/g;

/**
 * The answer in a reply: its first line of the sender's own words, as one of
 * the words above, or null for anything else. Exact, on purpose.
 */
export function readAnswer(text: string): "approve" | "decline" | null {
  const first = newTextOf(text)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!first) return null;
  const bare = first.replace(AROUND, "").replace(/\s+/g, " ").normalize("NFC");
  // Lowered both ways: Turkish turns "I" into "ı", which HAYIR needs, and
  // English turns it into "i", which OKAY written in capitals needs.
  const forms = [bare.toLowerCase(), bare.toLocaleLowerCase("tr")];
  if (forms.some((form) => YES.has(form))) return "approve";
  if (forms.some((form) => NO.has(form))) return "decline";
  return null;
}

export type ReplyDeps = {
  db: SupabaseClient;
  mail: Mailer | null;
};

export type ReplyOutcome =
  | "approved"
  | "declined"
  | "already"
  | "expired"
  | "unknown"
  | "not_owner"
  | "off"
  | "unverified"
  | "unclear"
  | "failed";

export async function receiveApprovalReply(
  env: RoutineEnv,
  approvalId: string,
  email: ReceivedEmail,
  overrides: Partial<ReplyDeps> = {},
): Promise<{ status: ReplyOutcome }> {
  const db = overrides.db ?? serviceClient(env);
  const mail = overrides.mail === undefined ? mailerFrom(env) : overrides.mail;

  const { data: request, error } = await db
    .from("paused_turns")
    .select("id, user_id")
    .eq("id", approvalId)
    .maybeSingle();
  if (error) return { status: "failed" };
  if (!request) return { status: "unknown" };
  const ownerId = String(request.user_id);

  const { data: found } = await db.auth.admin.getUserById(ownerId);
  const ownerEmail = found?.user?.email?.toLowerCase();
  // Somebody else replying is told nothing: nothing is mailed to a sender
  // this request was not sent to.
  if (!ownerEmail || addressOf(email.from) !== ownerEmail) return { status: "not_owner" };

  const url = `${appUrlFrom(env as { ALLOWED_ORIGIN?: string })}/approvals/${approvalId}`;
  const tell = async (reason: Parameters<typeof approvalReplyNotTakenEmail>[0]["reason"]) => {
    if (!mail) return;
    try {
      await mail(approvalReplyNotTakenEmail({ email: ownerEmail, reason, url }));
    } catch (err) {
      console.error("could not answer a reply to a request", approvalId, err);
    }
  };

  const { data: prefs } = await db
    .from("notification_preferences")
    .select("approve_by_reply")
    .eq("user_id", ownerId)
    .maybeSingle();
  if (prefs && prefs.approve_by_reply === false) {
    await tell("off");
    return { status: "off" };
  }
  if (!passesAlignedAuthentication(email)) {
    await tell("unverified");
    return { status: "unverified" };
  }
  const answer = readAnswer(email.text);
  if (!answer) {
    await tell("unclear");
    return { status: "unclear" };
  }

  const { data: result, error: answerError } = await db.rpc("answer_approval_as", {
    p_id: approvalId,
    p_user_id: ownerId,
    p_approve: answer === "approve",
  });
  if (answerError) {
    console.error("could not answer a request by reply", approvalId, answerError.code);
    return { status: "failed" };
  }
  if (result === "already" || result === "expired") {
    await tell(result);
    return { status: result };
  }
  return { status: result === "approved" ? "approved" : "declined" };
}
