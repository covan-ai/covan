import { toast } from "sonner";
import { englishT, type Translate } from "@/i18n";

/**
 * The message you send somebody after inviting them, for an install that
 * did not email them itself — no `RESEND_API_KEY` is a supported setup, and
 * the default after `docker compose up`.
 *
 * It carries the invitation link, because since migration 0090 the link IS
 * the invitation: accepting takes the token in it, and an account at the
 * invited address is no longer enough on its own (an install that
 * auto-confirms sign-ups hands that address to whoever signs up first). The
 * link exists only in the response that minted it, so this text is built
 * from that response — after creating an invitation, or after Resend.
 *
 * The address is still named in prose: the account accepting has to have it,
 * and a link forwarded to somebody signing up with another address finds an
 * invitation that is not theirs.
 *
 * Written in the inviter's language, which is the best guess there is about
 * the invitee's.
 */
export type InviteToSend = { email: string; url: string };

export function inviteText(invites: InviteToSend[], t: Translate = englishT): string {
  // One block per person, because the link and the address are per-person: a
  // single message listing everybody's is not a message you can send to any
  // of them.
  return invites.map((invite) => oneInvitation(invite, t)).join("\n\n");
}

function oneInvitation({ email, url }: InviteToSend, t: Translate): string {
  return [
    t("You've been invited to Covan — where our team builds AI agents and shares them."),
    t("Open {{url}} and sign up (or sign in) with {{email}} to accept.", { url, email }),
  ].join(" ");
}

/**
 * Copy it, and say so. Every invite surface calls this rather than wiring up a
 * clipboard, for the same reason they share `invitationNotice`: two copies of
 * a sentence are two sentences waiting to disagree.
 */
export function copyInviteText(invites: InviteToSend[], t: Translate = englishT): void {
  navigator.clipboard?.writeText(inviteText(invites, t)).then(
    () => toast.success(t("Invite text copied")),
    () => toast.error(t("Couldn't copy — your browser blocked it.")),
  );
}
