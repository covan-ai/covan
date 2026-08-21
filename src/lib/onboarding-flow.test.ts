import { describe, it, expect } from "vitest";
import {
  stepsFor,
  resolveStep,
  nextStep,
  type FlowContext,
  type OnboardingAnswers,
} from "./onboarding-flow";

const NO_ANSWERS: OnboardingAnswers = {
  role: null,
  useCase: null,
  teamSize: null,
  referralSource: null,
};

const ANSWERED: OnboardingAnswers = {
  role: "engineering",
  useCase: "code",
  teamSize: "2-10",
  referralSource: null,
};

function ctx(over: Partial<FlowContext> = {}): FlowContext {
  return { answers: ANSWERED, hosted: true, hasIncomingInvite: false, ...over };
}

describe("stepsFor", () => {
  it("asks where they heard about us only on a hosted install", () => {
    expect(stepsFor(ctx({ hosted: true }))).toContain("source");
    expect(stepsFor(ctx({ hosted: false }))).not.toContain("source");
  });

  it("skips the invite step for someone working alone", () => {
    const solo = { ...ANSWERED, teamSize: "solo" };
    expect(stepsFor(ctx({ answers: solo }))).not.toContain("invite");
    expect(stepsFor(ctx())).toContain("invite");
  });

  it("gives an invitee the survey and their invitation, nothing else", () => {
    const steps = stepsFor(ctx({ hasIncomingInvite: true }));

    // Naming and furnishing a workspace they abandon on accepting is the whole
    // thing this branch exists to avoid.
    expect(steps).not.toContain("workspace");
    expect(steps).not.toContain("agent");
    expect(steps).not.toContain("invite");
    expect(steps).toContain("invite-accept");
  });
});

describe("resolveStep", () => {
  it("starts a fresh account at the first question", () => {
    expect(resolveStep(undefined, ctx({ answers: NO_ANSWERS }))).toBe("role");
  });

  it("returns someone who left to the question they stopped on", () => {
    const partial = { ...NO_ANSWERS, role: "design" };
    expect(resolveStep(undefined, ctx({ answers: partial }))).toBe("use");
  });

  it("refuses to let an unanswered survey jump into setup", () => {
    const partial = { ...NO_ANSWERS, role: "design" };
    expect(resolveStep("agent", ctx({ answers: partial }))).toBe("use");
  });

  it("ignores a step that does not exist", () => {
    expect(resolveStep("nonsense", ctx())).toBe("workspace");
  });

  it("ignores a step this flow does not include", () => {
    const solo = { ...ANSWERED, teamSize: "solo" };
    expect(resolveStep("invite", ctx({ answers: solo }))).toBe("workspace");
  });

  it("honours a real step once the survey is answered", () => {
    expect(resolveStep("agent", ctx())).toBe("agent");
  });

  it("does not re-ask an optional question on a cold return", () => {
    // Referral was skipped, so it stays null forever. Defaulting back to it
    // would strand the flow on a card the user already declined.
    expect(resolveStep(undefined, ctx())).toBe("workspace");
  });
});

describe("nextStep", () => {
  it("walks the survey in order", () => {
    expect(nextStep("role", ctx())).toBe("use");
    expect(nextStep("use", ctx())).toBe("team");
  });

  it("goes straight to setup when there is no referral question to ask", () => {
    expect(nextStep("team", ctx({ hosted: false }))).toBe("workspace");
    expect(nextStep("team", ctx({ hosted: true }))).toBe("source");
  });

  it("skips the invite step for someone working alone", () => {
    const solo = { ...ANSWERED, teamSize: "solo" };
    expect(nextStep("agent", ctx({ answers: solo }))).toBe("done");
    expect(nextStep("agent", ctx())).toBe("invite");
  });

  it("ends after the last step", () => {
    expect(nextStep("invite", ctx())).toBe("done");
    expect(nextStep("invite-accept", ctx({ hasIncomingInvite: true }))).toBe("done");
  });
});
