/**
 * Which screen the first run shows next.
 *
 * Kept free of React so the branching can be tested without rendering
 * anything — the same reason cron-to-prose.ts and schedule-form.ts exist. Every
 * question this module answers is a pure function of four facts: what has been
 * answered, whether this is a hosted install, whether the account is holding an
 * invitation, and whether an agent exists to hang documents on.
 */

export type OnboardingStep =
  | "role"
  | "use"
  | "team"
  | "source"
  | "workspace"
  | "agent"
  | "knowledge"
  | "invite"
  | "invite-accept";

export type OnboardingAnswers = {
  role: string | null;
  useCase: string | null;
  teamSize: string | null;
  referralSource: string | null;
};

/**
 * One or more answers being recorded. Not `Partial<OnboardingAnswers>`: that
 * would admit `null`, and clearing an answer is not something the flow does —
 * every tap sets a real id. The API refuses null too, so this keeps the two
 * ends agreeing.
 */
export type AnswerPatch = Partial<Record<keyof OnboardingAnswers, string>>;

export type FlowContext = {
  answers: OnboardingAnswers;
  /** A self-hosted install has nowhere to send a referral answer, so it is not asked. */
  hosted: boolean;
  /**
   * The signup trigger gives every new account its own workspace, invitees
   * included, so `workspaces.created_by` cannot tell them apart. A pending
   * invitation can.
   */
  hasIncomingInvite: boolean;
  /**
   * Whether there is an agent to attach documents to.
   *
   * The knowledge step asks for a file and puts it in a bundle attached to an
   * agent, so it is meaningless before one exists — and "I'll do this later" on
   * the agent step is a real answer, not a detour. Read from the agents store
   * rather than held in component state, so a reload mid-flow resumes correctly.
   */
  hasAgent: boolean;
};

/**
 * The three that must be answered before anything else happens. `source` is
 * deliberately not among them: it is optional, so treating it as a prerequisite
 * would strand anyone who skipped it.
 */
const REQUIRED: ReadonlyArray<{ step: OnboardingStep; answer: keyof OnboardingAnswers }> = [
  { step: "role", answer: "role" },
  { step: "use", answer: "useCase" },
  { step: "team", answer: "teamSize" },
];

/** The steps this particular first run consists of, in order. */
export function stepsFor(ctx: FlowContext): OnboardingStep[] {
  const survey: OnboardingStep[] = ["role", "use", "team"];
  if (ctx.hosted) survey.push("source");

  if (ctx.hasIncomingInvite) return [...survey, "invite-accept"];

  const setup: OnboardingStep[] = ["workspace", "agent"];
  // Only once there is somewhere to put a document. The count this changes is
  // already not fixed — answering "just me" drops the invite step the same way.
  if (ctx.hasAgent) setup.push("knowledge");
  if (ctx.answers.teamSize !== "solo") setup.push("invite");
  return [...survey, ...setup];
}

/** Where the flow goes once the survey is behind us. */
function firstSetupStep(ctx: FlowContext): OnboardingStep {
  return ctx.hasIncomingInvite ? "invite-accept" : "workspace";
}

/**
 * The step to actually show, given whatever the URL asked for.
 *
 * An unanswered prerequisite beats any request, which is what makes a
 * hand-edited `?step=` harmless and a half-finished run resumable — one rule
 * covering both.
 */
export function resolveStep(requested: string | undefined, ctx: FlowContext): OnboardingStep {
  const missing = REQUIRED.find(({ answer }) => !ctx.answers[answer]);
  if (missing) return missing.step;

  const steps = stepsFor(ctx);
  if (requested && (steps as string[]).includes(requested)) {
    return requested as OnboardingStep;
  }

  // No usable request. Resume at setup rather than at `source`: the referral
  // question is optional, and one that was skipped should stay skipped.
  return firstSetupStep(ctx);
}

/**
 * The agent the knowledge step hangs its documents on.
 *
 * "The one just created" is what this means, and the newest is how it is found
 * rather than by remembering an id in component state — state does not survive
 * the reload that `?step=knowledge` is otherwise perfectly able to resume from.
 * The two only disagree in a workspace that already had agents, and the
 * invitee branch is the only way to reach this flow in one of those, which
 * excludes the knowledge step entirely.
 *
 * Generic over the shape so this module stays free of React and of the store's
 * types, the same reason the rest of it is.
 */
export function newestAgent<T extends { createdAt: number }>(agents: readonly T[]): T | null {
  let newest: T | null = null;
  for (const agent of agents) {
    if (!newest || agent.createdAt > newest.createdAt) newest = agent;
  }
  return newest;
}

/** The step after this one, or "done" when the first run is over. */
export function nextStep(current: OnboardingStep, ctx: FlowContext): OnboardingStep | "done" {
  const steps = stepsFor(ctx);
  const index = steps.indexOf(current);
  if (index === -1 || index === steps.length - 1) return "done";
  return steps[index + 1];
}
