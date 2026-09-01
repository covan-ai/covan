import { toast } from "sonner";

/**
 * The message you send somebody after inviting them.
 *
 * `invitation-notice.ts` next door made both invite surfaces stop claiming an
 * email had gone out when none had. It left the user holding a job with no
 * tool: "let them know" is a real instruction, but the address they need and
 * the URL they need are things you then have to work out yourself. On an
 * install with no `RESEND_API_KEY` — the default after `docker compose up` —
 * that is every invitation ever sent.
 *
 * It is a sentence, not a link, and that is the whole design. `accept_invitation`
 * matches the invitation's email against the caller's verified JWT email, and
 * `docs/team.md` says why: a token in a URL "would be a second and weaker key to
 * the same door". A pre-filled link would add no credential either, but it would
 * *read* like one — someone forwards it, the recipient signs up with a different
 * address, and a wrong-address problem arrives looking like a broken link. Naming
 * the address in prose keeps the address visibly load-bearing.
 *
 * The origin is passed in rather than read here, so the text is testable and so
 * self-hosted installs say `http://localhost:3000` without being told to.
 */
export function inviteText(emails: string[], origin: string): string {
  // One block per person, because the address is per-person: a single message
  // listing everybody's address is not a message you can send to any of them.
  return emails.map((email) => oneInvitation(email, origin)).join("\n\n");
}

function oneInvitation(email: string, origin: string): string {
  return [
    `You've been invited to Covan — a shared AI agent our team trains together.`,
    `Sign up at ${origin}/sign-up with ${email} and the invitation will be waiting.`,
  ].join(" ");
}

/**
 * Copy it, and say so. Both invite surfaces call this rather than each wiring
 * up a clipboard, for the same reason they share `invitationNotice`: two copies
 * of a sentence are two sentences waiting to disagree.
 */
export function copyInviteText(emails: string[]): void {
  const text = inviteText(emails, window.location.origin);
  navigator.clipboard?.writeText(text).then(
    () => toast.success("Invite text copied"),
    () => toast.error("Couldn't copy — your browser blocked it."),
  );
}
