import { beforeEach, describe, expect, it, vi } from "vitest";

const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./api-client", () => ({
  api: { invitations: { create } },
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

import { ApiError } from "./api-client";
import { parseEmails, sendInvitations } from "./invite-send";

beforeEach(() => {
  create.mockReset();
});

describe("parseEmails", () => {
  it("splits on commas, spaces and lines, and says each address once", () => {
    expect(parseEmails("ada@acme.test, grace@acme.test\nlinus@acme.test  Ada@acme.test")).toEqual([
      "ada@acme.test",
      "grace@acme.test",
      "linus@acme.test",
    ]);
    expect(parseEmails("  ")).toEqual([]);
  });
});

describe("sendInvitations", () => {
  it("sends one at a time and keeps going past a failure", async () => {
    create
      .mockResolvedValueOnce({ email: "ada@acme.test", emailed: true })
      .mockRejectedValueOnce(new ApiError(409, "already a member"))
      .mockResolvedValueOnce({
        email: "linus@acme.test",
        emailed: false,
        inviteUrl: "https://app.test/invite?t=1",
      });

    const outcome = await sendInvitations(["ada@acme.test", "grace@acme.test", "linus@acme.test"]);

    expect(create).toHaveBeenCalledTimes(3);
    expect(create).toHaveBeenCalledWith({ email: "ada@acme.test", role: "member" });
    expect(outcome.invited).toEqual(["ada@acme.test", "linus@acme.test"]);
    expect(outcome.failed).toEqual(["grace@acme.test (already a member)"]);
    // Only the one nobody was mailed about gets a link to copy.
    expect(outcome.copyable).toEqual([
      { email: "linus@acme.test", url: "https://app.test/invite?t=1" },
    ]);
    // Two landed, one of them without an email: the notice says so.
    expect(outcome.notice.message).toMatch(/2 people invited/);
    expect(outcome.notice.message).toMatch(/1 without an email/);
  });
});
