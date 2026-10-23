import { englishT, type Translate } from "@/i18n";
import { api, ApiError } from "./api-client";
import { invitationNotice, type InvitationNotice } from "./invitation-notice";
import type { InviteToSend } from "./invite-text";

/**
 * Sending a handful of invitations from one form, and saying what happened.
 *
 * Lifted from the first run's invite step so the team step and anything after
 * it send invitations the same way: one at a time, a failure on one address
 * not discarding the others, and the notice telling the truth about whether
 * an email went out — on an install with no mail configured it does not, and
 * the only way the link leaves the page is the copy action the notice offers.
 */

/** Addresses out of a textarea: split on commas, whitespace and newlines, deduplicated. */
export function parseEmails(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const email = raw.trim();
    if (!email) continue;
    // An address, not a word: lower-cased the same way in every language. i18n-ignore
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

export type SendOutcome = {
  invited: string[];
  failed: string[];
  /** Invitations that exist but reached nobody by mail, with the link to copy. */
  copyable: InviteToSend[];
  notice: InvitationNotice;
};

export async function sendInvitations(
  emails: string[],
  t: Translate = englishT,
  locale: string = "en",
): Promise<SendOutcome> {
  const invited: string[] = [];
  const failed: string[] = [];
  // Which ones, not just how many: these are the addresses the copy action
  // has to name, and each person needs their own link.
  const unmailed: string[] = [];
  const copyable: InviteToSend[] = [];

  for (const email of emails) {
    try {
      const invite = await api.invitations.create({ email, role: "member" });
      invited.push(invite.email);
      // Undefined means "this response does not know", which is not the same
      // as false — but no create response omits it, and counting an unknown
      // as unsent is the error that costs nothing.
      if (!invite.emailed) {
        unmailed.push(invite.email);
        if (invite.inviteUrl) copyable.push({ email: invite.email, url: invite.inviteUrl });
      }
    } catch (err) {
      failed.push(err instanceof ApiError ? `${email} (${err.message})` : email);
    }
  }

  const notice = invitationNotice(
    {
      invited,
      emailed: invited.length - unmailed.length,
      failed,
    },
    t,
    locale,
  );
  return { invited, failed, copyable, notice };
}
