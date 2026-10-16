import { emailShell } from "../email-layout";
import { escapeHtml } from "../escape-html";
import { paragraphs } from "./prose";

/**
 * A note from the feedback dialog, on the desk of whoever runs this install.
 *
 * The row in `feedback` is the record; this is only how somebody finds out it
 * is there. Until it existed nothing read that table, so a pilot team's
 * "this broke" sat in Postgres until someone thought to query it.
 *
 * Plain, like the quota mail beside it: facts first, then what they wrote.
 */

const KIND_LABEL = { problem: "Problem", idea: "Idea", other: "Note" } as const;

export function feedbackEmail(args: {
  to: string;
  from: { email: string; name: string | null };
  workspace: { id: string; name: string } | null;
  kind: keyof typeof KIND_LABEL;
  path: string | null;
  /** Set when the note started as a thumb under an answer. */
  messageId: string | null;
  appUrl: string;
  message: string;
}) {
  const who = args.from.name ? `${args.from.name} <${args.from.email}>` : args.from.email;
  const where = args.workspace ? `${args.workspace.name} (${args.workspace.id})` : "none";
  const label = KIND_LABEL[args.kind];
  const facts = [
    `From:       ${who}`,
    `Workspace:  ${where}`,
    `Page:       ${args.path ?? "unknown"}`,
    ...(args.messageId ? [`Reply:      ${args.messageId}`] : []),
    `Deployment: ${args.appUrl}`,
  ];
  const firstLine = args.message.split("\n")[0].slice(0, 80);

  return {
    to: args.to,
    // Answering the mail answers the person, which is most of what a pilot
    // needs from this: somebody reported a problem and hears back.
    replyTo: args.from.email.includes("@") ? args.from.email : undefined,
    subject: `Covan feedback — ${label}: ${firstLine}`,
    text: [...facts, "", "—", "", args.message].join("\n"),
    html: emailShell({
      preheader: `${label} from ${args.from.name ?? args.from.email}`,
      heading: `${label} from the feedback dialog`,
      bodyHtml:
        `<pre style="font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap;margin:0 0 20px">${escapeHtml(facts.join("\n"))}</pre>` +
        paragraphs(escapeHtml(args.message)),
    }),
  };
}
