import { emailShell } from "../email-layout";
import { paragraphs } from "./prose";

/**
 * The allowance is running low.
 *
 * Written in replies rather than tokens, because nobody budgets in tokens. The
 * conversion is deliberately rough and says so: what a reply costs varies by
 * more than an order of magnitude between a bare question and a long
 * conversation grounded in uploads, so a precise-looking number here would be a
 * worse lie than an approximate one. `src/lib/quota.ts` does the same sum on
 * screen using the person's own measured average; this has no such average to
 * hand, so it rounds to something honest.
 *
 * No alarm. The allowance resets on its own, running out is not a failure, and
 * a mail that reads like an incident about a number that fixes itself would
 * teach people to ignore the next one.
 */
const ASSUMED_TOKENS_PER_REPLY = 3700;

export function quotaLowEmail(args: {
  email: string;
  used: number;
  limit: number;
  resetsAt: string;
  appUrl: string;
}) {
  const left = Math.max(0, Math.floor((args.limit - args.used) / ASSUMED_TOKENS_PER_REPLY));
  const resets = new Date(args.resetsAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
  });

  const roughly =
    left === 0
      ? "That is enough for very little else this period."
      : `That leaves roughly ${left} more ${left === 1 ? "reply" : "replies"}, depending on how much your agents are asked to read.`;

  return {
    to: args.email,
    subject: "Your Covan allowance is running low",
    text: [
      `You have used about three quarters of this period's allowance.`,
      "",
      roughly,
      "",
      `It resets on ${resets}, and nothing is lost in the meantime — your`,
      "agents, documents and conversations all stay exactly as they are.",
      "",
      "If you would rather not hear about this, the switch is in Settings under",
      "notifications.",
    ].join("\n"),
    html: emailShell({
      preheader: `About three quarters spent. Resets on ${resets}.`,
      heading: "Your allowance is running low",
      bodyHtml: paragraphs(
        "You have used about three quarters of this period's allowance.",
        roughly,
        `It resets on <strong>${resets}</strong>, and nothing is lost in the meantime — your agents, documents and conversations all stay exactly as they are.`,
        "If you would rather not hear about this, the switch is in Settings under notifications.",
      ),
      action: { label: "Open Covan", url: args.appUrl },
    }),
  };
}
