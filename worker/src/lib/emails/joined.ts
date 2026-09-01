import { emailShell } from "../email-layout";
import { escapeHtml } from "../escape-html";
import { paragraphs } from "./prose";

/**
 * "They accepted" — sent to whoever did the inviting.
 *
 * An invitation is the one thing in this product that finishes somewhere other
 * than where it started. The admin sends it and then has no way of knowing
 * whether it worked: the pending list *empties* on acceptance, so the only
 * visible trace of success is an absence, which reads exactly like the mail
 * having been ignored.
 *
 * The person is named by the address the invitation went to rather than by the
 * name on their profile. That address is the thing the inviter typed and the
 * thing they will recognise; a display name they have never seen answers a
 * question nobody asked.
 */
export function joinedEmail(args: {
  inviterEmail: string;
  joinerEmail: string;
  workspaceName: string;
  appUrl: string;
}) {
  return {
    to: args.inviterEmail,
    subject: `${args.joinerEmail} joined ${args.workspaceName}`,
    text: [
      `${args.joinerEmail} accepted your invitation and is now in`,
      `${args.workspaceName}.`,
      "",
      "They can see the workspace's agents and everything those agents read.",
      "Their own conversations are private to them, the same as yours.",
      "",
      "The team list is here:",
      "",
      `  ${args.appUrl}/team`,
    ].join("\n"),
    html: emailShell({
      preheader: `${args.joinerEmail} accepted your invitation.`,
      heading: `${args.joinerEmail} joined ${args.workspaceName}`,
      bodyHtml: paragraphs(
        `They accepted your invitation and are now in <strong>${escapeHtml(args.workspaceName)}</strong>.`,
        "They can see the workspace's agents and everything those agents read. Their own conversations are private to them, the same as yours.",
      ),
      action: { label: "See the team", url: `${args.appUrl}/team` },
    }),
  };
}
