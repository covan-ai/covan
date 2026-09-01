import { emailShell } from "../email-layout";
import { paragraphs } from "./prose";

/**
 * The welcome email, sent when somebody finishes their first run.
 *
 * Not sent on confirmation, because there is no hook for it: Supabase sends the
 * confirmation mail and nothing tells this Worker when the link was clicked.
 * Finishing onboarding is the better moment anyway — by then the person has a
 * workspace and has answered what they want Covan for, so this can say what to
 * do next instead of only saying hello.
 *
 * What it does NOT do is sell anything or start a sequence. Every other message
 * this product sends is transactional — something happened, here it is — and one
 * marketing email in that set would be the one that teaches people to ignore the
 * rest.
 */
export function welcomeEmail(args: { email: string; appUrl: string }) {
  return {
    to: args.email,
    subject: "Welcome to Covan",
    text: [
      "Your workspace is ready.",
      "",
      "Covan works best once an agent has something to read. Three steps get",
      "you there:",
      "",
      "  1. Upload what your team already relies on — a handbook, a policy, a",
      "     deck. Covan reads it and cites it in answers.",
      "  2. Give an agent a persona. 'You are our senior support lead' is",
      "     enough; it will answer like one.",
      "  3. Invite the people who will ask it things. The agents and their",
      "     knowledge are shared; each person's conversations stay their own.",
      "",
      "Open Covan:",
      "",
      `  ${args.appUrl}`,
      "",
      "If an answer is ever wrong, the fix is usually a document rather than a",
      "prompt — add it, and every teammate's next answer improves too.",
    ].join("\n"),
    html: emailShell({
      preheader: "Your workspace is ready — here is how to make an agent useful.",
      heading: "Your workspace is ready",
      bodyHtml:
        paragraphs(
          "Covan works best once an agent has something to read. Three steps get you there:",
        ) +
        `<ol style="margin:0 0 16px;padding-left:20px">
          <li style="margin:0 0 8px;font-size:15px;line-height:1.55;color:#251f19"><strong>Upload what your team already relies on</strong> — a handbook, a policy, a deck. Covan reads it and cites it in answers.</li>
          <li style="margin:0 0 8px;font-size:15px;line-height:1.55;color:#251f19"><strong>Give an agent a persona.</strong> "You are our senior support lead" is enough; it will answer like one.</li>
          <li style="margin:0 0 8px;font-size:15px;line-height:1.55;color:#251f19"><strong>Invite the people who will ask it things.</strong> The agents and their knowledge are shared; each person's conversations stay their own.</li>
        </ol>` +
        paragraphs(
          "If an answer is ever wrong, the fix is usually a document rather than a prompt — add it, and every teammate's next answer improves too.",
        ),
      action: { label: "Open Covan", url: args.appUrl },
    }),
  };
}
