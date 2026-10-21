import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Me, type OnboardingState } from "@/lib/api-client";
import {
  EMPTY_ANSWERS,
  endOf,
  firstPersonaliseStep,
  isIntroStep,
  nextStep,
  prevStep,
  progressFor,
  resolveStep,
  type AnswerPatch,
  type FlowContext,
  type OnboardingAnswers,
  type OnboardingStep,
} from "@/lib/onboarding-flow";
import {
  CTA,
  INTRO,
  MODES,
  PURPOSES,
  STEPS,
  templateFor,
  type ModeId,
  type PurposeId,
} from "@/lib/onboarding-config";
import { flushEvents, installUnloadFlush, trackStep } from "@/lib/analytics";
import { markKickoff } from "@/lib/chat-kickoff";
import { WelcomeLayout, type BarAction } from "@/components/welcome/welcome-layout";
import { IntroStep } from "@/components/welcome/intro-step";
import { AssistantStep } from "@/components/welcome/assistant-step";
import { ToolsStep } from "@/components/welcome/tools-step";
import { ChoiceCards } from "@/components/welcome/choice-cards";
import { TeamStep } from "@/components/welcome/team-step";
import { WorkspaceStep } from "@/components/welcome/workspace-step";
import { InviteAcceptStep } from "@/components/welcome/invite-accept-step";

export const Route = createFileRoute("/_authed/welcome")({
  component: Welcome,
  // The step is a hint, not an instruction: resolveStep decides what is
  // actually shown, so anything typed here is harmless.
  validateSearch: (search: Record<string, unknown>): { step?: string } => ({
    step: typeof search.step === "string" ? search.step : undefined,
  }),
  head: () => ({ meta: [{ title: "Welcome · Covan" }] }),
});

/** The one form on screen, which the bar's primary button submits. */
const FORM_ID = "welcome-step";

/**
 * The first run: show the product, ask a little, then let the assistant open.
 *
 * Three parts. The intro screens ask nothing. The personalise steps each
 * record their answer the moment it is given — optimistically into the `me`
 * cache, then with one PATCH that also carries the step it led to — so a
 * reload lands on the screen that was open. The end makes the assistant and
 * the conversation it opens in (`POST /onboarding/finish`, once) and hands
 * off to the chat screen with a flag that opens the conversation.
 *
 * What is NOT here: anything that creates a row before the end. The old run
 * made the agent on the step that asked for it, and a reload of that step
 * made a second one. Now the row that matters is made by one idempotent call
 * at the finish, from what the steps recorded.
 */
function Welcome() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: me, isError: meFailed } = useQuery({
    queryKey: ["me"],
    queryFn: () => api.me(),
  });
  // An account with no workspace yet (0115) has no /me, but its answers are
  // its own regardless — so they are read on their own, and only then.
  const noWorkspace = me === null;
  const { data: ownOnboarding, isPending: ownOnboardingPending } = useQuery({
    queryKey: ["onboarding"],
    queryFn: () => api.onboarding.get(),
    enabled: noWorkspace,
  });
  const { data: incoming = [] } = useQuery({
    queryKey: ["invitations", "incoming"],
    queryFn: () => api.invitations.incoming(),
  });

  // Somebody with no workspace who turned the invitation down to start their
  // own. Once that workspace exists the invitation is still pending — the
  // banner in the app keeps offering it — but this run is past it. Kept for
  // the tab, so a reload mid-setup does not ask either.
  const [declinedInvite, setDeclinedInvite] = useState(readDeclined);

  const { step: requested } = Route.useSearch();

  const state: OnboardingState | undefined = noWorkspace ? ownOnboarding : me?.onboarding;
  const completed = state?.completed ?? false;

  // Set the moment the finish starts. The finish marks the run complete, and
  // the redirect below would otherwise race the navigation to the chat.
  const finishing = useRef(false);
  const [ending, setEnding] = useState(false);

  // Someone who has already finished has no business here — this is the other
  // half of the gate in _authed.tsx. Only with a workspace, though: somebody
  // who finished once and has none now is exactly who this page is for.
  useEffect(() => {
    if (completed && !noWorkspace && !finishing.current) {
      void navigate({ to: "/app", replace: true });
    }
  }, [completed, noWorkspace, navigate]);

  const answers: OnboardingAnswers = state?.answers ?? EMPTY_ANSWERS;
  const ctx = useMemo<FlowContext>(
    () => ({
      answers,
      lastStep: state?.lastStep ?? null,
      hasIncomingInvite: incoming.length > 0 && !declinedInvite,
      hasWorkspace: !noWorkspace,
      completed,
    }),
    [answers, state?.lastStep, incoming.length, declinedInvite, noWorkspace, completed],
  );

  // Wait for the facts that change the shape of the run. Rendering before they
  // land would show a screen and then take it away. A failed /me stops the
  // wait rather than extending it — the same rule _authed.tsx applies.
  const ready = (me !== undefined || meFailed) && (!noWorkspace || !ownOnboardingPending);
  const step: OnboardingStep | null = ready ? resolveStep(requested, ctx) : null;

  // ---- what happened, for our own table ----------------------------------------
  useEffect(() => installUnloadFlush(), []);
  const viewed = useRef<string | null>(null);
  useEffect(() => {
    if (!step || viewed.current === step) return;
    viewed.current = step;
    trackStep(step, "viewed");
  }, [step]);

  // ---- recording and moving ----------------------------------------------------

  // Every PATCH in flight. The finish waits for them: it creates the agent
  // from what the row says, and the row has to say it first.
  const pending = useRef<Promise<unknown>[]>([]);

  const record = (patch: AnswerPatch) => {
    const { lastStep, ...rest } = patch;
    const merged: OnboardingAnswers = { ...answers, ...rest } as OnboardingAnswers;
    const update = (prev: OnboardingState | undefined) =>
      prev ? { ...prev, lastStep: lastStep ?? prev.lastStep, answers: merged } : prev;
    // Written into the caches directly rather than by refetching: the tap has
    // to advance the screen now, and waiting on a round trip to redraw a card
    // the person has already left would be a stutter for nothing.
    queryClient.setQueryData(["me"], (prev: Me | null | undefined) =>
      prev ? { ...prev, onboarding: update(prev.onboarding) ?? prev.onboarding } : prev,
    );
    queryClient.setQueryData(["onboarding"], update);
    pending.current.push(
      api.onboarding.update(patch).catch(() => {
        // An answer is a nicety, not a gate. Losing one to a flaky network must
        // not strand someone on a question they have already answered.
      }),
    );
  };

  const end = async (final: OnboardingAnswers) => {
    if (finishing.current) return;
    finishing.current = true;
    setEnding(true);
    await Promise.allSettled(pending.current);
    void flushEvents();

    if (endOf(ctx) === "finish") {
      try {
        const { agentId, sessionId } = await api.onboarding.finish({
          persona: templateFor(final).persona,
        });
        markKickoff(sessionId);
        await queryClient.invalidateQueries({ queryKey: ["me"] });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["agents"] }),
          queryClient.invalidateQueries({ queryKey: ["sessions"] }),
        ]);
        void navigate({
          to: "/agents/$agentId/chat",
          params: { agentId },
          search: { s: sessionId },
          replace: true,
        });
      } catch {
        toast.error("Couldn't set up your assistant. Try again.");
        finishing.current = false;
        setEnding(false);
      }
      return;
    }

    try {
      await api.onboarding.complete();
    } catch {
      // Nothing to show: they are on their way into the app, and the worst
      // case is meeting this screen once more.
    } finally {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      void navigate({ to: "/app", replace: true });
    }
  };

  /** Leave `step` for `next`, recording `patch` on the way. */
  const goTo = (
    next: OnboardingStep | "done",
    how: "completed" | "skipped",
    patch: AnswerPatch = {},
  ) => {
    if (!step) return;
    trackStep(step, how);
    const merged = { ...answers, ...patch } as OnboardingAnswers;
    if (next === "done") {
      if (Object.keys(patch).length > 0) record(patch);
      void end(merged);
      return;
    }
    record({ ...patch, lastStep: next });
    void flushEvents();
    void navigate({ to: "/welcome", search: { step: next }, replace: true });
  };

  /** Record an answer and move to whatever it leads to. */
  const answer = (patch: AnswerPatch, how: "completed" | "skipped" = "completed") => {
    if (!step) return;
    const merged = { ...answers, ...patch } as OnboardingAnswers;
    // Advanced against the merged answers, so "my team" reaches the team step
    // on the very tap that chose it.
    goTo(nextStep(step, { ...ctx, answers: merged }), how, patch);
  };

  const goBack = () => {
    if (!step) return;
    const back = prevStep(step, ctx);
    if (!back) return;
    record({ lastStep: back });
    void navigate({ to: "/welcome", search: { step: back }, replace: true });
  };

  // ---- what each step reports ----------------------------------------------------

  // Validity and busyness, by step, as the steps report them. Read with a
  // `?? true` so a step that reports nothing (the intro) is always passable.
  const [validity, setValidity] = useState<Record<string, boolean>>({});
  const [busyness, setBusyness] = useState<Record<string, boolean>>({});
  const reportValidity = useCallback(
    (s: string) => (valid: boolean) =>
      setValidity((prev) => (prev[s] === valid ? prev : { ...prev, [s]: valid })),
    [],
  );
  const reportBusy = useCallback(
    (s: string) => (busy: boolean) =>
      setBusyness((prev) => (prev[s] === busy ? prev : { ...prev, [s]: busy })),
    [],
  );
  // Stable per step, so the steps' effects do not re-run on every render.
  const onValidity = useMemo(
    () => (step ? reportValidity(step) : undefined),
    [step, reportValidity],
  );
  const onBusy = useMemo(() => (step ? reportBusy(step) : undefined), [step, reportBusy]);

  // The two single-choice screens hold their pick here: they have no form of
  // their own, and the bar's button is what commits the pick.
  const [purposePick, setPurposePick] = useState<PurposeId | null>(null);
  const [modePick, setModePick] = useState<ModeId | null>(null);
  const purpose = purposePick ?? (answers.purpose as PurposeId | null);
  const mode = modePick ?? answers.mode;

  if (!step || (completed && !noWorkspace && !ending)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  const progress = progressFor(step, ctx);
  const back: BarAction | null =
    prevStep(step, ctx) && !ending ? { label: CTA.back, onClick: goBack } : null;
  const valid = validity[step] ?? true;
  const busy = ending || (busyness[step] ?? false);

  // ---- the screens -----------------------------------------------------------------

  if (isIntroStep(step)) {
    const screen = INTRO.find((s) => `intro:${s.id}` === step) ?? INTRO[0];
    return (
      <WelcomeLayout
        progress={progress}
        stepKey={step}
        back={back}
        skip={{
          label: CTA.skipIntro,
          onClick: () => goTo(firstPersonaliseStep(ctx), "skipped"),
        }}
        primary={{ label: CTA.continue, onClick: () => goTo(nextStep(step, ctx), "completed") }}
      >
        <IntroStep screen={screen} />
      </WelcomeLayout>
    );
  }

  if (step === "invite-accept") {
    return (
      <WelcomeLayout
        progress={progress}
        stepKey={step}
        title="You've been invited"
        back={back}
        skip={{
          label: noWorkspace ? "Start my own workspace instead" : "Not now",
          onClick: () => {
            if (noWorkspace) {
              rememberDeclined();
              setDeclinedInvite(true);
            }
            goTo(nextStep(step, { ...ctx, hasIncomingInvite: false }), "skipped");
          },
        }}
        primary={null}
      >
        <InviteAcceptStep
          // Joining is the end of the run, whatever else this flow had planned.
          onJoined={() => goTo("done", "completed")}
          onSkip={() => goTo(nextStep(step, { ...ctx, hasIncomingInvite: false }), "skipped")}
        />
      </WelcomeLayout>
    );
  }

  if (step === "workspace") {
    return (
      <WelcomeLayout
        progress={progress}
        stepKey={step}
        title="Start your workspace"
        subtitle="Name it after your team or company."
        back={back}
        formId={FORM_ID}
        primary={{ label: busy ? "Saving…" : CTA.continue, disabled: !valid || busy }}
      >
        <WorkspaceStep
          formId={FORM_ID}
          currentName={null}
          onDone={() => goTo(nextStep(step, { ...ctx, hasWorkspace: true }), "completed")}
          onValidityChange={onValidity}
          onBusyChange={onBusy}
        />
      </WelcomeLayout>
    );
  }

  const config = STEPS.find((s) => s.id === step);
  const title = config?.title;
  const subtitle = config?.subtitle;

  if (step === "assistant") {
    return (
      <WelcomeLayout
        progress={progress}
        stepKey={step}
        title={title}
        subtitle={subtitle}
        back={back}
        formId={FORM_ID}
        primary={{ label: CTA.continue, disabled: !valid || busy }}
      >
        <AssistantStep
          formId={FORM_ID}
          firstName={firstName(me?.user.name)}
          value={answers}
          onSubmit={(a) => answer(a)}
          onValidityChange={onValidity}
        />
      </WelcomeLayout>
    );
  }

  if (step === "tools") {
    return (
      <WelcomeLayout
        progress={progress}
        stepKey={step}
        title={title}
        subtitle={subtitle}
        back={back}
        formId={FORM_ID}
        skip={
          config?.skip
            ? { label: config.skip, onClick: () => answer({ tools: [] }, "skipped") }
            : null
        }
        primary={{ label: CTA.continue, disabled: !valid || busy }}
      >
        <ToolsStep
          formId={FORM_ID}
          value={answers.tools}
          onSubmit={(tools) => answer({ tools })}
          onValidityChange={onValidity}
        />
      </WelcomeLayout>
    );
  }

  if (step === "purpose") {
    return (
      <WelcomeLayout
        progress={progress}
        stepKey={step}
        title={title}
        subtitle={subtitle}
        back={back}
        primary={{
          label: CTA.continue,
          disabled: !purpose || busy,
          onClick: () => purpose && answer({ purpose }),
        }}
      >
        <ChoiceCards
          name={title ?? "Purpose"}
          options={PURPOSES}
          value={purpose}
          onChange={setPurposePick}
          onEnter={(id) => answer({ purpose: id })}
        />
      </WelcomeLayout>
    );
  }

  if (step === "mode") {
    // "Just me" ends the run here; "my team" has one more screen. The button
    // says which, so the reward is promised on the tap that earns it.
    const after = mode ? nextStep(step, { ...ctx, answers: { ...answers, mode } }) : null;
    const finishes = after === "done";
    return (
      <WelcomeLayout
        progress={progress}
        stepKey={step}
        title={title}
        subtitle={subtitle}
        back={back}
        primary={{
          label: ending ? CTA.finishing : finishes ? CTA.finish : CTA.continue,
          disabled: !mode || busy,
          onClick: () => mode && answer({ mode }),
        }}
      >
        <ChoiceCards
          name={title ?? "Mode"}
          options={MODES}
          value={mode}
          onChange={setModePick}
          onEnter={(id) => answer({ mode: id })}
        />
      </WelcomeLayout>
    );
  }

  // step === "team"
  return (
    <WelcomeLayout
      progress={progress}
      stepKey={step}
      title={title}
      subtitle={subtitle}
      back={back}
      formId={FORM_ID}
      primary={{ label: ending ? CTA.finishing : CTA.finish, disabled: !valid || busy }}
    >
      <TeamStep
        formId={FORM_ID}
        currentName={me?.workspace.name ?? null}
        onDone={() => goTo("done", "completed")}
        onValidityChange={onValidity}
        onBusyChange={onBusy}
      />
    </WelcomeLayout>
  );
}

function firstName(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.trim().split(/\s+/)[0] || null;
}

const DECLINED_KEY = "covan:welcome:declined-invite";

function readDeclined(): boolean {
  try {
    return sessionStorage.getItem(DECLINED_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDeclined(): void {
  try {
    sessionStorage.setItem(DECLINED_KEY, "1");
  } catch {
    // Private mode or blocked storage: the state above still covers this run.
  }
}
