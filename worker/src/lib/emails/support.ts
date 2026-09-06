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

/**
 * What the `Own key` line says, per state.
 *
 * The middle line carries the remedy rather than only the fact, because whoever
 * reads this inbox should not have to remember that takeover needs an OpenAI
 * key. It is the one state where the sender has already tried to fix their own
 * problem and is being refused anyway.
 */
const OWN_KEY: Record<"openai" | "anthropic-only" | "none", string> = {
  openai: "yes",
  "anthropic-only": "Anthropic only — does not take over; they need an OpenAI key",
  none: "no",
};

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
   * `limit: null` means unmetered — the same convention `QuotaSnapshot`
   * (`lib/entitlements`) uses. Coercing it to `0` here would read as an
   * account entitled to nothing, which is stricter than reality and the wrong
   * conclusion for somebody triaging this inbox.
   *
   * `"unknown"` for the pair when the snapshot itself would not answer. Unlike
   * the three reads above, this one is all-or-nothing: a snapshot resolves with
   * both figures or rejects with neither, so there is no half of it to render.
   */
  quota: { used: number; limit: number | null } | "unknown";
  /**
   * Which of three states the workspace's keys are in, rather than whether a
   * row exists.
   *
   * The middle one is why this is not a boolean. `keysForUser` refuses to take
   * over without an OpenAI key — embeddings, dictation and the default model
   * all need it — so somebody who set the optional Anthropic key and stopped
   * believes they are funding their own tokens while the wall keeps refusing
   * them. That is the person most likely to be writing this message, and
   * "Own key: yes" would send whoever reads it looking for a different problem.
   */
  workspaceKey: "openai" | "anthropic-only" | "none";
  appUrl: string;
  message: string;
}) {
  const who = args.from.name ? `${args.from.name} <${args.from.email}>` : args.from.email;
  const allowance =
    args.quota === "unknown"
      ? "unknown"
      : `${args.quota.used.toLocaleString("en-GB")} of ${
          args.quota.limit === null ? "unmetered" : args.quota.limit.toLocaleString("en-GB")
        }`;
  const facts = [
    `From:       ${who}`,
    `Workspace:  ${args.workspace.name} (${args.workspace.id})`,
    `Members:    ${args.workspace.memberCount}`,
    `Allowance:  ${allowance}`,
    `Own key:    ${OWN_KEY[args.workspaceKey]}`,
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
