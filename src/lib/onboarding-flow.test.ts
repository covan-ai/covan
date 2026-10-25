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
  it("is four steps: the workspace, the first agent, where work arrives, its first documents", () => {
    expect(stepsFor(ctx())).toEqual(["workspace", "assistant", "connect", "first-docs"]);
  });

  // 0139: what arrived is shown only once there is a scan to show.
  it("ends on what arrived when a scan exists", () => {
    expect(stepsFor(ctx({ hasScan: true }))).toEqual([
      "workspace",
      "assistant",
      "connect",
      "first-docs",
      "arrivals",
    ]);
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
      "connect",
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

  it("connects only for an agent that exists", () => {
    expect(resolveStep("connect", ctx({ lastStep: "assistant" }))).toBe("assistant");
    expect(resolveStep("connect", ctx({ completed: true, agentId: "a1" }))).toBe("connect");
  });

  it("shows what arrived only when there is a scan", () => {
    const done = { completed: true, agentId: "a1" };
    expect(resolveStep("arrivals", ctx({ ...done, hasScan: false, lastStep: "first-docs" }))).toBe(
      "first-docs",
    );
    expect(resolveStep("arrivals", ctx({ ...done, hasScan: true }))).toBe("arrivals");
  });

  it("insists on a workspace first for an account with none", () => {
    expect(resolveStep("assistant", ctx({ hasWorkspace: false }))).toBe("workspace");
  });
});

describe("moving", () => {
  it("goes forward and back through the steps", () => {
    expect(nextStep("workspace", ctx())).toBe("assistant");
    expect(nextStep("assistant", ctx())).toBe("connect");
    expect(nextStep("connect", ctx())).toBe("first-docs");
    expect(nextStep("first-docs", ctx())).toBe("done");
    expect(nextStep("first-docs", ctx({ hasScan: true }))).toBe("arrivals");
    expect(nextStep("arrivals", ctx({ hasScan: true }))).toBe("done");
    expect(prevStep("assistant", ctx())).toBe("workspace");
  });

  it("goes back from nowhere once the agent exists", () => {
    const made = ctx({ completed: true, agentId: "a1", hasScan: true });
    expect(prevStep("connect", made)).toBeNull();
    expect(prevStep("first-docs", made)).toBeNull();
    expect(prevStep("arrivals", made)).toBeNull();
  });

  it("numbers the steps there are, and not the invitation", () => {
    expect(progressFor("assistant", ctx())).toEqual({ index: 1, count: 4 });
    expect(progressFor("connect", ctx())).toEqual({ index: 2, count: 4 });
    expect(progressFor("first-docs", ctx({ hasScan: true }))).toEqual({ index: 3, count: 5 });
    expect(progressFor("arrivals", ctx({ hasScan: true }))).toEqual({ index: 4, count: 5 });
    expect(progressFor("invite-accept", ctx())).toBeNull();
  });
});
