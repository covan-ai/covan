import { describe, it, expect } from "vitest";
import {
  EMPTY_ANSWERS,
  nextStep,
  prevStep,
  progressFor,
  resolveStep,
  stepsFor,
  type FlowContext,
} from "./onboarding-flow";

function ctx(over: Partial<FlowContext> = {}): FlowContext {
  return { answers: EMPTY_ANSWERS, lastStep: null, hasIncomingInvite: false, ...over };
}

describe("stepsFor", () => {
  it("is three steps: the workspace, the first agent, its first documents", () => {
    expect(stepsFor(ctx())).toEqual(["workspace", "assistant", "first-docs"]);
  });

  it("ends on an invitation for somebody who already has a workspace", () => {
    expect(stepsFor(ctx({ hasIncomingInvite: true }))).toEqual(["invite-accept"]);
  });

  // 0115: an account that signed up with an invitation waiting has no
  // workspace. Declining still needs one, so setup follows.
  it("puts the invitation first for an invitee with no workspace", () => {
    expect(stepsFor(ctx({ hasIncomingInvite: true, hasWorkspace: false }))).toEqual([
      "invite-accept",
      "workspace",
      "assistant",
      "first-docs",
    ]);
  });

  it("asks only for a workspace once a finished run has none", () => {
    expect(stepsFor(ctx({ completed: true, hasWorkspace: false }))).toEqual(["workspace"]);
  });
});

describe("resolveStep", () => {
  it("starts on the workspace", () => {
    expect(resolveStep(undefined, ctx())).toBe("workspace");
  });

  it("resumes on the step the run stopped on", () => {
    expect(resolveStep(undefined, ctx({ lastStep: "assistant" }))).toBe("assistant");
  });

  it("never shows the documents before there is an agent to give them to", () => {
    expect(resolveStep("first-docs", ctx({ lastStep: "assistant" }))).toBe("assistant");
    expect(resolveStep("first-docs", ctx({ completed: true, agentId: "a1" }))).toBe("first-docs");
  });

  it("will not skip the agent by asking for a later step", () => {
    expect(resolveStep("first-docs", ctx({ agentId: "a1", lastStep: "workspace" }))).toBe(
      "assistant",
    );
  });

  it("insists on a workspace first for an account with none", () => {
    expect(resolveStep("assistant", ctx({ hasWorkspace: false }))).toBe("workspace");
  });
});

describe("moving", () => {
  it("goes forward and back through the three", () => {
    expect(nextStep("workspace", ctx())).toBe("assistant");
    expect(nextStep("first-docs", ctx())).toBe("done");
    expect(prevStep("assistant", ctx())).toBe("workspace");
  });

  it("goes back from nowhere once the agent exists", () => {
    expect(prevStep("first-docs", ctx({ completed: true, agentId: "a1" }))).toBeNull();
  });

  it("numbers the three and not the invitation", () => {
    expect(progressFor("assistant")).toEqual({ index: 1, count: 3 });
    expect(progressFor("invite-accept")).toBeNull();
  });
});
