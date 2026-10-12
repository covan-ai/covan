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
  /**
   * `name` and `memberCount` are `"unknown"` rather than a made-up default
   * when the route's own read of them failed — a gap that announces itself
   * beats a plausible-looking number that happens to be wrong.
   */
  workspace: { id: string; name: string; memberCount: number | "unknown" };
  /**
   * The workspace's credits. `metered: false` is the open build or a house
   * workspace, rendered as such rather than as zero — a zero would read as a
   * workspace entitled to nothing, the wrong conclusion for whoever triages
   * this inbox.
   *
   * `"unknown"` when the snapshot itself would not answer. All-or-nothing: a
   * snapshot resolves with every figure or rejects with none.
   */
  credits:
    | { metered: false }
    | { metered: true; balance: number; granted: number; unlimited: boolean }
    | "unknown";
  appUrl: string;
  message: string;
}) {
  const who = args.from.name ? `${args.from.name} <${args.from.email}>` : args.from.email;
  const credits =
    args.credits === "unknown"
      ? "unknown"
      : !args.credits.metered
        ? "unmetered"
        : args.credits.unlimited
          ? "unlimited (house workspace)"
          : `${formatCredits(args.credits.balance)} left of ${formatCredits(args.credits.granted)} granted`;
  const facts = [
    `From:       ${who}`,
    `Workspace:  ${args.workspace.name} (${args.workspace.id})`,
    `Members:    ${args.workspace.memberCount}`,
    `Credits:    ${credits}`,
    `Deployment: ${args.appUrl}`,
  ];

  return {
    to: args.to,
    subject: `Covan — ${args.workspace.name} is asking for credits`,
    text: [...facts, "", "—", "", args.message].join("\n"),
    html: emailShell({
      preheader: `${args.workspace.name}, ${args.workspace.memberCount} members`,
      heading: "Somebody is asking for credits",
      bodyHtml:
        `<pre style="font:13px/1.6 ui-monospace,monospace;white-space:pre-wrap;margin:0 0 20px">${escapeHtml(facts.join("\n"))}</pre>` +
        paragraphs(escapeHtml(args.message)),
    }),
  };
}

function formatCredits(n: number): string {
  return n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
}
