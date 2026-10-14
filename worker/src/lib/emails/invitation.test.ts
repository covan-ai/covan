import { describe, expect, it } from "vitest";
import { invitationEmail } from "./invitation";
import { inviteUrl } from "../invite-token";

/**
 * The invitation mail is the invitation (0090): its button carries the token
 * `accept_invitation` asks for, and holding the mail is what proves the
 * invitee is the invitee. Before that the address was the whole credential,
 * and an install that auto-confirms sign-ups let somebody else sign up as the
 * invitee first and take it.
 *
 * So what these hold: the button is the token link, it works for somebody with
 * no account as well as somebody with one, the address is still named (it
 * still has to match), and the address is never in the URL.
 */

const LINK = inviteUrl("https://covan.app", "inv-1", "tok_abc-123");

const args = {
  workspaceName: "Northwind",
  inviterName: "Ali",
  role: "member",
  email: "veli@example.com",
  inviteUrl: LINK,
};

describe("invitationEmail", () => {
  it("makes the button the link that carries the token", () => {
    const mail = invitationEmail(args);

    expect(mail.text).toContain(LINK);
    // The button itself, by href, not just the string somewhere in the page:
    // the shell's footer signs every mail with a link to the bare origin. The
    // `&` is escaped in an attribute, as it has to be.
    expect(mail.html).toContain(`href="${LINK.replace("&", "&amp;")}"`);
  });

  it("puts the token in the fragment, which no server ever receives", () => {
    expect(LINK).toBe("https://covan.app/invite#id=inv-1&token=tok_abc-123");
    expect(LINK).not.toContain("?");
  });

  it("names the address in the prose and keeps it out of the URL", () => {
    const mail = invitationEmail(args);

    // It still has to match: a token opened under another account finds an
    // invitation that is not addressed to it.
    expect(mail.text).toContain(args.email);
    expect(mail.html).toContain(`<strong>${args.email}</strong>`);
    expect(LINK).not.toContain(encodeURIComponent(args.email));
    expect(LINK).not.toContain(args.email);
  });

  it("still says everything in the plain-text half on its own", () => {
    const mail = invitationEmail(args);

    // The HTML is an addition, not the message. A client that strips it must
    // still leave a reader who knows who invited them, where, and as what.
    expect(mail.text).toContain("Ali");
    expect(mail.text).toContain("Northwind");
    expect(mail.text).toContain("a member");
    // The names are in the body, beside the address it was sent to — not in
    // the subject, which is read before anybody decides to trust the sender.
    expect(mail.subject).toBe("You're invited to a workspace on Covan");
    expect(mail.to).toBe(args.email);
  });

  it("says admin when that is the role, since it decides what they can do", () => {
    expect(invitationEmail({ ...args, role: "admin" }).text).toContain("an admin");
  });
});
