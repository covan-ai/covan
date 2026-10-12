import { emailShell } from "../email-layout";
import { escapeHtml } from "../escape-html";
import { paragraphs } from "./prose";

/**
 * A workspace's credits are running low. Sent to its admins, because they are
 * the remedy — the member whose reply crossed the line usually is not.
 *
 * Sent by the hosted build, once per top-up: the open build has no credits and
 * never calls this. It lives here, beside the other mail, so the wording is
 * reviewed with them.
 *
 * Written in credits and nothing else. What a reply costs varies by more than
 * an order of magnitude between a bare question and a long grounded turn, so a
 * "replies left" figure here would be a worse lie than none.
 */
export function creditsLowEmail(args: {
  email: string;
  workspaceName: string;
  balance: number;
  appUrl: string;
}) {
  const left = Math.max(0, Math.floor(args.balance));
  const amount = `${left} ${left === 1 ? "credit" : "credits"}`;
  const subject = `${args.workspaceName} has ${amount} left on Covan`;

  return {
    to: args.email,
    subject,
    text: [
      `${args.workspaceName} has ${amount} left.`,
      "",
      "When it reaches zero, replies, routines and connected-app calls stop until",
      "credits are added. Nothing is lost in the meantime — agents, documents and",
      "conversations all stay exactly as they are.",
      "",
      "Top-ups are handled by hand for now: reply to this email, or use the form",
      "under Settings → Usage, and tell us how many you need.",
    ].join("\n"),
    html: emailShell({
      preheader: `${amount} left.`,
      heading: "Your workspace's credits are running low",
      bodyHtml: paragraphs(
        `<strong>${escapeHtml(args.workspaceName)}</strong> has <strong>${amount}</strong> left.`,
        "When it reaches zero, replies, routines and connected-app calls stop until credits are added. Nothing is lost in the meantime — agents, documents and conversations all stay exactly as they are.",
        "Top-ups are handled by hand for now: reply to this email, or use the form under Settings → Usage, and tell us how many you need.",
      ),
      action: { label: "Open Covan", url: args.appUrl },
    }),
  };
}
