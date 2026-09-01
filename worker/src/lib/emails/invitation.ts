import { emailShell } from "../email-layout";
import { escapeHtml } from "../escape-html";
import { paragraphs } from "./prose";

/**
 * The invitation email.
 *
 * Deliberately not a link that accepts anything. Acceptance runs through
 * `accept_invitation`, which matches the invitation's email against the
 * caller's verified JWT email — so the address IS the credential, and a token
 * in a URL would be a second, weaker one guarding the same door. What the
 * recipient needs to know is which address to use; that is what this says.
 *
 * Two halves, not two mails. The text below was the whole message for as long as
 * this route existed, on the reasoning that an HTML mail which renders as a
 * blank card in a client that strips styles is worse than no HTML at all. That
 * reasoning still holds and is why `text` is unchanged and still says
 * everything: the HTML is an addition Resend carries in the same request, and a
 * client that drops it falls back to prose that was never a fallback.
 */
export function invitationEmail(args: {
  workspaceName: string;
  inviterName: string;
  role: string;
  email: string;
  appUrl: string;
}) {
  const asRole = args.role === "admin" ? "an admin" : "a member";
  return {
    to: args.email,
    subject: `${args.inviterName} invited you to ${args.workspaceName} on Covan`,
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
      "To accept, sign in and the invitation will be waiting:",
      "",
      `  ${args.appUrl}`,
      "",
      "Sign in with the address this was sent to:",
      "",
      `  ${args.email}`,
      "",
      "If you do not have an account yet, sign up with that same address — it is",
      "what the invitation is matched to, so a different one will not find it.",
      "",
      "If you were not expecting this, you can ignore it. Nothing happens until",
      "you accept.",
    ].join("\n"),
    html: emailShell({
      preheader: `${args.inviterName} invited you to ${args.workspaceName} on Covan.`,
      heading: `${args.inviterName} invited you to ${args.workspaceName}`,
      bodyHtml: paragraphs(
        `You have been invited as ${asRole}.`,
        "Covan is where a team keeps its AI agents: the agents and the knowledge they read are shared, and your own conversations stay yours.",
        `Sign in with <strong>${escapeHtml(args.email)}</strong> — that address is what the invitation is matched to, so a different one will not find it. If you do not have an account yet, sign up with that same address.`,
      ),
      action: { label: "Sign in to accept", url: args.appUrl },
      footnote:
        "If you were not expecting this, you can ignore it. Nothing happens until you accept.",
    }),
  };
}
