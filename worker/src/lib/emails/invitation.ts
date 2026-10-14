import { emailShell } from "../email-layout";
import { escapeHtml } from "../escape-html";
import { paragraphs } from "./prose";

/**
 * The invitation email.
 *
 * The button is the invitation. It goes to `/invite#id=…&token=…`, and the
 * token in it is what `accept_invitation` asks for (0090): holding this email
 * is what proves the invitee is the invitee. Until 0090 the address was the
 * whole credential and this email deliberately carried no link that did
 * anything, because "a token in a URL would be a second, weaker key to the
 * same door". That held only where a confirmed address proves a mailbox, and
 * an install that auto-confirms sign-ups — the compose stack, by default —
 * let anybody sign up as the invitee first and take the invitation. The token
 * is the key now, and the address is the second check rather than the only
 * one.
 *
 * The link works for both kinds of recipient: `/invite` keeps the token in the
 * browser and offers sign-up or sign-in, then the invitation is waiting with
 * its Accept button inside. Nothing is accepted by opening it — a mail
 * scanner that follows links accepts nothing.
 *
 * The address is still in the body in bold, because it still has to match:
 * signing up with another one finds an invitation that is not addressed to
 * that account.
 *
 * Two halves, not two mails. `text` says everything on its own, for a client
 * that strips HTML; the HTML is an addition Resend carries in the same request.
 */
export function invitationEmail(args: {
  workspaceName: string;
  inviterName: string;
  role: string;
  email: string;
  /** `inviteUrl()` from `lib/invite-token.ts`: the link with the token in it. */
  inviteUrl: string;
}) {
  const asRole = args.role === "admin" ? "an admin" : "a member";
  return {
    to: args.email,
    // Fixed. The names below are text somebody chose, and a subject line is
    // read before anybody decides whether to trust the sender — a workspace
    // named "Your account is locked" was a phishing subject with Covan's name
    // on it. Inside, beside the address it was sent to, they are context.
    subject: "You're invited to a workspace on Covan",
    // Hard-wrapped, and every interpolated value sits on a line of its own —
    // an address or a workspace name in the middle of a sentence pushes the
    // wrap around and turns a tidy paragraph into a ragged one for exactly the
    // people whose names are longest.
    text: [
      `${args.inviterName} invited you to join ${args.workspaceName} on Covan,`,
      `as ${asRole}.`,
      "",
      "Covan is where a team keeps its AI agents: the agents and the knowledge",
      "they read are shared, and your own conversations stay yours.",
      "",
      "Open this link to accept. It works whether or not you have an account yet:",
      "",
      `  ${args.inviteUrl}`,
      "",
      "Sign up or sign in with the address this was sent to:",
      "",
      `  ${args.email}`,
      "",
      "The link is yours alone and works for seven days. If it has run out, ask",
      "for a new one.",
      "",
      "If you were not expecting this, you can ignore it. Nothing happens until",
      "you accept.",
    ].join("\n"),
    html: emailShell({
      // Shown beside the subject in most inboxes, so fixed for the same reason.
      preheader: "Somebody invited you to join their workspace on Covan.",
      heading: `${args.inviterName} invited you to ${args.workspaceName}`,
      bodyHtml: paragraphs(
        `You have been invited as ${asRole}.`,
        "Covan is where a team keeps its AI agents: the agents and the knowledge they read are shared, and your own conversations stay yours.",
        `Sign up or sign in with <strong>${escapeHtml(args.email)}</strong> — the invitation is addressed to it. The button below is yours alone and works for seven days.`,
      ),
      action: { label: "Accept the invitation", url: args.inviteUrl },
      footnote:
        "If you were not expecting this, you can ignore it. Nothing happens until you accept.",
    }),
  };
}
