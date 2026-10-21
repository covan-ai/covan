import { describe, it, expect } from "vitest";
import {
  EMPTY_ANSWERS,
  endOf,
  firstPersonaliseStep,
  nextStep,
  prevStep,
  progressFor,
  resolveStep,
  stepsFor,
  type FlowContext,
  type OnboardingAnswers,
} from "./onboarding-flow";

const NAMED: OnboardingAnswers = {
  ...EMPTY_ANSWERS,
  assistantName: "Desk",
  assistantEmoji: "🧭",
  assistantRole: "desk",
};

const SOLO: OnboardingAnswers = { ...NAMED, tools: ["gmail"], purpose: "sales", mode: "solo" };
const TEAM: OnboardingAnswers = { ...SOLO, mode: "team" };

function ctx(over: Partial<FlowContext> = {}): FlowContext {
  return { answers: EMPTY_ANSWERS, lastStep: null, hasIncomingInvite: false, ...over };
}

const INTRO = ["intro:documents", "intro:apps", "intro:schedule", "intro:team"];

describe("stepsFor", () => {
  it("shows the product, then asks, in that order", () => {
    expect(stepsFor(ctx())).toEqual([...INTRO, "assistant", "tools", "purpose", "mode"]);
  });

  it("asks about the team only once the team was chosen", () => {
    expect(stepsFor(ctx({ answers: SOLO }))).not.toContain("team");
    expect(stepsFor(ctx({ answers: TEAM }))).toEqual([
      ...INTRO,
      "assistant",
      "tools",
      "purpose",
      "mode",
      "team",
    ]);
  });

  it("puts the invitation after the intro and ends on it for somebody with a workspace", () => {
    expect(stepsFor(ctx({ hasIncomingInvite: true }))).toEqual([...INTRO, "invite-accept"]);
  });

  // 0115: an account that signed up with an invitation waiting has no
  // workspace. Declining still needs one, so setup follows.
  it("starts a workspace for an invitee who says not now", () => {
    expect(stepsFor(ctx({ hasIncomingInvite: true, hasWorkspace: false }))).toEqual([
      ...INTRO,
      "invite-accept",
      "workspace",
      "assistant",
      "tools",
      "purpose",
      "mode",
    ]);
  });

  it("asks somebody who finished before and has no workspace for a workspace alone", () => {
    expect(stepsFor(ctx({ completed: true, hasWorkspace: false }))).toEqual(["workspace"]);
    expect(
      stepsFor(ctx({ completed: true, hasWorkspace: false, hasIncomingInvite: true })),
    ).toEqual(["invite-accept", "workspace"]);
  });
});

describe("resolveStep", () => {
  it("starts on the first intro screen", () => {
    expect(resolveStep(undefined, ctx())).toBe("intro:documents");
  });

  it("resumes on the screen that was open", () => {
    expect(resolveStep(undefined, ctx({ lastStep: "intro:schedule" }))).toBe("intro:schedule");
    expect(resolveStep(undefined, ctx({ answers: NAMED, lastStep: "purpose" }))).toBe("purpose");
  });

  it("honours a requested step that is in this run", () => {
    expect(resolveStep("intro:team", ctx())).toBe("intro:team");
    expect(resolveStep("tools", ctx({ answers: NAMED }))).toBe("tools");
  });

  it("does not let the URL skip past naming the assistant", () => {
    // The finish makes the agent from the name (0119); a run that reaches the
    // end without one fails there, so the name beats any request.
    expect(resolveStep("mode", ctx())).toBe("assistant");
    expect(resolveStep("mode", ctx({ lastStep: "mode" }))).toBe("assistant");
  });

  it("ignores a last step that is no longer in the run", () => {
    expect(resolveStep(undefined, ctx({ answers: SOLO, lastStep: "team" }))).toBe("mode");
  });

  it("falls back to the first unanswered question", () => {
    expect(resolveStep(undefined, ctx({ answers: NAMED, lastStep: "nope" }))).toBe("tools");
    expect(resolveStep(undefined, ctx({ answers: { ...NAMED, tools: [] } }))).toBe("purpose");
  });

  it("does not ask for a workspace that exists, and insists on one that does not", () => {
    expect(resolveStep("workspace", ctx({ answers: NAMED }))).toBe("tools");
    expect(resolveStep("tools", ctx({ answers: NAMED, hasWorkspace: false }))).toBe("workspace");
  });

  it("treats the intro as behind somebody who has been anywhere past it", () => {
    expect(resolveStep(undefined, ctx({ lastStep: "assistant" }))).toBe("assistant");
  });
});

describe("moving", () => {
  it("steps forward to done and back to nothing", () => {
    const c = ctx({ answers: SOLO });
    expect(nextStep("intro:team", c)).toBe("assistant");
    expect(nextStep("mode", c)).toBe("done");
    expect(prevStep("intro:documents", c)).toBeNull();
    expect(prevStep("assistant", c)).toBe("intro:team");
  });

  it("advances to the team step on the very tap that chose the team", () => {
    expect(nextStep("mode", ctx({ answers: TEAM }))).toBe("team");
    expect(nextStep("team", ctx({ answers: TEAM }))).toBe("done");
  });

  it("skips the intro to the first question", () => {
    expect(firstPersonaliseStep(ctx())).toBe("assistant");
    expect(firstPersonaliseStep(ctx({ hasIncomingInvite: true }))).toBe("invite-accept");
  });
});

describe("endOf", () => {
  it("finishes by making the assistant when one was named", () => {
    expect(endOf(ctx())).toBe("finish");
    expect(endOf(ctx({ hasIncomingInvite: true, hasWorkspace: false }))).toBe("finish");
  });

  it("only records the end for an invitee who joins, or a workspace started alone", () => {
    expect(endOf(ctx({ hasIncomingInvite: true }))).toBe("complete");
    expect(endOf(ctx({ completed: true, hasWorkspace: false }))).toBe("complete");
  });
});

describe("progressFor", () => {
  it("shows three sections, with the dots of the one you are in", () => {
    const p = progressFor("intro:apps", ctx());
    expect(p.sections.map((s) => s.state)).toEqual(["current", "todo", "todo"]);
    expect(p.sections[0].dots).toEqual(["done", "current", "todo", "todo"]);
    expect(p.index).toBe(1);
    expect(p.count).toBe(8);
  });

  it("marks the intro done once past it, and never reaches Start here", () => {
    const p = progressFor("purpose", ctx({ answers: NAMED }));
    expect(p.sections.map((s) => s.state)).toEqual(["done", "current", "todo"]);
    expect(p.sections[1].dots).toEqual(["done", "done", "current", "todo"]);
    expect(p.sections[2].dots).toEqual([]);
  });
});
