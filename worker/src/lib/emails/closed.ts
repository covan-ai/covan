import { emailShell } from "../email-layout";
import { paragraphs } from "./prose";

/**
 * The receipt for a closed account.
 *
 * The only message here that is sent to somebody who no longer has an account,
 * and the reason it exists: everything else about this action disappears with
 * it. There is no row left to check, no screen to return to, and no way to sign
 * in and confirm. Under the KVKK and the GDPR the erasure is the obligation and
 * a record of it is what makes the obligation demonstrable — to the person first
 * and to an auditor second.
 *
 * It promises only what the route actually did. Workspaces that survived because
 * somebody else is still in them are not named: the person is gone from them,
 * which is the part that concerns them, and listing rooms they can no longer see
 * would be a strange last thing to send.
 */
export function accountClosedEmail(args: { email: string }) {
  return {
    to: args.email,
    subject: "Your Covan account is closed",
    text: [
      "Your Covan account has been deleted.",
      "",
      "Gone with it: your profile, your conversations, the agents and documents",
      "of any workspace nobody else was in, and the files behind them.",
      "",
      "Kept, deliberately: messages you wrote in a workspace that other people",
      "are still using. They stay so the conversation still reads, with your",
      "name detached from them.",
      "",
      "There is nothing left to sign in to, and this address can be used to",
      "start again from scratch whenever you like.",
    ].join("\n"),
    html: emailShell({
      preheader: "Your Covan account has been deleted.",
      heading: "Your account is closed",
      bodyHtml: paragraphs(
        "<strong>Gone with it:</strong> your profile, your conversations, the agents and documents of any workspace nobody else was in, and the files behind them.",
        "<strong>Kept, deliberately:</strong> messages you wrote in a workspace other people are still using. They stay so the conversation still reads, with your name detached from them.",
        "There is nothing left to sign in to, and this address can be used to start again from scratch whenever you like.",
      ),
    }),
  };
}
