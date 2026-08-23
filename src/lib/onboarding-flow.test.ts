import { describe, it, expect } from "vitest";
import {
  stepsFor,
  resolveStep,
  nextStep,
  newestAgent,
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
  return {
    answers: ANSWERED,
    hosted: true,
    hasIncomingInvite: false,
    hasAgent: false,
    ...over,
  };
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

  it("asks for a document only once there is an agent to hang it on", () => {
    expect(stepsFor(ctx({ hasAgent: false }))).not.toContain("knowledge");
    expect(stepsFor(ctx({ hasAgent: true }))).toContain("knowledge");
  });

  it("asks for the document after the agent and before the team", () => {
    const steps = stepsFor(ctx({ hasAgent: true }));
    expect(steps.indexOf("knowledge")).toBeGreaterThan(steps.indexOf("agent"));
    expect(steps.indexOf("knowledge")).toBeLessThan(steps.indexOf("invite"));
  });

  it("never asks an invitee for a document", () => {
    // They are joining a workspace that already has agents and bundles. The
    // knowledge they were invited to is somebody else's already.
    expect(stepsFor(ctx({ hasIncomingInvite: true, hasAgent: true }))).not.toContain("knowledge");
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

  it("offers the document step to someone who just made an agent", () => {
    expect(nextStep("agent", ctx({ hasAgent: true }))).toBe("knowledge");
  });

  it("steps over the document question for someone who made no agent", () => {
    // "I'll do this later" on the agent step is an answer, not a detour —
    // asking for a file straight afterwards would have nowhere to put it.
    expect(nextStep("agent", ctx({ hasAgent: false }))).toBe("invite");
  });

  it("ends after the document step when there is nobody to invite", () => {
    const solo = { ...ANSWERED, teamSize: "solo" };
    expect(nextStep("knowledge", ctx({ answers: solo, hasAgent: true }))).toBe("done");
    expect(nextStep("knowledge", ctx({ hasAgent: true }))).toBe("invite");
  });

  it("ends after the last step", () => {
    expect(nextStep("invite", ctx())).toBe("done");
    expect(nextStep("invite-accept", ctx({ hasIncomingInvite: true }))).toBe("done");
  });
});

describe("newestAgent", () => {
  it("has nothing to point at in an empty workspace", () => {
    expect(newestAgent([])).toBeNull();
  });

  it("picks the most recently created one regardless of list order", () => {
    const agents = [
      { id: "old", createdAt: 100 },
      { id: "new", createdAt: 300 },
      { id: "middle", createdAt: 200 },
    ];
    expect(newestAgent(agents)?.id).toBe("new");
  });

  it("keeps the first of a tie rather than picking arbitrarily", () => {
    // Two agents created in the same millisecond is not a case worth a rule,
    // but "whichever came first" is at least a stable answer across renders.
    const agents = [
      { id: "a", createdAt: 500 },
      { id: "b", createdAt: 500 },
    ];
    expect(newestAgent(agents)?.id).toBe("a");
  });
});
