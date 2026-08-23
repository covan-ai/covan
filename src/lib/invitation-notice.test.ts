import { describe, it, expect } from "vitest";
import { invitationNotice } from "./invitation-notice";

describe("invitationNotice", () => {
  it("names the address when a single invitation was emailed", () => {
    const notice = invitationNotice({ invited: ["ada@x.com"], emailed: 1, failed: [] });
    expect(notice.tone).toBe("success");
    expect(notice.message).toBe("Invitation emailed to ada@x.com.");
  });

  it("says so when no email went out, and what to do about it", () => {
    // The install has no RESEND_API_KEY, which is a supported configuration.
    // The invitation exists; the person just has no way of hearing about it.
    const notice = invitationNotice({ invited: ["ada@x.com"], emailed: 0, failed: [] });
    expect(notice.message).toContain("let them know");
    expect(notice.message).toContain("waiting when they sign in");
    expect(notice.message).not.toContain("sent");
  });

  it("does not claim three invitations were sent when none were emailed", () => {
    // The exact bug this module exists for: the first-run step reported
    // "3 invitations sent" against a mail-less install.
    const notice = invitationNotice({
      invited: ["a@x.com", "b@x.com", "c@x.com"],
      emailed: 0,
      failed: [],
    });
    expect(notice.message).toContain("3 people invited");
    expect(notice.message).toContain("no email went out");
  });

  it("counts plainly when every invitation was emailed", () => {
    const notice = invitationNotice({
      invited: ["a@x.com", "b@x.com"],
      emailed: 2,
      failed: [],
    });
    expect(notice.message).toBe("2 invitations emailed.");
  });

  it("separates the ones that were emailed from the ones that were not", () => {
    const notice = invitationNotice({
      invited: ["a@x.com", "b@x.com", "c@x.com"],
      emailed: 2,
      failed: [],
    });
    expect(notice.message).toContain("3 people invited");
    expect(notice.message).toContain("1 without an email");
  });

  it("warns, rather than celebrating, when some addresses were refused", () => {
    const notice = invitationNotice({
      invited: ["a@x.com"],
      emailed: 1,
      failed: ["b@x.com (already invited)"],
    });
    expect(notice.tone).toBe("warning");
    expect(notice.message).toContain("Couldn't invite b@x.com (already invited)");
    expect(notice.message).toContain("a@x.com");
  });

  it("is an error when nothing got through at all", () => {
    const notice = invitationNotice({ invited: [], emailed: 0, failed: ["a@x.com", "b@x.com"] });
    expect(notice.tone).toBe("error");
    expect(notice.message).toBe("Couldn't invite a@x.com, b@x.com.");
  });

  it("has an answer for an empty submission", () => {
    expect(invitationNotice({ invited: [], emailed: 0, failed: [] }).tone).toBe("success");
  });
});
