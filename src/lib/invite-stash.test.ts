import { beforeEach, describe, expect, it } from "vitest";
import { forgetInvite, inviteFromFragment, stashInvite, stashedInviteToken } from "./invite-stash";

const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  localStorage.clear();
});

describe("the invitation stash", () => {
  it("keeps a token by invitation id until it is asked for", () => {
    stashInvite("inv-1", "tok-1", 0);
    stashInvite("inv-2", "tok-2", 0);

    expect(stashedInviteToken("inv-1", 1)).toBe("tok-1");
    expect(stashedInviteToken("inv-2", 1)).toBe("tok-2");
    expect(stashedInviteToken("inv-3", 1)).toBeNull();
  });

  it("forgets a token once used", () => {
    stashInvite("inv-1", "tok-1", 0);
    forgetInvite("inv-1", 1);
    expect(stashedInviteToken("inv-1", 2)).toBeNull();
    // And leaves nothing behind once empty.
    expect(localStorage.getItem("covan.invites")).toBeNull();
  });

  it("does not outlast the invitation it unlocks by more than a day", () => {
    stashInvite("inv-1", "tok-1", 0);
    expect(stashedInviteToken("inv-1", 7 * DAY)).toBe("tok-1");
    expect(stashedInviteToken("inv-1", 8 * DAY)).toBeNull();
  });

  it("survives storage it cannot parse", () => {
    localStorage.setItem("covan.invites", "{not json");
    expect(stashedInviteToken("inv-1")).toBeNull();
    stashInvite("inv-1", "tok-1");
    expect(stashedInviteToken("inv-1")).toBe("tok-1");
  });
});

describe("inviteFromFragment", () => {
  it("reads the id and token the email's link carries", () => {
    expect(inviteFromFragment("#id=inv-1&token=abc_DEF-123")).toEqual({
      id: "inv-1",
      token: "abc_DEF-123",
    });
  });

  it("is null for a fragment that is not an invitation", () => {
    expect(inviteFromFragment("")).toBeNull();
    expect(inviteFromFragment("#id=inv-1")).toBeNull();
    expect(inviteFromFragment("#access_token=x&refresh_token=y")).toBeNull();
  });
});
