import { describe, it, expect } from "vitest";
import { inviteText } from "./invite-text";

describe("inviteText", () => {
  it("names the address the invitation is actually keyed to", () => {
    const text = inviteText(["ali@example.com"], "https://covan.app");

    // `accept_invitation` matches this against the caller's verified JWT email.
    // If the message does not say which address to use, the recipient signs up
    // with whichever one they prefer and the invitation stays invisible.
    expect(text).toContain("ali@example.com");
    expect(text).toContain("https://covan.app/sign-up");
  });

  it("carries no link a recipient could mistake for the credential", () => {
    const text = inviteText(["ali@example.com"], "https://covan.app");

    // The URL is the front door, not a key: it must be the bare sign-up page,
    // with no token and no pre-filled address. `docs/team.md` argues a token in
    // a URL would be "a second and weaker key to the same door", and a URL that
    // carries the address invites people to forward it in place of the address.
    expect(text).not.toMatch(/sign-up\?/);
    expect(text).not.toMatch(/token|invite=|[?&]email=/i);
  });

  it("takes the origin it is given, so a self-hosted install says its own", () => {
    expect(inviteText(["ali@example.com"], "http://localhost:3000")).toContain(
      "http://localhost:3000/sign-up",
    );
  });

  it("gives each person their own block rather than one message listing everybody", () => {
    const text = inviteText(["ali@example.com", "veli@example.com"], "https://covan.app");
    const blocks = text.split("\n\n");

    expect(blocks).toHaveLength(2);
    // The first-run step invites up to three at once, and the address is
    // per-person: a block naming two addresses is a block you cannot send to
    // either of them.
    expect(blocks[0]).toContain("ali@example.com");
    expect(blocks[0]).not.toContain("veli@example.com");
    expect(blocks[1]).toContain("veli@example.com");
  });

  it("is empty when there is nobody to write to", () => {
    expect(inviteText([], "https://covan.app")).toBe("");
  });
});
