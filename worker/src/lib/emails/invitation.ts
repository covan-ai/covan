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
 * Where it did not send them, for a long time, is anywhere useful. The button
 * read "Sign in to accept" and pointed at the bare origin — a marketing page on
 * the hosted build, a redirect to sign-in on the self-hosted one. Somebody
 * invited to a product they have never used therefore landed on a page about it,
 * holding no account and no password, having just been told to sign in. Reported
 * from outside by a person who could not get in at all.
 *
 * So the button goes to `/sign-up`, and a second, named link goes to `/sign-in`
 * for the recipient who already has an account. Two links rather than a guess:
 * this route cannot tell which of the two it is writing to, because `profiles`
 * is behind RLS scoped to the caller's own workspaces and an invitee is by
 * definition not in one yet.
 *
 * Neither URL carries the address, and that is the same rule
 * `src/lib/invite-text.ts` follows for the copy-paste version — a link that
 * fills the field in is a link that gets forwarded in place of the address,
 * after which somebody signs up as themselves and cannot see why nothing is
 * waiting. The address is in the body in bold, where it stays visibly the thing
 * that decides whether the invitation is ever found. docs/team.md argues it at
 * length.
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
  const signUpUrl = `${args.appUrl}/sign-up`;
  const signInUrl = `${args.appUrl}/sign-in`;
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
      "Create your account here, and the invitation will be waiting inside:",
      "",
      `  ${signUpUrl}`,
      "",
      "Already have a Covan account? Sign in instead:",
      "",
      `  ${signInUrl}`,
      "",
      "Either way, use the address this was sent to:",
      "",
      `  ${args.email}`,
      "",
      "That address is what the invitation is matched to, so a different one",
      "will not find it.",
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
        `Sign up with <strong>${escapeHtml(args.email)}</strong> — that address is what the invitation is matched to, so a different one will not find it. The invitation is waiting once you are in.`,
        `Already have a Covan account? <a href="${escapeHtml(signInUrl)}" style="color:#251f19">Sign in instead</a>.`,
      ),
      action: { label: "Create your account", url: signUpUrl },
      footnote:
        "If you were not expecting this, you can ignore it. Nothing happens until you accept.",
    }),
  };
}
