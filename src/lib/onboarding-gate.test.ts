import { describe, it, expect } from "vitest";
import { onboardingRedirect } from "./onboarding-gate";

describe("onboardingRedirect", () => {
  it("sends an unfinished account to the first run", () => {
    expect(onboardingRedirect({ pathname: "/app", completed: false })).toBe("/welcome");
    expect(onboardingRedirect({ pathname: "/agents/abc/chat", completed: false })).toBe("/welcome");
  });

  it("never redirects /welcome to itself", () => {
    // The layout that redirects also renders /welcome. Without this the two
    // would chase each other forever.
    expect(onboardingRedirect({ pathname: "/welcome", completed: false })).toBeNull();
  });

  it("leaves a finished account alone", () => {
    expect(onboardingRedirect({ pathname: "/app", completed: true })).toBeNull();
  });

  it("does nothing until it knows", () => {
    // `me` still loading, or failed. Locking a broken account into onboarding
    // would put it in a room with no exit.
    expect(onboardingRedirect({ pathname: "/app", completed: undefined })).toBeNull();
  });
});
