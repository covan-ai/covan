import { describe, it, expect } from "vitest";
import { maskSecret } from "./crypto";

describe("maskSecret", () => {
  it("shows a slack webhook's host and last four characters only", () => {
    expect(
      maskSecret("slack_webhook", "https://hooks.slack.com/services/EXAMPLE/EXAMPLE/EXAMPLE"),
    ).toBe("hooks.slack.com/…MPLE");
  });

  it("masks the local part of an email address", () => {
    expect(maskSecret("email", "deniz@example.com")).toBe("d…z@example.com");
  });
});
