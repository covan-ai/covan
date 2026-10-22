import { emailShell } from "../email-layout";
import { escapeHtml } from "../escape-html";
import { paragraphs } from "./prose";

/**
 * The fourteen days' notice before a workspace goes (0127), to every member.
 *
 * Nobody should learn that a workspace was deleted by finding it gone. The
 * mail names who asked, the date, and what to do about it — which is to ask
 * an admin, because cancelling is theirs — and that nothing has gone yet.
 */
export function workspaceDeletionEmail(args: {
  email: string;
  workspaceName: string;
  requestedBy: string;
  deletesOn: string;
}) {
  const when = args.deletesOn;
  return {
    to: args.email,
    subject: `${args.workspaceName} on Covan will be deleted on ${when}`,
    text: [
      `${args.requestedBy} asked for ${args.workspaceName} to be deleted.`,
      "",
      `On ${when} every agent, thread, routine and document in it will be removed,`,
      "for everybody, and it cannot be undone after that.",
      "",
      "Until then nothing has changed and everything still works. An admin can",
      "cancel the deletion from Settings › General, and anybody can export what",
      "they need before the date.",
    ].join("\n"),
    html: emailShell({
      preheader: `${args.workspaceName} will be deleted on ${when}.`,
      heading: `${args.workspaceName} will be deleted on ${when}`,
      bodyHtml: paragraphs(
        `${escapeHtml(args.requestedBy)} asked for ${escapeHtml(args.workspaceName)} to be deleted. On ${escapeHtml(when)} every agent, thread, routine and document in it will be removed, for everybody, and it cannot be undone after that.`,
        "Until then nothing has changed and everything still works. An admin can cancel the deletion from Settings › General, and anybody can export what they need before the date.",
      ),
    }),
  };
}
