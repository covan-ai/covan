import { toast } from "sonner";

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
 */
export type InviteToSend = { email: string; url: string };

export function inviteText(invites: InviteToSend[]): string {
  // One block per person, because the link and the address are per-person: a
  // single message listing everybody's is not a message you can send to any
  // of them.
  return invites.map(oneInvitation).join("\n\n");
}

function oneInvitation({ email, url }: InviteToSend): string {
  return [
    `You've been invited to Covan — a shared AI agent our team trains together.`,
    `Open ${url} and sign up (or sign in) with ${email} to accept.`,
  ].join(" ");
}

/**
 * Copy it, and say so. Every invite surface calls this rather than wiring up a
 * clipboard, for the same reason they share `invitationNotice`: two copies of
 * a sentence are two sentences waiting to disagree.
 */
export function copyInviteText(invites: InviteToSend[]): void {
  navigator.clipboard?.writeText(inviteText(invites)).then(
    () => toast.success("Invite text copied"),
    () => toast.error("Couldn't copy — your browser blocked it."),
  );
}
