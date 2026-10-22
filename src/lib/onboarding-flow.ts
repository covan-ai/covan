/**
 * The first run (A14, A29), as a pure function of what is known: three steps
 * — name the workspace, set up the first agent, give it its first documents —
 * with an invitation in front of them when one is waiting.
 *
 * The agent is made when its step is left (`finish_onboarding`, 0119/0137),
 * so the documents step belongs to a run that has already finished: it is
 * reached only with the agent's id in hand, and leaving it — either way — is
 * leaving the run.
 */

export type OnboardingAnswers = {
  assistantName: string | null;
  /** The old run's; read back, never asked. */
  assistantEmoji: string | null;
  assistantRole: string | null;
  /** One of the eight marks (0137). */
  assistantAvatar?: string | null;
  /** What it should do, from the step's chips (0137). */
  assistantJobs?: string[] | null;
  tools: string[] | null;
  purpose: string | null;
  mode: "solo" | "team" | null;
};

export type AnswerPatch = Partial<{
  assistantName: string;
  assistantAvatar: string;
  assistantJobs: string[];
  lastStep: string;
}>;

export type OnboardingStep = "invite-accept" | "workspace" | "assistant" | "first-docs";

export type FlowContext = {
  answers: OnboardingAnswers;
  lastStep: string | null;
  hasIncomingInvite: boolean;
  hasWorkspace?: boolean;
  completed?: boolean;
  /** The agent the run made, once it has. */
  agentId?: string | null;
};

export const EMPTY_ANSWERS: OnboardingAnswers = {
  assistantName: null,
  assistantEmoji: null,
  assistantRole: null,
  assistantAvatar: null,
  assistantJobs: null,
  tools: null,
  purpose: null,
  mode: null,
};

/** The three numbered steps, in order. */
export const NUMBERED: OnboardingStep[] = ["workspace", "assistant", "first-docs"];

export function stepsFor(ctx: FlowContext): OnboardingStep[] {
  // A finished run with no workspace is somebody who left the one they had.
  if (ctx.completed && ctx.hasWorkspace === false) {
    return ctx.hasIncomingInvite ? ["invite-accept", "workspace"] : ["workspace"];
  }
  // An invitation to a team you are already in a workspace of ends the run.
  if (ctx.hasIncomingInvite && ctx.hasWorkspace !== false) return ["invite-accept"];
  return [...(ctx.hasIncomingInvite ? (["invite-accept"] as const) : []), ...NUMBERED];
}

function answered(step: OnboardingStep, ctx: FlowContext): boolean {
  switch (step) {
    case "invite-accept":
      return false;
    case "workspace":
      return (
        ctx.hasWorkspace !== false &&
        (ctx.completed === true || ctx.lastStep === "assistant" || ctx.lastStep === "first-docs")
      );
    case "assistant":
      return ctx.completed === true;
    case "first-docs":
      return false;
  }
}

/**
 * The step to show for what was asked for: the one asked, else the one the
 * run stopped on, else the first unanswered — never past one that has to be
 * answered first, and never the documents step without the agent it is for.
 */
export function resolveStep(requested: string | undefined, ctx: FlowContext): OnboardingStep {
  const steps = stepsFor(ctx).filter((s) => s !== "first-docs" || Boolean(ctx.agentId));
  const has = (s: string | null | undefined): s is OnboardingStep =>
    Boolean(s) && (steps as string[]).includes(s as string);

  const candidate: OnboardingStep = has(requested)
    ? requested
    : has(ctx.lastStep)
      ? ctx.lastStep
      : (steps.find((s) => !answered(s, ctx)) ?? steps[steps.length - 1]);

  const required: OnboardingStep[] = [];
  if (ctx.hasWorkspace === false) required.push("workspace");
  if (!ctx.completed) required.push("assistant");
  const open = required.find((s) => steps.includes(s) && !answered(s, ctx));
  if (open && steps.indexOf(candidate) > steps.indexOf(open)) return open;
  return candidate;
}

export function nextStep(current: OnboardingStep, ctx: FlowContext): OnboardingStep | "done" {
  const steps = stepsFor(ctx);
  const index = steps.indexOf(current);
  if (index === -1 || index === steps.length - 1) return "done";
  return steps[index + 1];
}

export function prevStep(current: OnboardingStep, ctx: FlowContext): OnboardingStep | null {
  // Nothing goes back past the agent once it exists: it is edited in its
  // Configuration from then on.
  if (current === "first-docs") return null;
  const steps = stepsFor(ctx);
  const index = steps.indexOf(current);
  return index > 0 ? steps[index - 1] : null;
}

/** "Step 2 of 3", or null for a step outside the three (the invitation). */
export function progressFor(step: OnboardingStep): { index: number; count: number } | null {
  const index = NUMBERED.indexOf(step);
  return index === -1 ? null : { index, count: NUMBERED.length };
}
