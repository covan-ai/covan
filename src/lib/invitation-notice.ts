/**
 * What to tell somebody after they invited people.
 *
 * There are two surfaces that invite — the dialog on the Team page and the
 * three rows in the first run — and they disagreed. The dialog had already
 * learned that an invitation and an email are different events: `RESEND_API_KEY`
 * is optional, a supported self-hosted Covan sends no mail at all, and the API
 * says so by returning `emailed: false`. The first-run step had not, and told
 * everyone "Invitations sent" — so on an install with no mail configured, three
 * people were invited, nobody was told, and the person who invited them had
 * been assured otherwise.
 *
 * Sharing the sentence rather than the fix is the point. The two surfaces
 * cannot drift back apart, for the same reason `uploads.ts` is shared between
 * the Knowledge tab and the chat composer.
 *
 * The invitation is a row either way and is genuinely waiting: the incoming
 * banner and the first-run `invite-accept` step both find it by the caller's
 * verified email. So "let them know" is a real instruction with a real ending,
 * not an apology.
 */

export type InvitationOutcome = {
  /** Addresses the API accepted, in the order they were entered. */
  invited: string[];
  /**
   * How many of `invited` were actually emailed. Never more than the length of
   * that array; an install with no mail configured reports zero.
   */
  emailed: number;
  /** Addresses that were refused, each already carrying its own reason. */
  failed: string[];
};

export type InvitationNotice = {
  /** Maps to the toast of the same name. */
  tone: "success" | "warning" | "error";
  message: string;
};

const WAITING = "it will be waiting when they sign in";

/** What happened to the invitations that landed. */
function coreMessage(invited: string[], emailed: number): string {
  const n = invited.length;
  const unmailed = n - emailed;

  if (n === 1) {
    return unmailed === 0
      ? `Invitation emailed to ${invited[0]}`
      : `${invited[0]} is invited — let them know, and ${WAITING}`;
  }
  if (unmailed === 0) return `${n} invitations emailed`;
  if (unmailed === n)
    return `${n} people invited — no email went out, so let them know and ${WAITING}`;
  return `${n} people invited, but ${unmailed} without an email — let those people know`;
}

export function invitationNotice({
  invited,
  emailed,
  failed,
}: InvitationOutcome): InvitationNotice {
  if (invited.length === 0) {
    return failed.length > 0
      ? { tone: "error", message: `Couldn't invite ${failed.join(", ")}.` }
      : // Nothing entered and nothing refused. The callers treat this as "just
        // move on" rather than showing it, but a total function is easier to
        // reason about than one with a hole in it.
        { tone: "success", message: "No invitations to send." };
  }

  const core = coreMessage(invited, emailed);
  if (failed.length > 0) {
    return { tone: "warning", message: `${core}. Couldn't invite ${failed.join(", ")}.` };
  }
  return { tone: "success", message: `${core}.` };
}
