import { describe, it, expect } from "vitest";
import { inviteText } from "./invite-text";

const LINK = "https://covan.app/invite#id=inv-1&token=abc";

describe("inviteText", () => {
  it("carries the invitation link, which is what accepting takes", () => {
    // Since migration 0090 the token in the link is the credential. Text
    // without it is an invitation nobody can accept.
    expect(inviteText([{ email: "ali@example.com", url: LINK }])).toContain(LINK);
  });

  it("names the address the account has to have as well", () => {
    // The token alone does not seat whoever holds it: `accept_invitation`
    // still matches the invited address against the account's own.
    expect(inviteText([{ email: "ali@example.com", url: LINK }])).toContain("ali@example.com");
  });

  it("gives each person their own block, with their own link", () => {
    const text = inviteText([
      { email: "ali@example.com", url: LINK },
      { email: "veli@example.com", url: "https://covan.app/invite#id=inv-2&token=def" },
    ]);
    const blocks = text.split("\n\n");

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("ali@example.com");
    expect(blocks[0]).toContain("inv-1");
    expect(blocks[0]).not.toContain("veli@example.com");
    expect(blocks[1]).toContain("veli@example.com");
    expect(blocks[1]).toContain("inv-2");
  });

  it("is empty when there is nobody to write to", () => {
    expect(inviteText([])).toBe("");
  });
});
