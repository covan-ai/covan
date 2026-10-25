/**
 * The first run (A14, A29), as a pure function of what is known: name the
 * workspace, set up the first agent, connect where work arrives, give it its
 * first documents, and — once a scan of that mailbox exists (0139) — see what
 * arrived; with an invitation in front of them when one is waiting.
 *
 * The agent is made when its step is left (`finish_onboarding`, 0119/0137),
 * so every step after it belongs to a run that has already finished: each is
 * reached only with the agent's id in hand, and leaving the last — either
 * way — is leaving the run.
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

export type OnboardingStep =
  | "invite-accept"
  | "workspace"
  | "assistant"
  | "connect"
  | "first-docs"
  | "arrivals";

export type FlowContext = {
  answers: OnboardingAnswers;
  lastStep: string | null;
  hasIncomingInvite: boolean;
  hasWorkspace?: boolean;
  completed?: boolean;
  /** The agent the run made, once it has. */
  agentId?: string | null;
  /** A scan of what arrived exists for this person (0139). */
  hasScan?: boolean;
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

/** The numbered steps, in order; `arrivals` only once there is a scan. */
export const NUMBERED: OnboardingStep[] = [
  "workspace",
  "assistant",
  "connect",
  "first-docs",
  "arrivals",
];

/** The steps that belong to the agent the run made. */
const AFTER_THE_AGENT: OnboardingStep[] = ["connect", "first-docs", "arrivals"];

function numbered(ctx: FlowContext): OnboardingStep[] {
  return NUMBERED.filter((s) => s !== "arrivals" || ctx.hasScan === true);
}

export function stepsFor(ctx: FlowContext): OnboardingStep[] {
  // A finished run with no workspace is somebody who left the one they had.
  if (ctx.completed && ctx.hasWorkspace === false) {
    return ctx.hasIncomingInvite ? ["invite-accept", "workspace"] : ["workspace"];
  }
  // An invitation to a team you are already in a workspace of ends the run.
  if (ctx.hasIncomingInvite && ctx.hasWorkspace !== false) return ["invite-accept"];
  return [...(ctx.hasIncomingInvite ? (["invite-accept"] as const) : []), ...numbered(ctx)];
}

function answered(step: OnboardingStep, ctx: FlowContext): boolean {
  switch (step) {
    case "invite-accept":
      return false;
    case "workspace":
      return (
        ctx.hasWorkspace !== false &&
        (ctx.completed === true ||
          ctx.lastStep === "assistant" ||
          AFTER_THE_AGENT.includes(ctx.lastStep as OnboardingStep))
      );
    case "assistant":
      return ctx.completed === true;
    case "connect":
    case "first-docs":
    case "arrivals":
      return false;
  }
}

/**
 * The step to show for what was asked for: the one asked, else the one the
 * run stopped on, else the first unanswered — never past one that has to be
 * answered first, and never the documents step without the agent it is for.
 */
export function resolveStep(requested: string | undefined, ctx: FlowContext): OnboardingStep {
  const steps = stepsFor(ctx).filter((s) => !AFTER_THE_AGENT.includes(s) || Boolean(ctx.agentId));
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
  if (AFTER_THE_AGENT.includes(current)) return null;
  const steps = stepsFor(ctx);
  const index = steps.indexOf(current);
  return index > 0 ? steps[index - 1] : null;
}

/** "Step 2 of 4", or null for a step outside the numbered ones (the invitation). */
export function progressFor(
  step: OnboardingStep,
  ctx: FlowContext,
): { index: number; count: number } | null {
  const steps = numbered(ctx);
  const index = steps.indexOf(step);
  return index === -1 ? null : { index, count: steps.length };
}
