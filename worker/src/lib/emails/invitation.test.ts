import { describe, expect, it } from "vitest";
import { invitationEmail } from "./invitation";

/**
 * The invitation mail is the only thing standing between an invited person and
 * an account, and for a while it pointed them at a page that could not give
 * them one: the button said "Sign in to accept" and went to the bare origin.
 * On the hosted build that is the marketing page; the recipient has no
 * password, because they have never had an account, and nothing on that page
 * offers to make one.
 *
 * These tests hold the two halves of the fix apart, because they pull in
 * opposite directions and one is easy to "improve" into the other: the mail has
 * to name a destination that can actually create an account, and it must not
 * put the address in the URL while doing it.
 */

const args = {
  workspaceName: "Northwind",
  inviterName: "Ali",
  role: "member",
  email: "veli@example.com",
  appUrl: "https://covan.app",
};

describe("invitationEmail", () => {
  it("sends somebody with no account to a page that can make them one", () => {
    const mail = invitationEmail(args);

    expect(mail.text).toContain("https://covan.app/sign-up");
    // The button itself, by href, not just the string somewhere in the page:
    // the shell's footer signs every mail with a link to the bare origin, so
    // "the origin appears in the HTML" is true of a broken mail as well.
    expect(mail.html).toContain(`href="https://covan.app/sign-up"`);
  });

  it("offers sign-in as well, because the mail cannot tell who has an account", () => {
    const mail = invitationEmail(args);

    // `profiles` is behind RLS scoped to the caller's workspaces and an invitee
    // is not in one, so the sending route genuinely cannot look this up. Two
    // links is the honest shape.
    expect(mail.text).toContain("https://covan.app/sign-in");
    expect(mail.html).toContain("https://covan.app/sign-in");
  });

  it("keeps the address out of both URLs and in the prose", () => {
    const mail = invitationEmail(args);

    // Same rule as `src/lib/invite-text.ts`, argued in docs/team.md: a link that
    // pre-fills the address gets forwarded in place of the address, and then
    // somebody signs up as themselves and cannot see why nothing is waiting.
    expect(mail.text).not.toMatch(/sign-(up|in)\?/);
    expect(mail.html).not.toMatch(/sign-(up|in)\?/);
    expect(mail.text).not.toMatch(/[?&]email=/);
    expect(mail.html).not.toMatch(/[?&]email=/);

    expect(mail.text).toContain(args.email);
    expect(mail.html).toContain(`<strong>${args.email}</strong>`);
  });

  it("still says everything in the plain-text half on its own", () => {
    const mail = invitationEmail(args);

    // The HTML is an addition, not the message. A client that strips it must
    // still leave a reader who knows who invited them, where, and as what.
    expect(mail.text).toContain("Ali");
    expect(mail.text).toContain("Northwind");
    expect(mail.text).toContain("a member");
    expect(mail.subject).toBe("Ali invited you to Northwind on Covan");
    expect(mail.to).toBe(args.email);
  });

  it("says admin when that is the role, since it decides what they can do", () => {
    expect(invitationEmail({ ...args, role: "admin" }).text).toContain("an admin");
  });
});
