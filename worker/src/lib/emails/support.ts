import { emailShell } from "../email-layout";
import { escapeHtml } from "../escape-html";
import { paragraphs } from "./prose";

/**
 * Somebody at the wall, telling us what they need.
 *
 * Everything except the message itself is assembled by the route from its own
 * reads. That is not defensiveness for its own sake: this is the one mail in the
 * system whose contents decide how somebody is treated commercially, and a
 * caller who could name their own seat count could name a hundred.
 *
 * Plainer than the rest of the set. Nobody is being welcomed or reassured — this
 * is a message arriving on a desk, and what it needs is to be read quickly.
 */
export function quotaSupportEmail(args: {
  to: string;
  from: { email: string; name: string | null };
  workspace: { id: string; name: string; memberCount: number };
  quota: { used: number; limit: number };
  hasWorkspaceKey: boolean;
  appUrl: string;
  message: string;
}) {
  const who = args.from.name ? `${args.from.name} <${args.from.email}>` : args.from.email;
  const facts = [
    `From:       ${who}`,
    `Workspace:  ${args.workspace.name} (${args.workspace.id})`,
    `Members:    ${args.workspace.memberCount}`,
    `Allowance:  ${args.quota.used.toLocaleString("en-GB")} of ${args.quota.limit.toLocaleString("en-GB")}`,
    `Own key:    ${args.hasWorkspaceKey ? "yes" : "no"}`,
    `Deployment: ${args.appUrl}`,
  ];

  return {
    to: args.to,
    subject: `Covan — ${args.workspace.name} is out of allowance`,
    text: [...facts, "", "—", "", args.message].join("\n"),
    html: emailShell({
      preheader: `${args.workspace.name}, ${args.workspace.memberCount} members`,
      heading: "Somebody hit the allowance wall",
      bodyHtml:
        `<pre style="font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap;margin:0 0 20px">${escapeHtml(facts.join("\n"))}</pre>` +
        paragraphs(escapeHtml(args.message)),
    }),
  };
}
