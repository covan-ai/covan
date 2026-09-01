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
  // Only once there is somewhere to put a document.
  if (ctx.hasAgent) setup.push("knowledge");
  if (ctx.answers.teamSize !== "solo") setup.push("invite");
  return [...survey, ...setup];
}

/**
 * The same run, as long as it can turn out to be. What the progress indicator
 * counts.
 *
 * `stepsFor` answers "where does this go next", and `hasAgent` belongs in that
 * answer: there is nowhere to put a document until an agent exists. It does not
 * belong in "how long is this", and using one list for both jobs is what made
 * the dots grow. Walked in a browser on 2026-08-31: the agent step read
 * **Step 6 of 7**, and creating the agent — the most work anyone does in the
 * whole flow — made it **Step 7 of 8**. The finish line moved away at the
 * moment it should have come closer.
 *
 * So the count assumes the agent will exist, because from any point at or
 * before the agent step that is the ordinary outcome. Someone who taps "I'll do
 * this later" then ends one short of the total, which is the honest shape of
 * having skipped a step and is nothing like a step appearing out of nowhere.
 *
 * `teamSize` is deliberately still allowed to shorten it. That one is a
 * question the person just answered, and a flow that gets shorter when you say
 * you are working alone is legible in a way that a step arriving after you
 * finished one is not.
 */
export function plannedStepsFor(ctx: FlowContext): OnboardingStep[] {
  return stepsFor({ ...ctx, hasAgent: true });
}

/**
 * Where the flow goes once the survey is behind us.
 *
 * The survey resumes on its answers. Setup has only one answer of that kind:
 * an agent either exists or it does not, and nothing else in setup leaves a
 * row behind — a workspace is created by the signup trigger whether or not
 * anybody named it, and a skipped document step is indistinguishable from an
 * unvisited one. So `hasAgent` is the whole of what a cold return can know.
 *
 * Before this asked, and returned `workspace` unconditionally: a reload with
 * no `?step=` walked somebody back through naming their workspace and creating
 * their first agent, both of which they had already done. The second one is
 * not idempotent, so they got a second agent with the same persona. Walked in
 * a browser on 2026-08-31 and it happened on the first reload.
 */
function resumeStep(ctx: FlowContext): OnboardingStep {
  if (ctx.hasIncomingInvite) return "invite-accept";
  if (!ctx.hasAgent) return "workspace";

  // `knowledge` exists exactly when an agent does — see `stepsFor` — so this
  // is never the fallback in practice. It is written as one anyway because the
  // alternative is asserting that here, and a wrong assertion in a resume path
  // strands somebody on a blank screen.
  const steps = stepsFor(ctx);
  return steps[steps.indexOf("agent") + 1] ?? "knowledge";
}

/**
 * The step to actually show, given whatever the URL asked for.
 *
 * An unanswered prerequisite beats any request, which is what makes a
 * hand-edited `?step=` harmless and a half-finished run resumable — one rule
 * covering both.
 *
 * A step that has already done its work beats a request too, and there is
 * exactly one of those. Every other step can be shown twice with no
 * consequence — renaming a workspace, adding another document, sending
 * invitations again — while `agent` creates something each time it is
 * submitted. The back button asks for `?step=agent` by name, so leaving it
 * requestable would have kept the duplicate a click away after the resume
 * above was fixed.
 */
export function resolveStep(requested: string | undefined, ctx: FlowContext): OnboardingStep {
  const missing = REQUIRED.find(({ answer }) => !ctx.answers[answer]);
  if (missing) return missing.step;

  const steps = stepsFor(ctx);
  const spent = requested === "agent" && ctx.hasAgent;
  if (requested && !spent && (steps as string[]).includes(requested)) {
    return requested as OnboardingStep;
  }

  // No usable request. Resume at setup rather than at `source`: the referral
  // question is optional, and one that was skipped should stay skipped.
  return resumeStep(ctx);
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
