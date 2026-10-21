import {
  INTRO,
  SECTIONS,
  STEPS,
  type PersonaliseStepId,
  type SectionId,
} from "./onboarding-config";

/**
 * Which screen the first run shows next.
 *
 * Kept free of React so the branching can be tested without rendering
 * anything. Every question this module answers is a pure function of what has
 * been answered, which screen was open last, whether the account is holding an
 * invitation, and whether it has a workspace to put an assistant in.
 *
 * The screens themselves come from `onboarding-config.ts`: the intro screens
 * in their order, then the personalise steps in theirs, each with a `when`
 * that can take it out of a particular run. This module decides where in that
 * list a person is; it does not know what any screen contains.
 */

export type OnboardingAnswers = {
  assistantName: string | null;
  assistantEmoji: string | null;
  /** A ready-made role's id, `default`, or `custom`. */
  assistantRole: string | null;
  /** `null` until the question is reached; `[]` once it was skipped. */
  tools: string[] | null;
  purpose: string | null;
  mode: "solo" | "team" | null;
};

/**
 * One or more answers being recorded. Not `Partial<OnboardingAnswers>`: that
 * would admit `null`, and clearing an answer is not something the flow does —
 * every tap sets a real value. The API refuses null too, so this keeps the two
 * ends agreeing. `lastStep` rides along so one request records both the
 * answer and the screen it led to.
 */
export type AnswerPatch = Partial<{
  assistantName: string;
  assistantEmoji: string;
  assistantRole: string;
  tools: string[];
  purpose: string;
  mode: "solo" | "team";
  lastStep: string;
}>;

export type IntroStepId = `intro:${string}`;

export type OnboardingStep = IntroStepId | PersonaliseStepId | "workspace" | "invite-accept";

export type FlowContext = {
  answers: OnboardingAnswers;
  /** The screen that was open when the person last left, as the API recorded it. */
  lastStep: string | null;
  /**
   * The signup trigger gives every new account its own workspace, invitees
   * included, so `workspaces.created_by` cannot tell them apart. A pending
   * invitation can.
   */
  hasIncomingInvite: boolean;
  /**
   * Whether the account has a workspace yet. Absent means yes, which is every
   * account the signup trigger made one for.
   *
   * An account that signed up with an invitation waiting has none (0115): the
   * invitation is its way in. If it declines, or the invitation lapsed before
   * it arrived, the setup steps follow and `workspace` starts one.
   */
  hasWorkspace?: boolean;
  /**
   * Finished once already. Only matters together with `hasWorkspace: false`:
   * somebody who left their last workspace is here for a new one, not for the
   * whole run again.
   */
  completed?: boolean;
};

export const EMPTY_ANSWERS: OnboardingAnswers = {
  assistantName: null,
  assistantEmoji: null,
  assistantRole: null,
  tools: null,
  purpose: null,
  mode: null,
};

export function isIntroStep(step: string): step is IntroStepId {
  return step.startsWith("intro:");
}

export function introSteps(): IntroStepId[] {
  return INTRO.map((s) => `intro:${s.id}` as const);
}

export function personaliseSteps(answers: OnboardingAnswers): PersonaliseStepId[] {
  return STEPS.filter((s) => !s.when || s.when(answers)).map((s) => s.id);
}

/** The steps this particular first run consists of, in order. */
export function stepsFor(ctx: FlowContext): OnboardingStep[] {
  // Somebody who finished once and has no workspace now — they left their
  // last one, or an invitation lapsed — is here for a workspace and nothing
  // else. The assistant they named lives in the workspace they left.
  if (ctx.completed && ctx.hasWorkspace === false) {
    return ctx.hasIncomingInvite ? ["invite-accept", "workspace"] : ["workspace"];
  }

  const intro = introSteps();
  const setup: OnboardingStep[] = [
    ...(ctx.hasWorkspace === false ? (["workspace"] as const) : []),
    ...personaliseSteps(ctx.answers),
  ];

  if (ctx.hasIncomingInvite) {
    // Accepting ends the run either way: the workspace they join has its own
    // assistants. Somebody with no workspace who says "not now" still needs
    // one, so setup follows for them; somebody who has one already is done.
    return ctx.hasWorkspace === false
      ? [...intro, "invite-accept", ...setup]
      : [...intro, "invite-accept"];
  }
  return [...intro, ...setup];
}

/**
 * The steps a cold return must not skip past, whatever the URL asks for. The
 * assistant's name is what the finish creates the agent from (0119), and a
 * workspace is where it goes.
 */
function required(ctx: FlowContext): OnboardingStep[] {
  const steps: OnboardingStep[] = [];
  if (ctx.hasWorkspace === false) steps.push("workspace");
  if (!ctx.completed) steps.push("assistant");
  return steps;
}

function answered(step: OnboardingStep, ctx: FlowContext): boolean {
  if (isIntroStep(step)) {
    // The intro is behind somebody once they have been anywhere past it:
    // their last screen was a later one, or they have answered something,
    // which can only have happened on a later one.
    return (
      (ctx.lastStep !== null && !isIntroStep(ctx.lastStep)) || ctx.answers.assistantName !== null
    );
  }
  if (step === "workspace") return ctx.hasWorkspace !== false;
  // An invitation is answered by accepting or declining it, both of which
  // take it out of `stepsFor`; while it is in the list it is open.
  if (step === "invite-accept") return false;
  const config = STEPS.find((s) => s.id === step);
  return config ? config.answered(ctx.answers) : false;
}

/**
 * The step to actually show, given whatever the URL asked for.
 *
 * The request wins, then the screen the person was on when they left, then the
 * first step nothing has answered — unless that lands past a required step
 * that is still open, in which case the required step wins. That is what
 * makes a hand-edited `?step=` harmless without making the intro unreachable:
 * a fresh run still starts on its first screen, and only a jump *over* the
 * assistant's name is pulled back to it.
 *
 * `lastStep` is why a reload lands on the screen that was open rather than on
 * the first unanswered question: the intro screens answer nothing, and without
 * it every reload during the intro would start the intro over.
 */
export function resolveStep(requested: string | undefined, ctx: FlowContext): OnboardingStep {
  const steps = stepsFor(ctx);
  const has = (s: string | null | undefined): s is OnboardingStep =>
    Boolean(s) && (steps as string[]).includes(s as string);

  const candidate: OnboardingStep = has(requested)
    ? requested
    : has(ctx.lastStep)
      ? ctx.lastStep
      : (steps.find((s) => !answered(s, ctx)) ?? steps[steps.length - 1]);

  const open = required(ctx).find((s) => steps.includes(s) && !answered(s, ctx));
  if (open && steps.indexOf(candidate) > steps.indexOf(open)) return open;
  return candidate;
}

/** The step after this one, or "done" when the first run is over. */
export function nextStep(current: OnboardingStep, ctx: FlowContext): OnboardingStep | "done" {
  const steps = stepsFor(ctx);
  const index = steps.indexOf(current);
  if (index === -1 || index === steps.length - 1) return "done";
  return steps[index + 1];
}

/** The step before this one, or null on the first. */
export function prevStep(current: OnboardingStep, ctx: FlowContext): OnboardingStep | null {
  const steps = stepsFor(ctx);
  const index = steps.indexOf(current);
  return index > 0 ? steps[index - 1] : null;
}

/** Where "Skip intro" goes: the first screen that is not an intro screen. */
export function firstPersonaliseStep(ctx: FlowContext): OnboardingStep | "done" {
  return stepsFor(ctx).find((s) => !isIntroStep(s)) ?? "done";
}

/**
 * How the run ends. A run that named an assistant ends by making it — the
 * finish that creates the agent and the conversation it opens in. A run that
 * did not (an invitation accepted, a workspace started by somebody who had
 * finished before) just records that it is over.
 */
export function endOf(ctx: FlowContext): "finish" | "complete" {
  return stepsFor(ctx).includes("mode") ? "finish" : "complete";
}

export function sectionOf(step: OnboardingStep): SectionId {
  return isIntroStep(step) ? "meet" : "personalise";
}

export type DotState = "done" | "current" | "todo";

export type Progress = {
  /** Zero-based, over the whole run. For the progress bar's aria values. */
  index: number;
  count: number;
  sections: { id: SectionId; label: string; state: DotState; dots: DotState[] }[];
};

/**
 * The three labelled sections and the dots within each. "Start" is the
 * conversation after this screen and is never current here; it is listed so
 * the person can see there is one more thing, and that it is not a form.
 */
export function progressFor(step: OnboardingStep, ctx: FlowContext): Progress {
  const steps = stepsFor(ctx);
  const index = Math.max(0, steps.indexOf(step));
  const stateOf = (i: number): DotState => (i < index ? "done" : i === index ? "current" : "todo");

  const sections = SECTIONS.map((section) => {
    if (section.id === "start") return { ...section, state: "todo" as const, dots: [] };
    const own = steps.map((s, i) => ({ s, i })).filter(({ s }) => sectionOf(s) === section.id);
    const dots = own.map(({ i }) => stateOf(i));
    const state: DotState = dots.includes("current")
      ? "current"
      : dots.length > 0 && dots.every((d) => d === "done")
        ? "done"
        : "todo";
    return { ...section, state, dots };
  });

  return { index, count: steps.length, sections };
}
